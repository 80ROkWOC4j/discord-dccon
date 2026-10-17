import type {Platform} from '../platform/types.ts';
import type {Con, FileSystem, Failure} from './types.ts';
export function createCache(platform: Platform) {
  function personalFile(con: Con) {
    if (!/^personal:[a-f0-9]{64}$/.test(con.path)) throw Error("개별 콘 파일 정보가 올바르지 않습니다.");
    return platform.paths.join(sharedRoot(), "discord-dccon-library", con.path.slice(9));
  }
  function imageFS(method: string, ...args: unknown[]) {
    return platform.file(method, ...args);
  }
  function cachePath(...parts: string[]) { return platform.paths.cache(...parts); }
  function legacyCachePath(...parts: string[]) { return platform.paths.legacyCache(...parts); }
  function sharedRoot() { return platform.paths.dataRoot(); }
  function cacheFiles(): FileSystem {
    return Object.fromEntries(["readFile", "mkdir", "writeFile", "rename", "unlink"].map(method =>
      [method, (...args: unknown[]) => imageFS(method, ...args)])) as unknown as FileSystem;
  }
  const cacheSession = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let cacheWriteSequence = 0;
  async function writeCacheFile(file: string, bytes: Uint8Array | string, fs = cacheFiles(), checkActive = () => {}) {
    await fs.mkdir(platform.paths.dirname(file), {recursive: true});
    const temporary = file + ".tmp-" + cacheSession + "-" + ++cacheWriteSequence;
    let committed = false;
    try {
    checkActive();
    await fs.writeFile(temporary, bytes);
    checkActive();
    for (let attempt = 0; ; attempt++) {
      try {await fs.rename(temporary, file); committed = true; break;}
      catch (_error) { const error = _error as Failure;
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code as string) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        checkActive();
      }
    }
    checkActive();
    } finally {
      if (!committed && fs.unlink) {
        try {await fs.unlink(temporary);} catch (_error) { const error = _error as Failure;
          if (error.code !== "ENOENT") platform.logger.error("discord-dccon", "Temporary cache cleanup failed", error);
        }
      }
    }
  }
  async function readCacheFile(kind: string, name: string, fs = cacheFiles()) {
    const file = cachePath(kind, name);
    try {return await fs.readFile(file, null);} catch { /* Try the previous installation cache. */ }
    const legacy = kind === "images" ? legacyCachePath(name)
      : legacyCachePath(kind === "models" ? "embedding-gemma2" : kind, name);
    const bytes = await fs.readFile(legacy, null);
    if (typeof bytes !== "string") {
      try {await writeCacheFile(file, bytes, fs);}
      catch (_error) { const error = _error as Failure;platform.logger.error("discord-dccon", "Cache migration write failed", error);}
    }
    return bytes;
  }

  return {personalFile, imageFS, cachePath, legacyCachePath, sharedRoot, cacheFiles, writeCacheFile, readCacheFile};
}
export type Cache = ReturnType<typeof createCache>;
