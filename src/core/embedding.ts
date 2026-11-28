import type {Platform} from '../platform/types.ts';
import type {CloudflareCredentials, Failure} from './types.ts';
import type {EmbeddingService, EmbeddingResult, VectorMap} from './services.ts';
import type {Cache} from './cache.ts';
import type {SettingsService} from './settings.ts';
import type {Packs} from './packs.ts';
import type {Images} from './images.ts';
import type {Events} from './events.ts';
import {embeddingWorker} from './workers.ts';
import {CLOUDFLARE_EMBEDDING_SPEC, CLOUDFLARE_KEYS_NEEDED, CLOUDFLARE_SETUP_HINT, CLOUDFLARE_BATCH_ITEMS, CLOUDFLARE_BODY_LIMIT, CLOUDFLARE_CONCURRENCY,
  CloudflareEmbeddingError, createCloudflareEmbedding, normalizeCloudflareCredentials, prepareCloudflareImage, untilAborted,
  type CloudflareImage} from './embedding-cloudflare.ts';
export const EMBEDDING_SPEC = "q4-image280-video6x140-v3";
// These revisions share the same normalized 768-dimensional embedding space.
const COMPATIBLE_SPECS = [EMBEDDING_SPEC, "q8-image560-video6x280-v2", "q8-560-gif3-browser-v1"];
export function readEmbeddingVectors(saved: {spec?: string; vectors?: Record<string, unknown>} | undefined,
  specs = COMPATIBLE_SPECS): VectorMap {
  if (!specs.includes(saved?.spec!) || !saved?.vectors) return {};
  return Object.fromEntries(Object.entries(saved.vectors).filter(([key, vector]) =>
    (saved.spec !== "q8-560-gif3-browser-v1" || !key.endsWith(":gif")) && Array.isArray(vector) &&
    vector.length === 768 && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < 0.001)) as VectorMap;
}

export function createEmbedding(platform: Platform, settings: SettingsService, cache: Cache, packs: Packs, images: Images, PluginEvents: Events) {
  const {loadData, saveData} = settings;
  const {cacheFiles, cachePath, legacyCachePath, readCacheFile, writeCacheFile} = cache;
  const {pickerPacks} = packs;
  const cloudflare = createCloudflareEmbedding({fetch: (url, options) => platform.net.fetch(url, options)}, async signal => {
    // The channel is asynchronous and isolated between some desktop profiles.
    // Consult the shared store before using any credentials, even for a draft test.
    let changed;
    try {changed = await settings.refreshEmbeddingSettings();}
    catch {throw new CloudflareEmbeddingError('공통 설정을 확인하지 못했습니다.');}
    signal?.throwIfAborted();
    if (changed || !Embedding.enabled() || Embedding.provider() !== 'cloudflare')
      throw new CloudflareEmbeddingError('Cloudflare 설정이 변경되었습니다.');
  });
  let cloudFailure: CloudflareEmbeddingError | undefined, searchController: AbortController | undefined;
  let cloudIndexController: AbortController | undefined;
  const readCredentials = () => loadData('embeddingCloudflareCredentials');
  function resolveCredentials(draft: CloudflareCredentials) {
    if (!Embedding.enabled() || Embedding.provider() !== 'cloudflare') throw new CloudflareEmbeddingError('먼저 Cloudflare 의미 기반 검색을 켜 주세요.');
    const saved = readCredentials();
    return normalizeCloudflareCredentials({accountId: draft.accountId.trim() || saved?.accountId || '',
      apiToken: draft.apiToken.trim() || saved?.apiToken || ''});
  }
  function haltCloudflare(error: CloudflareEmbeddingError) {
    if (cloudFailure) return;
    cloudFailure = error;
    Embedding.ready = false; Embedding.reindex = false;
    cloudIndexController?.abort(error);
    cloudflare.stop();
    // An active index publishes its terminal phase after draining the checkpoint.
    if (!Embedding.indexing) Embedding.update({phase: '오류', file: '', error: error.message});
  }
  const Embedding: EmbeddingService = {
    worker: null, generation: 0, sequence: 0, pending: new Map(), vectors: {}, dirtyVectors: 0, urls: [],
    assetRequests: new Map(), downloads: new Set(), searchSequence: 0, searchWork: Promise.resolve(),
    legacyVectors: {}, pendingVectorKeys: new Set(),
    status: {phase: "꺼짐", completed: 0, total: 0, errors: 0},
    enabled() {return loadData("embeddingEnabled", false) === true;},
    provider() {return loadData('embeddingProvider', 'local') === 'cloudflare' ? 'cloudflare' : 'local';},
    setProvider(provider) {
      if (provider === this.provider()) return;
      saveData('embeddingProvider', provider);
      this.stop(); this.start();
    },
    hasCloudflareCredentials() {
      if (!this.enabled() || this.provider() !== 'cloudflare') return false;
      try {normalizeCloudflareCredentials(readCredentials()); return true;} catch {return false;}
    },
    async saveCloudflareCredentials(draft) {
      if (!this.enabled() || this.provider() !== 'cloudflare') throw new CloudflareEmbeddingError('먼저 Cloudflare 의미 기반 검색을 켜 주세요.');
      if (!draft.accountId.trim() && !draft.apiToken.trim() && this.hasCloudflareCredentials()) return;
      await settings.refreshEmbeddingSettings().catch(() => {});
      const credentials = resolveCredentials(draft);
      this.stop();
      const generation = this.generation;
      try {
        const saved = saveData('embeddingCloudflareCredentials', credentials);
        this.update({}); // Surface the new credential revision before the save settles.
        await saved;
      } catch {
        this.update({});
        throw new CloudflareEmbeddingError('Cloudflare API 키를 저장하지 못했습니다.');
      }
      if (generation !== this.generation) return;
      if (!this.hasCloudflareCredentials()) throw new CloudflareEmbeddingError('Cloudflare API 키를 저장하지 못했습니다.');
      this.start();
    },
    async testCloudflareCredentials(draft, signal) {await cloudflare.test(resolveCredentials(draft), signal);},
    getCloudflareUsageRevision: settings.getEmbeddingRevision,
    async getCloudflareUsage(signal) {
      if (!this.hasCloudflareCredentials()) return null;
      const revision = this.getCloudflareUsageRevision();
      const usage = await cloudflare.fetchUsage(readCredentials()!, signal);
      return !signal?.aborted && revision === this.getCloudflareUsageRevision() ? usage : null;
    },
    key(con) {return con.path + ":" + con.ext;},
    update(changes) {
      Object.assign(this.status, changes);
      PluginEvents.dispatch({type: "DCCON_EMBEDDING_UPDATE"});
    },
    files() {return cacheFiles();},
    directory() {return cachePath("models");},
    vectorDirectory() {return cachePath('vectors', this.provider() === 'cloudflare' ? CLOUDFLARE_EMBEDDING_SPEC : EMBEDDING_SPEC);},
    vectorFile(key) {
      return platform.paths.join(this.vectorDirectory(), platform.sha256(key) + ".json");
    },
    async download(url, generation) {
      // BetterDiscord's automatic redirect handler cannot resolve relative Location headers.
      for (let redirects = 0; redirects <= 8; redirects++) {
        if (generation !== this.generation) throw Error("임베딩 중단됨");
        const controller = new AbortController();
        this.downloads.add(controller);
        let response;
        try {response = await platform.net.fetch(url, {responseType: "arraybuffer", redirect: "manual", signal: controller.signal});}
        finally {this.downloads.delete(controller);}
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers?.get?.("location");
        if (!location) throw Error("모델 다운로드 리다이렉트 주소가 없습니다.");
        const next = new URL(location, url);
        if (next.protocol !== "https:") throw Error("모델 다운로드는 HTTPS만 지원합니다.");
        url = next.href;
      }
      throw Error("모델 다운로드 리다이렉트 횟수를 초과했습니다.");
    },
    async asset(url, generation, expectedHash) {
      const key = `${generation}:${url}`;
      if (this.assetRequests.has(key)) return this.assetRequests.get(key)!;
      const request = this.readAsset(url, generation, expectedHash);
      this.assetRequests.set(key, request);
      try {return await request;} finally {this.assetRequests.delete(key);}
    },
    async readAsset(url, generation, expectedHash) {
      const fs = this.files(), hash = (bytes: string | Uint8Array) => platform.sha256(bytes);
      const file = platform.paths.join(this.directory(), hash(url));
      let bytes;
      try {bytes = await readCacheFile("models", hash(url), fs);} catch { /* Download on cache miss. */ }
      if (!bytes || typeof bytes === "string" || (expectedHash && hash(bytes) !== expectedHash)) {
        if (generation !== this.generation) throw Error("임베딩 중단됨");
        this.update({phase: "모델 다운로드", file: url.split("/").pop()});
        const response = await this.download(url, generation);
        if (response.status >= 400 || response.ok === false) throw Error(`모델 다운로드 실패 (${response.status}): ${url.split("/").pop()}`);
        bytes = new Uint8Array(await response.arrayBuffer());
        if (expectedHash && hash(bytes) !== expectedHash) throw Error("임베딩 런타임 무결성 확인 실패");
        if (generation !== this.generation) throw Error("임베딩 중단됨");
        await writeCacheFile(file, bytes, fs, () => {
          if (generation !== this.generation) throw Error("임베딩 중단됨");
        });
      }
      return new Uint8Array(bytes).buffer;
    },
    call(action, args = {}) {
      const worker = this.worker;
      if (!worker) return Promise.reject(Error("임베딩 모델이 준비되지 않았습니다."));
      return new Promise<EmbeddingResult>((resolve, reject) => {
        const id = ++this.sequence; this.pending.set(id, {resolve, reject});
        try {
          const transfer = [args.bytes, args.wasm].filter(value => value instanceof ArrayBuffer);
          worker.postMessage({id, action, ...args}, transfer);
        } catch (_error) { const error = _error as Failure;this.pending.delete(id); reject(error);}
      });
    },
    stop() {
      clearTimeout(this.startTimer!); this.startTimer = null; this.starting = false;
      this.generation++; this.cancelSearch();
      cloudIndexController?.abort(); cloudIndexController = undefined;
      cloudFailure = undefined; cloudflare.stop();
      for (const controller of this.downloads) controller.abort();
      this.downloads.clear();
      this.vectors = {};
      this.legacyVectors = {}; this.pendingVectorKeys = new Set();
      this.dirtyVectors = 0;
      this.worker?.terminate(); this.worker = null;
      for (const task of this.pending.values()) task.reject(Error("임베딩 중단됨"));
      this.pending.clear(); this.urls.forEach(url => URL.revokeObjectURL(url)); this.urls = [];
      this.ready = false; this.indexing = false; this.reindex = false;
      this.update({phase: "꺼짐", file: "", error: "", completed: 0, total: 0, errors: 0});
    },
    toggle(enabled) {
      if (enabled === this.enabled()) return;
      saveData("embeddingEnabled", enabled);
      if (enabled) this.start(); else this.stop();
    },
    start() {
      if (!this.enabled() || this.starting || this.indexing) return;
      clearTimeout(this.startTimer!);
      if (this.provider() === 'cloudflare' && !this.hasCloudflareCredentials()) {
        this.startTimer = null;
        this.update({phase: CLOUDFLARE_KEYS_NEEDED, file: '', error: ''});
        return;
      }
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (this.enabled()) void this.runStart();
      }, 500);
      this.update({phase: "시작 대기", error: "", file: ""});
    },
    async runStart() {
      this.stop();
      this.starting = true;
      const generation = this.generation;
      this.update({phase: "준비 중", completed: 0, total: 0, errors: 0, error: ""});
      try {
        if (this.provider() === 'cloudflare') {
          if (!this.hasCloudflareCredentials()) {this.update({phase: CLOUDFLARE_KEYS_NEEDED}); return;}
          this.ready = true;
          await this.index();
          return;
        }
        if (!globalThis.navigator?.gpu) throw Error("현재 Discord에서 WebGPU를 사용할 수 없습니다.");
        await this.files().mkdir(this.directory(), {recursive: true});
        if (generation !== this.generation) return;
        this.vectors = {};
        try {
          const saved = JSON.parse(await this.files().readFile(legacyCachePath("embedding-gemma2", "vectors-v1.json"), "utf8"));
          if (generation !== this.generation) return;
          this.legacyVectors = readEmbeddingVectors(saved);
        } catch { /* First index or interrupted write: rebuild missing entries. */ }
        const runtime = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";
        const library = await this.asset("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js", generation,
          "8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743");
        const factory = await this.asset(runtime + "ort-wasm-simd-threaded.asyncify.mjs", generation,
          "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611");
        const wasm = await this.asset(runtime + "ort-wasm-simd-threaded.asyncify.wasm", generation,
          "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082");
        if (generation !== this.generation) return;
        const blob = (code: string | ArrayBuffer) => {const url = URL.createObjectURL(new Blob([code], {type: "text/javascript"})); this.urls.push(url); return url;};
        const worker = this.worker = new Worker(blob(`(${embeddingWorker.toString()})();`), {type: "module"});
        worker.onmessage = async ({data}) => {
          if (generation !== this.generation) return;
          if (data.download) {
            try {
              if (!data.url.startsWith("https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/")) throw Error("예상하지 못한 모델 URL");
              const cachedBytes = await this.asset(data.url, generation);
              // A shared download may have multiple consumers; transfer a separate buffer to each.
              const bytes = cachedBytes.slice(0);
              if (generation === this.generation) worker.postMessage({download: data.download, bytes}, [bytes]);
            } catch (_error) { const error = _error as Failure;if (generation === this.generation) worker.postMessage({download: data.download, error: String(error.message)});}
          } else {
            const task = this.pending.get(data.id); this.pending.delete(data.id);
            if (data.error) task?.reject(Error(data.error)); else task?.resolve(data.result);
          }
        };
        worker.onerror = event => {
          if (generation !== this.generation) return;
          const error = event.message || "임베딩 Worker 실행 실패";
          this.stop(); this.update({phase: "오류", error});
        };
        this.update({phase: "모델 불러오는 중", file: ""});
        await this.call("init", {library: blob(library), factory: blob(factory), wasm});
        if (generation !== this.generation) return;
        this.ready = true;
        await this.index();
      } catch (_error) { const error = _error as Failure;
        if (generation !== this.generation) return;
        this.stop(); this.update({phase: "오류", error: String(error.message)});
      } finally {
        if (generation === this.generation) this.starting = false;
      }
    },
    async index() {
      if (!this.ready) return;
      if (this.indexing) {this.reindex = true; return;}
      this.indexing = true;
      const generation = this.generation, isCloud = this.provider() === 'cloudflare';
      const indexController = isCloud ? cloudIndexController = new AbortController() : undefined;
      const inFlight = new Set<Promise<void>>();
      let usable = 0, transientFailures = 0, checkpointWork = Promise.resolve();
      const currentSpec = isCloud ? CLOUDFLARE_EMBEDDING_SPEC : EMBEDDING_SPEC;
      const compatibleSpecs = isCloud ? [currentSpec] : COMPATIBLE_SPECS;
      const items = new Map(pickerPacks().flatMap(pack => pack.detail).map(con => [this.key(con), con]));
      this.update({phase: "이미지 색인", total: items.size, completed: 0, errors: 0, error: "", file: ""});
      const checkActive = () => {
        if (generation !== this.generation) throw Error('임베딩 중단됨');
        if (isCloud && cloudFailure) throw cloudFailure;
      };
      const checkpoint = () => {
        const save = checkpointWork.then(async () => {
          if (!this.dirtyVectors || generation !== this.generation) return;
          const fs = this.files();
          for (const key of [...this.pendingVectorKeys]) {
            const vector = this.vectors[key];
            await writeCacheFile(this.vectorFile(key), JSON.stringify({spec: currentSpec, key, vector}), fs, () => {
              if (generation !== this.generation) throw Error("임베딩 중단됨");
            });
            if (generation !== this.generation) return;
            this.pendingVectorKeys.delete(key); this.dirtyVectors = this.pendingVectorKeys.size;
          }
        });
        checkpointWork = save.catch(() => {});
        return save;
      };
      function rememberVector(key: string, vector: number[], fresh: boolean) {
        usable++;
        Embedding.vectors[key] = vector;
        if (fresh) {
          Embedding.pendingVectorKeys.add(key); Embedding.dirtyVectors = Embedding.pendingVectorKeys.size;
        }
      }
      const finish = async (key: string, vector?: number[], fresh = false) => {
        checkActive();
        if (vector) rememberVector(key, vector, fresh);
        this.update({completed: this.status.completed + 1});
        if (this.dirtyVectors >= 10) await checkpoint();
      };
      const findCached = async (key: string) => {
        if (this.vectors[key]) return this.vectors[key];
        for (const spec of compatibleSpecs) {
          let vector;
          try {
            const file = spec === currentSpec ? this.vectorFile(key) : cachePath('vectors', spec, platform.sha256(key) + '.json');
            const saved = JSON.parse(await this.files().readFile(file, 'utf8'));
            if (saved.key === key && saved.spec === spec)
              vector = readEmbeddingVectors({spec: saved.spec, vectors: {[key]: saved.vector}}, compatibleSpecs)[key];
          } catch { /* Missing or invalid per-image vector. */ }
          checkActive();
          if (vector) return vector;
        }
        return isCloud ? undefined : this.legacyVectors[key];
      };
      const recordError = (error: unknown) => {
        checkActive();
        if (error instanceof CloudflareEmbeddingError && error.fatal) {
          haltCloudflare(error);
          throw error;
        }
        const message = !isCloud || error instanceof CloudflareEmbeddingError ? String((error as Failure).message) : '색인할 디시콘 이미지를 준비하지 못했습니다.';
        this.update({errors: this.status.errors + 1, error: message});
        // A failed local model/device should not trigger hundreds of repeated inference attempts.
        if (!isCloud && this.status.errors >= 3) throw error;
      };
      const cloudIndexError = (error: unknown) => error instanceof CloudflareEmbeddingError ? error
        : new CloudflareEmbeddingError('Cloudflare 이미지 색인에 실패했습니다.');
      try {
        const credentials = isCloud ? normalizeCloudflareCredentials(readCredentials()) : undefined;
        type Entry = {key: string; image: CloudflareImage};
        const batch: Entry[] = [];
        const overhead = JSON.stringify({messages: []}).length;
        let bodySize = overhead;
        const embedBatch = async (entries: Entry[]) => {
          checkActive();
          let vectors: number[][];
          try {vectors = await cloudflare.imageBatch(credentials!, entries.map(entry => entry.image));}
          catch (error) {
            checkActive();
            const failure = cloudIndexError(error);
            if (failure.fatal) {haltCloudflare(failure); return;}
            if (failure.splittable && entries.length > 1) {
              const mid = Math.ceil(entries.length / 2);
              // Both halves share the worker slot, so retries do not exceed the request cap.
              await embedBatch(entries.slice(0, mid));
              await embedBatch(entries.slice(mid));
              return;
            }
            const tripped = !failure.splittable && ++transientFailures >= 3;
            this.update({errors: this.status.errors + entries.length, completed: this.status.completed + entries.length, error: failure.message});
            if (tripped && generation === this.generation) haltCloudflare(failure);
            return;
          }
          checkActive();
          transientFailures = 0;
          // Stage the whole response before yielding, so a peer halt can checkpoint it.
          entries.forEach(({key}, i) => rememberVector(key, vectors[i], true));
          this.update({completed: this.status.completed + entries.length});
          if (this.dirtyVectors >= 10) await checkpoint();
        };
        const submit = async () => {
          if (!batch.length) return;
          // The producer can build one lookahead batch, then waits for a free slot.
          while (inFlight.size >= CLOUDFLARE_CONCURRENCY) {
            await Promise.race(inFlight); checkActive();
          }
          checkActive();
          const entries = batch.splice(0); bodySize = overhead;
          const task = embedBatch(entries).catch(error => {
            if (generation === this.generation) haltCloudflare(cloudIndexError(error));
          }).finally(() => inFlight.delete(task));
          inFlight.add(task);
        };
        for (const [key, con] of items) {
          checkActive();
          const cached = await findCached(key);
          if (cached) {await finish(key, cached); continue;}
          if (isCloud) {
            let image: CloudflareImage, size: number;
            try {
              image = await untilAborted(indexController!.signal, async () =>
                prepareCloudflareImage(await images.getDCConImage(con), checkActive));
              size = JSON.stringify(image).length;
              if (size + overhead > CLOUDFLARE_BODY_LIMIT) throw new CloudflareEmbeddingError('Cloudflare 임베딩 요청 크기 제한을 초과했습니다.');
            } catch (error) {recordError(error); await finish(key); continue;}
            if (batch.length && bodySize + size + 1 > CLOUDFLARE_BODY_LIMIT) await submit();
            bodySize += size + (batch.length ? 1 : 0);
            batch.push({key, image});
            if (batch.length >= CLOUDFLARE_BATCH_ITEMS) await submit();
          } else {
            let vector;
            try {
              const file = await images.getDCConImage(con);
              checkActive();
              const bytes = await file.arrayBuffer();
              checkActive();
              vector = await this.call('image', {bytes, type: file.type}) as number[];
            } catch (error) {recordError(error);}
            await finish(key, vector, true);
          }
        }
        await submit();
        await Promise.all(inFlight);
        checkActive();
        await checkpoint();
        checkActive();
        this.update({phase: this.status.errors ? (usable ? "완료 · 일부 실패" : "오류") : "준비 완료"});
      } catch (error) {
        if (generation !== this.generation) return;
        if (isCloud) haltCloudflare(cloudIndexError(error));
        await Promise.all(inFlight);
        try {await checkpoint();} catch {platform.logger.error('discord-dccon', 'Embedding checkpoint failed');}
        if (generation === this.generation) this.update({phase: '오류', file: '',
          error: isCloud ? cloudFailure!.message : String((error as Failure).message)});
      }
      finally {
        if (cloudIndexController === indexController) cloudIndexController = undefined;
        if (generation === this.generation) {
          this.indexing = false;
          if (this.reindex) {this.reindex = false; void this.index();}
        }
      }
    },
    cancelSearch() {this.searchSequence++; searchController?.abort(); searchController = undefined;},
    async search(text) {
      const isCloud = this.provider() === 'cloudflare';
      if (isCloud && this.enabled() && !this.hasCloudflareCredentials()) throw Error(CLOUDFLARE_SETUP_HINT);
      if (!this.ready) throw Error(cloudFailure?.message || this.status.error || "모델 준비 중입니다. 설정에서 진행 상태를 확인하세요.");
      this.cancelSearch();
      const sequence = this.searchSequence, generation = this.generation;
      const checkSearch = () => {
        if (sequence !== this.searchSequence || generation !== this.generation) throw Error("검색이 취소되었습니다.");
        if (isCloud && cloudFailure) throw cloudFailure;
      };
      let vector: number[];
      if (isCloud) {
        const controller = searchController = new AbortController();
        try {vector = await cloudflare.query(normalizeCloudflareCredentials(readCredentials()), text, controller.signal);}
        catch (error) {
          checkSearch();
          if (error instanceof CloudflareEmbeddingError && error.fatal) haltCloudflare(error);
          throw error;
        } finally {if (searchController === controller) searchController = undefined;}
      } else {
        const request = this.searchWork.then(() => {checkSearch(); return this.call("query", {text});});
        this.searchWork = request.catch(() => {});
        vector = await request as number[];
      }
      checkSearch();
      const results = pickerPacks().flatMap(pack => pack.detail.map(con => ({...con, packageIdx: pack.info.package_idx})))
        .filter(con => this.vectors[this.key(con)])
        .map(con => ({con, score: this.vectors[this.key(con)].reduce((sum, value, i) => sum + value * vector[i], 0)}));
      const unique = new Map();
      for (const item of results.sort((a, b) => b.score - a.score)) if (!unique.has(this.key(item.con))) unique.set(this.key(item.con), item);
      return [...unique.values()];
    },
  };

  return Embedding;
}
