import type {Platform} from '../platform/types.ts';
import type {Con, Failure, QueueEntry} from './types.ts';
import type {Binary, WebPService, AnimationTiming} from './services.ts';
import type {Cache} from './cache.ts';
import {webpFile, isWebP} from './codecs.ts';
import {DCConBaseURL} from './packs.ts';
export function createImages(platform: Platform, cache: Cache, WebPCache: WebPService) {
  const {personalFile, imageFS, cacheFiles, cachePath, readCacheFile, writeCacheFile} = cache;
  const imageRequests = new Map<string, Promise<File>>();
  async function getDCConImage(con: Con): Promise<File> {
    const key = con.path + ":" + con.ext;
    if (imageRequests.has(key)) return imageRequests.get(key)!;
    const request = (async () => {
      if (con.path.startsWith("personal:")) {
        const target = personalFile(con);
        const bytes = await imageFS("readFile", target, null) as Binary | string;
        if (typeof bytes === "string") throw Error("개별 콘 파일을 읽지 못했습니다.");
        return webpFile(bytes);
      }
      let fs, target;
      try {
        if (platform.cacheAvailable()) {
          fs = cacheFiles();
          const hash = platform.sha256(key);
          target = cachePath("images", hash);
          const cached = await readCacheFile("images", hash, fs);
          // BetterDiscord defaults to UTF-8, unlike Node. Never construct an image from text.
          if (typeof cached === "string") throw Object.assign(new Error("Cache returned text"), {code: "CACHE_NOT_BINARY"});
          if (cached.length) return webpFile(cached);
        }
      } catch { /* Missing or unreadable cache: fetch the original. */ }
      const response = await platform.net.fetch(DCConBaseURL + con.path, {
        responseType: "arraybuffer", headers: { Referer: "https://dcimg5.dcinside.com" },
      });
      if (response.ok === false || response.status >= 400) throw new Error("디시콘 다운로드에 실패했습니다.");
      const contentType = response.headers?.get?.("content-type");
      if (contentType && /text\/html|application\/json/i.test(contentType)) throw new Error("이미지가 아닌 응답을 받았습니다.");
      const original = new Uint8Array(await response.arrayBuffer());
      if (!original.length) throw new Error("디시콘 이미지가 비어 있습니다.");
      const bytes = await WebPCache.convert(original);
      if (fs && target) {
        try {
          await writeCacheFile(target, bytes, fs);
        } catch (_error) { const error = _error as Failure;
          platform.logger.error("discord-dccon", "Image cache write failed", error);
        }
      }
      return webpFile(bytes);
    })();
    imageRequests.set(key, request);
    try { return await request; } finally { imageRequests.delete(key); }
  }

  let cacheGeneration = 0;
  let cacheWork = Promise.resolve();
  function warmCache(cons: Con[]) {
    if (!platform.cacheAvailable()) return;
    const generation = cacheGeneration;
    cacheWork = cacheWork.then(async () => {
      for (const con of cons) {
        if (generation !== cacheGeneration) return;
        try { await service.getDCConImage(con); } catch (_error) { const error = _error as Failure; platform.logger.error("discord-dccon", "Cache preload failed", error); }
      }
    });
  }
  async function splitImageIntoNine(file: File, checkActive: () => void) {
    checkActive();
    const tiles = await WebPCache.split(new Uint8Array(await file.arrayBuffer())) as ArrayBuffer[];
    checkActive();
    return tiles.map((bytes, index) => {
      const tile = webpFile(new Uint8Array(bytes));
      return new File([tile], `dccon-${index + 1}.${tile.name.split(".").pop()}`, {type: tile.type});
    });
  }

  const animationTimings = new WeakMap<File, Promise<AnimationTiming>>();
  function animationTiming(file: File) {
    if (!animationTimings.has(file)) animationTimings.set(file, (async () => {
      const decoder = new ImageDecoder({data: new Uint8Array(await file.arrayBuffer()), type: file.type});
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack!;
        let duration = 0;
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const {image} = await decoder.decode({frameIndex});
          try {duration += Math.max(1, Math.round((image.duration ?? 100000) / 1000));}
          finally {image.close();}
        }
        return {count: track.frameCount, duration, loops: track.repetitionCount};
      } finally {decoder.close();}
    })());
    return animationTimings.get(file)!;
  }
  async function mergeImageReason(files: File[]) {
    if (files.length < 2 || files.length > 3) return "이미지 2~3개를 모아 주세요.";
    const timings = (await Promise.all(files.map(file => service.animationTiming(file)))).filter(info => info.count > 1);
    if (timings.some(info => info.duration !== timings[0].duration)) return "애니메이션 재생 길이가 같아야 합니다.";
    if (timings.some(info => info.loops !== timings[0].loops)) return "애니메이션 반복 횟수가 같아야 합니다.";
    return "";
  }
  async function mergeImages(files: File[], checkActive: () => void) {
    checkActive();
    const reason = await service.mergeImageReason(files);
    if (reason) throw Error(reason);
    checkActive();
    const images = await Promise.all(files.map(async file => new Uint8Array(await file.arrayBuffer())));
    checkActive();
    const bytes = await WebPCache.merge(images);
    checkActive();
    return webpFile(new Uint8Array(bytes));
  }

  const mergedRequests = new Map<string, Promise<File>>();
  async function getMergedImage(entries: QueueEntry[], checkActive: () => void): Promise<File> {
    checkActive();
    const generation = cacheGeneration;
    const key = JSON.stringify({type: "merged", version: 1, images: entries.map(({con}) => [con.path, con.ext])});
    const requestKey = generation + ":" + key;
    if (!mergedRequests.has(requestKey)) {
      const request = (async () => {
        let target, cached;
        if (platform.cacheAvailable()) {
          const hash = platform.sha256(key);
          target = cachePath("merged", hash);
          try {cached = await readCacheFile("merged", hash);} catch { /* Cache miss: compose the images. */ }
        }
        checkActive();
        const cachedFile = cached && typeof cached !== "string" && isWebP(cached) &&
          new DataView(cached.buffer, cached.byteOffset, cached.byteLength).getUint32(4, true) + 8 === cached.length
          ? webpFile(cached) : null;
        if (cachedFile) return cachedFile;
        const file = await service.mergeImages(entries.map(entry => entry.file), checkActive);
        checkActive();
        if (target) {
          try {
            await writeCacheFile(target, new Uint8Array(await file.arrayBuffer()), undefined, checkActive);
          } catch (_error) { const error = _error as Failure;platform.logger.error("discord-dccon", "Merged image cache write failed", error);}
        }
        checkActive();
        return file;
      })();
      mergedRequests.set(requestKey, request);
    }
    const request = mergedRequests.get(requestKey)!;
    try {
      const file = await request;
      checkActive();
      return file;
    } finally {if (mergedRequests.get(requestKey) === request) mergedRequests.delete(requestKey);}
  }

  const service = {getDCConImage, warmCache, splitImageIntoNine, animationTiming, mergeImageReason, mergeImages, getMergedImage,
    stop() {cacheGeneration++;}};
  return service;
}
export type Images = ReturnType<typeof createImages>;
