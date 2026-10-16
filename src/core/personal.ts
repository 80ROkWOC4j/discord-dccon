import type {Platform} from '../platform/types.ts';
import type {Con, PreparedCon, Failure} from './types.ts';
import type {WebPService} from './services.ts';
import type {Cache} from './cache.ts';
import type {SettingsService} from './settings.ts';
import type {Packs} from './packs.ts';
import type {Sending} from './sending.ts';
import type {Events} from './events.ts';
import {webpFile} from './codecs.ts';
import {PERSONAL_PACK} from './packs.ts';
export function createPersonal(platform: Platform, settings: SettingsService, packs: Packs, cache: Cache, WebPCache: WebPService, sending: Pick<Sending, "isSendingCon" | "removeQueuedCon">, PluginEvents: Events) {
  const {loadData, saveData} = settings;
  const {personalCons} = packs;
  const {imageFS, personalFile, writeCacheFile} = cache;
  function personalURL(text: string) {
    let url;
    try { url = new URL(text.trim()); } catch { throw Error("디시콘 또는 아카콘 이미지 링크를 입력해 주세요."); }
    const dc = /^dcimg\d*\.dcinside\.com$/.test(url.hostname) && url.pathname === "/dccon.php" && /^[a-f0-9]+$/i.test(url.searchParams.get("no") || "");
    const arca = url.hostname === "ac.arca.live";
    if (url.protocol !== "https:" || url.username || url.password || url.port || (!dc && !arca))
      throw Error("디시콘(dcimg*.dcinside.com) 또는 아카콘(ac.arca.live) 이미지 링크만 추가할 수 있습니다.");
    url.hash = "";
    return url;
  }
  async function personalVideo(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
    const video = document.createElement("video"), canvas = document.createElement("canvas");
    const source = URL.createObjectURL(new Blob([bytes], {type: "video/mp4"}));
    const wait = (event: string, start: () => void) => new Promise<void>((resolve, reject) => {
      let eventReady = false, frameReady = false;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback(frameCallback);
        video.removeEventListener(event, ready); video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const ready = () => {eventReady = true; if (frameReady) finish();};
      const failed = () => finish(Error("MP4 영상을 읽지 못했습니다."));
      const aborted = () => finish(Error("추가가 취소되었습니다."));
      const timer = setTimeout(() => finish(Error("영상 처리 시간이 초과되었습니다.")), 15000);
      const frameCallback = video.requestVideoFrameCallback(() => {frameReady = true; if (eventReady) finish();});
      video.addEventListener(event, ready); video.addEventListener("error", failed);
      signal?.addEventListener("abort", aborted, {once: true});
      if (signal?.aborted) aborted(); else start();
    });
    try {
      video.muted = true; video.preload = "auto";
      await wait("loadeddata", () => {video.src = source;});
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 30)
        throw Error("30초 이하의 아카콘 영상만 추가할 수 있습니다.");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      if (canvas.width * canvas.height > 512 * 512) throw Error("영상 해상도는 512×512 픽셀 이하의 면적이어야 합니다.");
      const context = canvas.getContext("2d")!, frames = [], count = Math.ceil(video.duration * 30);
      for (let i = 0; i < count; i++) {
        if (signal?.aborted) throw Error("추가가 취소되었습니다.");
        if (i) await wait("seeked", () => {video.currentTime = i / 30;});
        context.drawImage(video, 0, 0);
        const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        if (!png) throw Error("영상 프레임을 읽지 못했습니다.");
        frames.push({bytes: new Uint8Array(await png.arrayBuffer()), duration: Math.max(1,
          Math.round(Math.min((i + 1) / 30, video.duration) * 1000) - Math.round(i / 30 * 1000))});
      }
      const result = await WebPCache.convert(new Uint8Array(), frames);
      if (signal?.aborted) throw Error("추가가 취소되었습니다.");
      return result;
    } finally {video.removeAttribute("src"); video.load(); URL.revokeObjectURL(source);}
  }
  async function preparePersonalCon(text: string, signal?: AbortSignal): Promise<PreparedCon> {
    let url = personalURL(text);
    let response!: import('../platform/types.ts').DownloadResponse;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (signal?.aborted) throw Error("추가가 취소되었습니다.");
      response = await platform.net.fetch(url.href, {responseType: "arraybuffer", redirect: "manual", signal,
        headers: {Referer: url.hostname === "ac.arca.live" ? "https://arca.live/" : "https://dcimg5.dcinside.com"}});
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers?.get?.("location");
      if (!location || redirects === 5) throw Error("이미지 리디렉션을 처리하지 못했습니다.");
      url = personalURL(new URL(location, url).href);
    }
    if (response.ok === false || response.status >= 400) throw Error("이미지를 가져오지 못했습니다. 링크가 만료되었는지 확인해 주세요.");
    const limit = 10 * 1024 * 1024;
    if (Number(response.headers?.get?.("content-length")) > limit) throw Error("10 MB 이하의 콘만 추가할 수 있습니다.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > limit) throw Error("이미지가 비어 있거나 10 MB를 초과합니다.");
    const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
    const ext = starts(137,80,78,71,13,10,26,10) ? "png" : starts(71,73,70,56) ? "gif"
      : starts(255,216,255) ? "jpg" : starts(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? "webp"
      : String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" ? "mp4" : null;
    if (!ext) throw Error("PNG, JPEG, GIF, WebP 또는 MP4 콘만 추가할 수 있습니다.");
    const file = ext === "mp4" ? webpFile(await personalVideo(bytes, signal))
      : new File([bytes], `discord-dccon.${ext}`, {type: ext === "jpg" ? "image/jpeg" : `image/${ext}`});
    const bitmap = await createImageBitmap(file);
    bitmap.close();
    if (signal?.aborted) throw Error("추가가 취소되었습니다.");
    const hash = platform.sha256(bytes);
    return {file, con: {idx: "personal-" + hash, path: "personal:" + hash, ext, title: "개별 콘", packageIdx: PERSONAL_PACK}};
  }
  async function storePersonalCon(prepared: PreparedCon, title: string, signal?: AbortSignal) {
    const {con, file} = prepared;
    if (personalCons().some(item => item.path === con.path)) throw Error("이미 등록된 콘입니다.");
    const target = personalFile(con);
    await imageFS("mkdir", platform.paths.dirname(target), {recursive: true});
    const bytes = await WebPCache.convert(new Uint8Array(await file.arrayBuffer()));
    if (signal?.aborted) throw Error("추가가 취소되었습니다.");
    await writeCacheFile(target, bytes, undefined, () => {
      if (signal?.aborted) throw Error("추가가 취소되었습니다.");
    });
    // Re-read after disk IO so simultaneous saves cannot overwrite another entry.
    const items = personalCons();
    if (items.some(item => item.path === con.path)) throw Error("이미 등록된 콘입니다.");
    await saveData("personalCons", [...items, {...con, title: title.trim() || `개별 콘 ${items.length + 1}`}]);
    PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
  }
  async function movePersonalCon(con: Con, direction: number) {
    const items = personalCons(), from = items.findIndex(item => item.path === con.path);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to], items[from]];
    await saveData("personalCons", items);
    PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
  }
  async function removePersonalCon(con: Con) {
    if (sending.isSendingCon(con))
      throw Error("전송 중인 콘은 잠시 후 제거해 주세요.");
    await saveData("personalCons", personalCons().filter(item => item.path !== con.path));
    for (const key of ["favorites", "recent"] as const) await saveData(key, loadData(key, []).filter(item => item.path !== con.path));
    try { await imageFS("unlink", personalFile(con)); } catch (_error) { const error = _error as Failure; if (error.code !== "ENOENT") throw error; }
    sending.removeQueuedCon(con);
    PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
    PluginEvents.dispatch({type: "DCCON_FAVORITES_UPDATE"});
    PluginEvents.dispatch({type: "DCCON_RECENT_UPDATE"});
  }

  return {personalURL, personalVideo, preparePersonalCon, storePersonalCon, movePersonalCon, removePersonalCon};
}
export type Personal = ReturnType<typeof createPersonal>;
