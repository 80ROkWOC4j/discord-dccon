import type {Platform} from '../platform/types.ts';
import type {Failure} from './types.ts';
import type {Binary, WebPService} from './services.ts';
import type {Cache} from './cache.ts';
import {webpWorker} from './workers.ts';
export function isWebP(bytes: Uint8Array) {
  return bytes.length >= 20 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}
export function webpFile(bytes: Uint8Array<ArrayBuffer>) {
  const animated = isWebP(bytes) && bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(12, 16)) === "VP8X" && (bytes[20] & 0x02) !== 0;
  return new File([bytes], animated ? "dccon.webp" : "dccon.gif", {type: "image/webp"});
}





// Pinned libwebp WASM tools. No native executable or model runtime is required.
export function createCodecs(platform: Platform, cache: Cache, splitWorkerSource: string) {
  const SPLIT_WORKER_SOURCE = splitWorkerSource;
  const {cachePath, readCacheFile, writeCacheFile} = cache;
  const WebPCache: WebPService = {
    generation: 0, work: Promise.resolve(), assets: new Map(), downloads: new Set(),
    specs: {
      split: {source: SPLIT_WORKER_SOURCE,
        wasmURL: "https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/codec/enc/webp_enc.wasm",
        hashes: [null, "b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7"]},
      gif: {name: "gif2webp", version: "1.0.8", hashes: ["2cdc53ad32a68c4a99e7bb44fbf7b0a8a35fa0a2f4ba2f099345d9c02cffb3ed", "ae49d60df26fac796041ee0956873d7a33d05ffab3fbb123dfb7106654f1f748"]},
      img: {name: "img2webp", version: "1.0.0", hashes: ["dc9e869dc195aebdf55a4866ee788e7ba6fe69b4e7fb144c275a756e9d9cf7bb", "109f43681b260e9fe30aa909533b19a4438abc73a8e3da4837df5eadf0d1ac86"]},
    },
    async runtime(kind, generation) {
      if (this.assets.has(kind)) return this.assets.get(kind)!;
      const task = (async () => {
        const spec = this.specs[kind], result = [];
        for (const [index, extension] of ["js", "wasm"].entries()) {
          if (index === 0 && spec.source) {result.push(new TextEncoder().encode(spec.source)); continue;}
          const hash = spec.hashes[index]!, digest = (bytes: Binary) => platform.sha256(bytes);
          const target = cachePath("webp-codecs", hash);
          let bytes;
          try {bytes = await readCacheFile("webp-codecs", hash);} catch { /* Download the pinned codec once. */ }
          if (!bytes || typeof bytes === "string" || digest(bytes) !== hash) {
            if (generation !== this.generation) throw Error("WebP 변환 중단됨");
            const controller = new AbortController(); this.downloads.add(controller);
            try {
              const response = await platform.net.fetch(spec.wasmURL || `https://cdn.jsdelivr.net/npm/@libwebp-wasm/${spec.name}@${spec.version}/es/${spec.name}.${extension}`,
                {responseType: "arraybuffer", signal: controller.signal});
              if (response.ok === false || response.status >= 400) throw Error("WebP 변환기 다운로드 실패");
              bytes = new Uint8Array(await response.arrayBuffer());
              if (digest(bytes) !== hash) throw Error("WebP 변환기 무결성 확인 실패");
              if (generation !== this.generation) throw Error("WebP 변환 중단됨");
              await writeCacheFile(target, bytes, undefined, () => {
                if (generation !== this.generation) throw Error("WebP 변환 중단됨");
              });
            } finally {this.downloads.delete(controller);}
          }
          result.push(new Uint8Array(bytes));
        }
        return {source: new TextDecoder().decode(result[0]), wasm: result[1]};
      })();
      this.assets.set(kind, task);
      try {return await task;} catch (_error) { const error = _error as Failure;if (this.assets.get(kind) === task) this.assets.delete(kind); throw error;}
    },
    workerMain: webpWorker,
    convert(bytes, frames, loopCount = 0) {
      if (isWebP(bytes)) return Promise.resolve(bytes);
      const generation = this.generation;
      const task = this.work.then(async () => {
        const encode = async (kind: "gif" | "img", compositeGif = false) => {
          if (generation !== this.generation) throw Error("WebP 변환 중단됨");
          const runtime = await this.runtime(kind, generation);
          if (generation !== this.generation) throw Error("WebP 변환 중단됨");
          if (!this.worker) {
            // Method shorthand needs a function expression when serialized.
            const source = this.workerMain.toString().replace(/^workerMain\(\)/, "function()");
            const workerURL = URL.createObjectURL(new Blob([`(${source})()`], {type: "text/javascript"}));
            try {this.worker = new Worker(workerURL, {type: "module"});} finally {URL.revokeObjectURL(workerURL);}
            this.workerKinds = new Set();
          }
          const worker = this.worker!;
          return new Promise<Binary>((resolve, reject) => {
            this.reject = reject;
            worker.onmessage = ({data}) => {
              this.reject = null;
              if (data.error) return reject(Object.assign(Error(data.error), {gifFrameError: data.gifFrameError === true}));
              const converted = new Uint8Array(data.bytes);
              if (!isWebP(converted)) return reject(Error("WebP 변환 결과가 올바르지 않습니다."));
              this.workerKinds!.add(kind);
              resolve(converted);
            };
            worker.onerror = () => {this.stop(); reject(Error("WebP 변환기 실행 실패"));};
            worker.postMessage({bytes, kind, frames, loopCount, compositeGif,
              runtime: this.workerKinds!.has(kind) ? undefined : runtime});
          });
        };
        const kind = String.fromCharCode(...bytes.slice(0, 4)) === "GIF8" ? "gif" : "img";
        try {return await encode(kind);}
        catch (_error) { const error = _error as Failure;
          if (!error.gifFrameError || kind !== "gif") throw error;
          return encode("img", true);
        }
      });
      this.work = task.catch(() => {});
      return task;
    },
    split(bytes, images) {
      const generation = this.generation;
      const task = this.work.then(async () => {
        if (generation !== this.generation) throw Error("이미지 처리가 중단되었습니다.");
        const runtime = await this.runtime("split", generation);
        if (generation !== this.generation) throw Error("이미지 처리가 중단되었습니다.");
        const first = !this.splitWorker;
        if (first) {
          const url = URL.createObjectURL(new Blob([runtime.source], {type: "text/javascript"}));
          try {this.splitWorker = new Worker(url, {type: "module"});} finally {URL.revokeObjectURL(url);}
        }
        const worker = this.splitWorker!;
        return new Promise<ArrayBuffer | ArrayBuffer[]>((resolve, reject) => {
          this.reject = reject;
          worker.onmessage = ({data}) => {
            this.reject = null;
            if (data.error) {worker.terminate(); this.splitWorker = null; reject(Error(data.error));}
            else resolve(images ? data.bytes : data.tiles);
          };
          worker.onerror = () => {this.stop(); reject(Error("이미지 인코더 실행 실패"));};
          worker.postMessage({bytes, images, wasm: first ? runtime.wasm : undefined},
            images ? images.map(image => image.buffer) : [bytes!.buffer]);
        });
      });
      this.work = task.catch(() => {});
      return task;
    },
    merge(images) {return this.split(null, images) as Promise<ArrayBuffer>;},
    stop() {
      this.generation++;
      for (const controller of this.downloads) controller.abort();
      this.downloads.clear(); this.assets.clear();
      this.worker?.terminate(); this.worker = null;
      this.splitWorker?.terminate(); this.splitWorker = null;
      this.reject?.(Error("WebP 변환 중단됨")); this.reject = null;
      this.work = Promise.resolve();
    },
  };

  return WebPCache;
}
