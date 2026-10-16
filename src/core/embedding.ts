import type {Platform} from '../platform/types.ts';
import type {Failure} from './types.ts';
import type {EmbeddingService, EmbeddingResult, VectorMap} from './services.ts';
import type {Cache} from './cache.ts';
import type {SettingsService} from './settings.ts';
import type {Packs} from './packs.ts';
import type {Images} from './images.ts';
import type {Events} from './events.ts';
import {embeddingWorker} from './workers.ts';
export const EMBEDDING_SPEC = "q8-image560-video6x280-v2";
export function readEmbeddingVectors(saved: {spec?: string; vectors?: Record<string, unknown>} | undefined): VectorMap {
  if (!["q8-560-gif3-browser-v1", EMBEDDING_SPEC].includes(saved?.spec!) || !saved?.vectors) return {};
  return Object.fromEntries(Object.entries(saved.vectors).filter(([key, vector]) =>
    (saved.spec === EMBEDDING_SPEC || !key.endsWith(":gif")) && Array.isArray(vector) &&
    vector.length === 768 && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < 0.001)) as VectorMap;
}

// Runs in a browser Worker: no Node, native addons, or local PoC server required.

export function createEmbedding(platform: Platform, settings: SettingsService, cache: Cache, packs: Packs, images: Images, PluginEvents: Events) {
  const {loadData, saveData} = settings;
  const {cacheFiles, cachePath, legacyCachePath, readCacheFile, writeCacheFile} = cache;
  const {pickerPacks} = packs;
  const Embedding: EmbeddingService = {
    worker: null, generation: 0, sequence: 0, pending: new Map(), vectors: {}, dirtyVectors: 0, urls: [],
    assetRequests: new Map(), downloads: new Set(), searchSequence: 0, searchWork: Promise.resolve(),
    legacyVectors: {}, pendingVectorKeys: new Set(),
    status: {phase: "꺼짐", completed: 0, total: 0, errors: 0},
    enabled() {return loadData("embeddingEnabled", false) === true;},
    key(con) {return con.path + ":" + con.ext;},
    update(changes) {
      Object.assign(this.status, changes);
      PluginEvents.dispatch({type: "DCCON_EMBEDDING_UPDATE"});
    },
    files() {return cacheFiles();},
    directory() {return cachePath("models");},
    vectorDirectory() {return cachePath("vectors", EMBEDDING_SPEC);},
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
      this.generation++; this.searchSequence++;
      for (const controller of this.downloads) controller.abort();
      this.downloads.clear();
      this.vectors = {};
      this.legacyVectors = {}; this.pendingVectorKeys = new Set();
      this.dirtyVectors = 0;
      this.worker?.terminate(); this.worker = null;
      for (const task of this.pending.values()) task.reject(Error("임베딩 중단됨"));
      this.pending.clear(); this.urls.forEach(url => URL.revokeObjectURL(url)); this.urls = [];
      this.ready = false; this.indexing = false; this.reindex = false;
      this.update({phase: "꺼짐", file: ""});
    },
    toggle(enabled) {
      if (enabled === this.enabled()) return;
      saveData("embeddingEnabled", enabled);
      if (enabled) this.start(); else this.stop();
    },
    start() {
      if (!this.enabled() || this.starting || this.indexing) return;
      clearTimeout(this.startTimer!);
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
      const generation = this.generation;
      const items = [...new Map(pickerPacks().flatMap(pack => pack.detail).map(con => [this.key(con), con])).values()];
      this.update({phase: "이미지 색인", total: items.length, completed: 0, errors: 0, error: "", file: ""});
      const checkpoint = async () => {
        if (!this.dirtyVectors || generation !== this.generation) return;
        const fs = this.files();
        for (const key of [...this.pendingVectorKeys]) {
          const vector = this.vectors[key];
          await writeCacheFile(this.vectorFile(key), JSON.stringify({spec: EMBEDDING_SPEC, key, vector}), fs, () => {
            if (generation !== this.generation) throw Error("임베딩 중단됨");
          });
          if (generation !== this.generation) return;
          this.pendingVectorKeys.delete(key); this.dirtyVectors = this.pendingVectorKeys.size;
        }
      };
      try {
        for (const [i, con] of items.entries()) {
          if (generation !== this.generation) return;
          try {
            const key = this.key(con);
            if (!this.vectors[key]) {
              let vector;
              try {
                const saved = JSON.parse(await this.files().readFile(this.vectorFile(key), "utf8"));
                if (saved.key === key && saved.spec === EMBEDDING_SPEC)
                  vector = readEmbeddingVectors({spec: saved.spec, vectors: {[key]: saved.vector}})[key];
              } catch { /* Missing or invalid per-image vector. */ }
              if (generation !== this.generation) return;
              if (!vector) {
                vector = this.legacyVectors[key];
                if (!vector) {
                  const file = await images.getDCConImage(con);
                  if (generation !== this.generation) return;
                  const bytes = await file.arrayBuffer();
                  if (generation !== this.generation) return;
                  vector = await this.call("image", {bytes, type: file.type}) as number[];
                  if (generation !== this.generation) return;
                }
                this.pendingVectorKeys.add(key); this.dirtyVectors = this.pendingVectorKeys.size;
              }
              this.vectors[key] = vector;
            }
          } catch (_error) { const error = _error as Failure;
            if (generation !== this.generation) return;
            this.update({errors: this.status.errors + 1, error: String(error.message)});
            // A failed model/device should not trigger hundreds of repeated inference attempts.
            if (this.status.errors >= 3) throw error;
          }
          this.update({completed: i + 1});
          if (this.dirtyVectors >= 10) await checkpoint();
        }
        await checkpoint();
        if (generation === this.generation) this.update({phase: this.status.errors ? "완료 · 일부 실패" : "준비 완료"});
      } catch (_error) { const error = _error as Failure;
        if (generation === this.generation) {
          try {await checkpoint();} catch (_saveError) { const saveError = _saveError as Failure;platform.logger.error("discord-dccon", "Embedding checkpoint failed", saveError);}
          if (generation !== this.generation) return;
          this.update({phase: "오류", error: String(error.message)});
        }
      }
      finally {
        if (generation === this.generation) {
          this.indexing = false;
          if (this.reindex) {this.reindex = false; void this.index();}
        }
      }
    },
    cancelSearch() {this.searchSequence++;},
    async search(text) {
      if (!this.ready) throw Error(this.status.error || "모델 준비 중입니다. 설정에서 진행 상태를 확인하세요.");
      const sequence = ++this.searchSequence, generation = this.generation;
      const request = this.searchWork.then(() => {
        if (sequence !== this.searchSequence || generation !== this.generation) throw Error("검색이 취소되었습니다.");
        return this.call("query", {text});
      });
      this.searchWork = request.catch(() => {});
      const vector = await request as number[];
      if (sequence !== this.searchSequence || generation !== this.generation) throw Error("검색이 취소되었습니다.");
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
