import type {Platform} from '../platform/types.ts';
import type {Con, Pack, PackSearchResult, Settings, QueueEntry, SendAttempt, Failure, PreparedCon, PluginMeta, PackId, PluginEvent, EventListener, FileSystem, DiscordResponse, DiscordRest, Attachment} from './types.ts';
import type * as React from 'react';
import type {ImageProps, ChannelProps, BufferImageProps, PersonalImageProps, ThumbnailProps, ItemProps, PanelProps, PanelState, PersonalState, CardProps, SavedCardProps, SettingsState, ButtonProps} from './ui-types.ts';
import type {SharedConfiguration, WebPService, EmbeddingService, Binary, VectorMap, AnimationTiming, EmbeddingResult} from './services.ts';
import {webpWorker, embeddingWorker} from './workers.ts';
import styles from './style.css';


export function createPlugin(platform: Platform, assets: {splitWorkerSource: string}) {
const SPLIT_WORKER_SOURCE = assets.splitWorkerSource;
const DCConBaseURL = "https://dcimg5.dcinside.com/dccon.php?no=";
const DCConProxyURL = "https://dccon-proxy.minibox.workers.dev/?no=";

class DCConImage extends platform.react.Component<ImageProps, {source?: string}> {
  declare observer?: IntersectionObserver;
  declare controller?: AbortController;
  declare url?: string;
  declare image: HTMLImageElement;

  constructor(props: ImageProps) { super(props); this.state = {source: undefined}; }
  componentDidMount() { this.load(); }
  componentDidUpdate(previous: ImageProps) { if (previous.src !== this.props.src) this.load(); }
  componentWillUnmount() { this.release(); }
  release() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.controller?.abort();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
  load() {
    if (!platform.net?.resolveImage) return;
    this.release();
    this.setState({source: undefined});
    const download = () => {
      const controller = this.controller = new AbortController();
      platform.net.resolveImage!(this.props.src, controller.signal).then(blob => {
        if (controller.signal.aborted) return;
        this.url = URL.createObjectURL(blob);
        this.setState({source: this.url});
      }).catch(() => {if (!controller.signal.aborted) this.props.onError?.();});
    };
    if (typeof IntersectionObserver === "undefined") { download(); return; }
    const observer = this.observer = new IntersectionObserver(entries => {
      if (this.observer !== observer || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect(); this.observer = undefined;
      download();
    }, {root: this.image.closest(".dccon-browser-content, .dccon-popover-body, .dccon-rail"), rootMargin: "160px"});
    observer.observe(this.image);
  }
  render() {
    return platform.react.createElement("img", {...this.props,
      ref: image => { this.image = image as HTMLImageElement; },
      src: platform.net?.resolveImage ? this.state.source : this.props.src,
      loading: platform.net?.resolveImage ? "eager" : this.props.loading,
    });
  }
}

const ManduIcon = (props: {size?: string}) => {
  const size = props.size || "24px";

  return platform.react.createElement(
    "svg",
    {
      viewBox: "0 0 512 512",
      className: classes.icon.icon,
      "aria-hidden": "false",
      width: size,
      height: size,
    },
    platform.react.createElement("path", {
      transform: "translate(0,512) scale(0.1,-0.1)",
      fill: "currentColor",
      d: "M2490 4778 c-142 -20 -270 -116 -332 -248 -30 -65 -35 -70 -58 -65 -60 14 -195 17 -249 5 -179 -39 -278 -147 -360 -391 -26 -79 -30 -85 -72 -108 -341 -182 -501 -295 -723 -511 -340 -331 -569 -722 -654 -1120 -91 -420 -29 -784 190 -1112 74 -111 257 -298 373 -380 480 -339 1130 -509 1955 -509 733 0 1322 133 1785 401 148 86 244 159 365 280 169 167 278 341 344 545 119 368 71 803 -133 1220 -126 255 -278 462 -497 675 -222 216 -383 329 -723 511 -44 23 -45 26 -82 137 -21 63 -50 134 -65 159 -53 91 -150 164 -263 199 -56 18 -182 19 -245 3 -26 -6 -48 -10 -49 -8 -2 2 -18 35 -36 72 -61 126 -192 226 -316 242 -27 3 -59 7 -70 9 -11 2 -49 -1 -85 -6z m-470 -1163 c62 -32 92 -105 72 -174 -17 -55 -364 -396 -409 -403 -111 -16 -198 72 -178 179 6 32 32 64 173 207 92 92 181 177 197 187 36 23 105 25 145 4z m621 -8 c64 -42 70 -68 67 -284 -3 -177 -5 -194 -24 -220 -47 -63 -132 -84 -195 -47 -70 41 -74 54 -77 267 -2 168 0 196 15 227 26 50 76 80 133 80 32 0 58 -7 81 -23z m597 9 c15 -8 104 -92 199 -188 187 -189 198 -207 174 -288 -13 -45 -69 -96 -112 -102 -74 -11 -86 -4 -276 185 -192 189 -211 216 -200 284 8 46 30 79 70 103 38 24 106 26 145 6z",
    })
  );
};

// These events are private to discord-dccon; no Discord dispatcher is needed.
const eventListeners = new Map<string, Set<EventListener>>();
const PluginEvents = {
  subscribe(type: string, listener: EventListener) {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(listener);
  },
  unsubscribe(type: string, listener: EventListener) {
    const listeners = eventListeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) eventListeners.delete(type);
  },
  dispatch(event: PluginEvent) {
    for (const listener of [...(eventListeners.get(event.type) ?? [])]) {
      listener(event);
    }
  },
};
const LocaleStore = platform.discord.locale;
const classes = platform.discord.classes;

let currentChannelId = "";

// Both installations mount the picker beside the native composer controls.
function mountToolbar(Button: React.ComponentType<ChannelProps>) {
  const roots = new Map<Element, {host: HTMLDivElement; root: ReturnType<Platform["reactDOM"]["createRoot"]>; channelId?: string}>();
  const store = platform.discord.selectedChannelStore();
  let pending = false, stopped = false;
  function channelFor(editor: Element) {
    if (platform.composer?.targetFor) return platform.composer.targetFor(editor);
    return platform.discord.channelFor(editor);
  }
  function update() {
    pending = false;
    if (stopped) return;
    const active = new Set();
    for (const editor of document.querySelectorAll('[role="textbox"][contenteditable="true"], [class*="channelTextArea"] textarea')) {
      const composer = editor.closest('[class*="channelTextArea"]');
      const toolbar = composer?.querySelector('[class*="buttons_"]');
      const channelId = channelFor(editor);
      if (!toolbar || !channelId) continue;
      active.add(toolbar);
      let entry = roots.get(toolbar);
      if (entry && !toolbar.contains(entry.host)) {
        entry.root.unmount(); roots.delete(toolbar); entry = undefined;
      }
      if (!entry) {
        const host = document.createElement("div");
        host.className = "dccon-toolbar-host";
        host.style.cssText = "display:flex;align-items:center;flex:0 0 auto";
        toolbar.append(host);
        entry = {host, root: platform.reactDOM.createRoot(host)};
        roots.set(toolbar, entry);
      }
      if (entry.channelId !== channelId) {
        entry.channelId = channelId;
        entry.root.render(platform.react.createElement(Button, {channelId}));
      }
    }
    for (const [toolbar, entry] of roots) if (!active.has(toolbar)) {
      entry.root.unmount(); entry.host.remove(); roots.delete(toolbar);
    }
  }
  function schedule() {
    if (pending || stopped) return;
    pending = true;
    queueMicrotask(update);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {childList: true, subtree: true});
  store?.addChangeListener!(schedule);
  update();
  return () => {
    stopped = true; observer.disconnect(); store?.removeChangeListener!(schedule);
    for (const entry of roots.values()) {entry.root.unmount(); entry.host.remove();}
    roots.clear();
  };
}

// 다국어 처리를 위한 번역 리소스
const translations = {
  en: {
    // English
    search: "Search for dccons",
    addDccons: "Add dccons in the plugin settings!",
    recent: "Recent",
    settings: {
      addDccon: "Add dccon",
      remove: "Remove",
      added: "Added",
      adding: "Adding...",
      noResults: "No results",
      searchDccon: "Search for dccon",
    },
    contextMenu: {
      edit: "Edit",
      download: "Download",
      copyColor: "Copy Color",
      moveTo: "Move To",
      addTo: "Add To",
      removeFrom: "Remove From Category",
      setThumbnail: "Set as Thumbnail",
      unsetThumbnail: "Unset Thumbnail",
      delete: "Delete",
    },
    media: {
      placeholder: "dccon name",
      removeFrom: "Remove from category",
      emptyHint: "Click the star in the corner of a dccon to favorite it!",
      upload: {
        title: "Upload",
        normal: "Normal",
        spoiler: "Spoiler",
      },
      controls: {
        show: "Show controls",
        hide: "Hide controls",
      },
    },
  },
  ko: {
    // Korean
    search: "디시콘 검색하기",
    addDccons: "플러그인 설정에서 디시콘을 추가해보세요!",
    recent: "최근 사용",
    settings: {
      addDccon: "디시콘 추가",
      remove: "제거",
      added: "추가됨",
      adding: "추가 중...",
      noResults: "검색 결과가 없습니다",
      searchDccon: "디시콘 검색",
    },
    contextMenu: {
      edit: "수정",
      download: "다운로드",
      copyColor: "색상 복사",
      moveTo: "이동",
      addTo: "추가",
      removeFrom: "카테고리에서 제거",
      setThumbnail: "썸네일로 설정",
      unsetThumbnail: "썸네일 해제",
      delete: "삭제",
    },
    media: {
      placeholder: "디시콘 이름",
      removeFrom: "카테고리에서 제거",
      emptyHint: "디시콘 모서리의 별표를 클릭하여 즐겨찾기에 추가하세요!",
      upload: {
        title: "업로드",
        normal: "일반",
        spoiler: "스포일러",
      },
      controls: {
        show: "컨트롤 표시",
        hide: "컨트롤 숨기기",
      },
    },
  },
};

// 현재 사용자 언어에 맞는 문자열 가져오기
function getLocaleStrings() {
  const locale = LocaleStore.locale?.toLowerCase() || "en";
  const language = locale.split("-")[0];
  return translations[language as keyof typeof translations] || translations.en;
}

// 디시콘 API 관련 함수
const getDCCon = (idx: PackId) => {
  return new Promise<Pack>((resolve, reject) => {
    platform.net.fetch("https://dccon.dcinside.com/index/package_detail", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: `package_idx=${idx}`,
    })
      .then((r) => r.text())
      .then((body) => {
        const original = JSON.parse(body) as Pack;

        const info = {
          package_idx: original.info.package_idx,
          title: original.info.title,
          main_img_path: original.info.main_img_path,
          list_img_path: original.info.list_img_path,
        };

        const detail = original.detail.map((x: Con) => {
          return { idx: x.idx, title: x.title, ext: x.ext, path: x.path };
        });

        resolve({ info, detail });
      })
      .catch((err) => {
        reject(err);
      });
  });
};

// DCCon 버튼 컴포넌트
class DCConButton extends platform.react.Component<ChannelProps, {active: boolean; page: string}> {
  declare button: HTMLButtonElement | null;
  declare refreshBuffer: () => void;
  declare onKeyDown: (event: KeyboardEvent) => void;

  constructor(props: ChannelProps) {
    super(props);
    this.state = { active: false, page: "picker" };
    this.close = this.close.bind(this);
    this.refreshBuffer = () => { if (this.state.active) this.forceUpdate(); };
    this.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
        this.button?.focus();
      }
    };
  }

  componentDidMount() {
    PluginEvents.subscribe("DCCON_CLOSE", this.close);
    PluginEvents.subscribe("DCCON_UNPATCH_ALL", this.close);
    PluginEvents.subscribe("DCCON_BUFFER_UPDATE", this.refreshBuffer);
    window.addEventListener("resize", this.refreshBuffer);
    window.visualViewport?.addEventListener("resize", this.refreshBuffer);
    window.visualViewport?.addEventListener("scroll", this.refreshBuffer);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  componentDidUpdate(previousProps: ChannelProps) {
    if (previousProps.channelId !== this.props.channelId) this.close();
  }

  componentWillUnmount() {
    PluginEvents.unsubscribe("DCCON_CLOSE", this.close);
    PluginEvents.unsubscribe("DCCON_UNPATCH_ALL", this.close);
    PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refreshBuffer);
    window.removeEventListener("resize", this.refreshBuffer);
    window.visualViewport?.removeEventListener("resize", this.refreshBuffer);
    window.visualViewport?.removeEventListener("scroll", this.refreshBuffer);
    document.removeEventListener("keydown", this.onKeyDown, true);
  }

  close(event?: PluginEvent | React.MouseEvent) {
    if (event && "channelId" in event && event.channelId && event.channelId !== this.props.channelId) return;
    if (this.state.active) this.setState({ active: false });
  }

  toggle() {
    if (this.state.active) return this.close();
    PluginEvents.dispatch({ type: "DCCON_CLOSE" });
    currentChannelId = this.props.channelId;
    this.setState({
      active: true,
      page: "picker",
    });
  }

  render() {
    const h = platform.react.createElement;
    const expanded = this.state.page === "picker" && activeQueue(this.props.channelId).length > 0;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const width = Math.min(expanded ? 780 : 520, viewportWidth - 16);
    const height = Math.min(540, viewportHeight - 16);
    const rect = this.button?.getBoundingClientRect();
    const left = Math.max(x + 8, Math.min((rect?.right ?? x + width) - width, x + viewportWidth - width - 8));
    const top = Math.max(y + 8, Math.min((rect?.top ?? y + height) - height - 8, y + viewportHeight - height - 8));
    return h("div", { className: (classes.textarea.buttonContainer ?? "") + " dccon-buttonContainer" },
      h("button", {
        type: "button",
        className: "dccon-button dccon-trigger",
        "aria-label": "디시콘",
        "aria-haspopup": "dialog",
        "aria-expanded": this.state.active,
        ref: (button) => { this.button = button as HTMLButtonElement | null; },
        onPointerDown: (event) => { event.preventDefault(); event.stopPropagation(); },
        onClick: (event) => { event.stopPropagation(); this.toggle(); },
      }, h(ManduIcon)),
      this.state.active && platform.reactDOM.createPortal(
        h("div", { className: "dccon-overlay", onMouseDown: this.close },
          h("section", {
            className: "dccon-popover" + (expanded ? " dccon-popover-expanded" : ""),
            role: "dialog",
            "aria-label": "디시콘 선택",
            style: { left, top, height, width },
            onMouseDown: (event) => event.stopPropagation(),
          },
            expanded && h(BufferTray, {channelId: this.props.channelId}),
            h("div", {className: "dccon-popover-main", key: "main"},
            h("div", { className: "dccon-popover-toolbar" },
              ...[["picker", "내 디시콘"], ["packs", "팩 추가 / 관리"], ["settings", "설정"]].map(([page, label]) =>
                h("button", { key: page, type: "button", "aria-pressed": this.state.page === page,
                  onClick: () => this.setState({ page }) }, label)),
              h("button", { type: "button", "aria-label": "닫기", onClick: this.close }, "×")
            ),
            h("div", { className: "dccon-popover-body" },
              this.state.page !== "picker" ? h(DCConSettingsPanel, { key: this.state.page, section: this.state.page }) : h(DCConPanel, { type: "dccon", onManage: () => this.setState({ page: "packs" }) })
            ))
          )
        ), document.body
      )
    );
  }
}

// #region DCConPanel

const PERSONAL_PACK = "personal-cons";
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
const SharedConfig: SharedConfiguration = {
  data: null, backend: null, pending: [], work: Promise.resolve(),
  async open() {
    this.backend = platform.config || platform.createConfig(EMBEDDING_SPEC);
    this.data = structuredClone((await this.call("open")).settings);
  },
  async call(method: 'open' | 'save', ...args: [string, unknown, unknown] | []) {
    const result = method === 'open' ? await this.backend!.open() : await this.backend!.save(...args as [string, unknown, unknown]);
    if (result.error) throw Object.assign(Error(result.error.message), {code: result.error.code});
    return result;
  },
  save(key, value) {
    const operation = {key, value: structuredClone(value), before: structuredClone(this.data![key])};
    this.pending.push(operation); this.data![key] = structuredClone(value);
    const request = this.work.then(async () => {
      const config = await this.call("save", key, operation.value, operation.before);
      this.pending.shift(); this.data = structuredClone(config.settings);
      for (const pending of this.pending) (this.data as Record<string, unknown>)[pending.key] = structuredClone(pending.value);
    });
    this.work = request.catch(error => {
      this.pending = this.pending.filter(item => item !== operation);
      platform.logger.error("discord-dccon", "Shared configuration save failed", error);
      platform.ui.showToast("설정 저장 실패: " + error.message, {type: "error"});
    });
    return request;
  },
};
function personalCons() { return loadData("personalCons", []); }
function pickerPacks() {
  const packs = loadPacks(), detail = personalCons();
  return detail.length ? [{info: {package_idx: PERSONAL_PACK, title: "개별 콘"}, detail}, ...packs] : packs;
}
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
async function removePersonalCon(con: Con) {
  if ([...sendingChannels].some(channel => activeQueue(channel).some(entry => entry.con.path === con.path)))
    throw Error("전송 중인 콘은 잠시 후 제거해 주세요.");
  await saveData("personalCons", personalCons().filter(item => item.path !== con.path));
  for (const key of ["favorites", "recent"] as const) await saveData(key, loadData(key, []).filter(item => item.path !== con.path));
  try { await imageFS("unlink", personalFile(con)); } catch (_error) { const error = _error as Failure; if (error.code !== "ENOENT") throw error; }
  for (const [channel, entries] of queuedCons) updateQueue(channel, entries.filter(entry => entry.con.path !== con.path));
  PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
  PluginEvents.dispatch({type: "DCCON_FAVORITES_UPDATE"});
  PluginEvents.dispatch({type: "DCCON_RECENT_UPDATE"});
}

// Disk cache uses hashed names so remote paths never become filesystem paths.
function isWebP(bytes: Uint8Array) {
  return bytes.length >= 20 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}
function webpFile(bytes: Uint8Array<ArrayBuffer>) {
  const animated = isWebP(bytes) && bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(12, 16)) === "VP8X" && (bytes[20] & 0x02) !== 0;
  return new File([bytes], animated ? "dccon.webp" : "dccon.gif", {type: "image/webp"});
}





// Pinned libwebp WASM tools. No native executable or model runtime is required.
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
      try { await getDCConImage(con); } catch (_error) { const error = _error as Failure; platform.logger.error("discord-dccon", "Cache preload failed", error); }
    }
  });
}

let lastMessageNonce = 0n;
let lastSendAttempt: SendAttempt | null = null;
const queuedCons = new Map<string, QueueEntry[]>();
const channelTasks = new Map<string, Promise<boolean>>();
const sendingChannels = new Set<string>();
function activeQueue(channelId: string) { return queuedCons.get(channelId) ?? []; }
function updateQueue(channelId: string, entries: QueueEntry[]) {
  queuedCons.set(channelId, entries);
  PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
}
function removeBuffered(channelId: string, entry?: QueueEntry) {
  if (sendingChannels.has(channelId)) return;
  updateQueue(channelId, entry ? activeQueue(channelId).filter(item => item !== entry) : []);
}

function markSend(attempt: SendAttempt, phase: string, details: Partial<SendAttempt> = {}) {
  Object.assign(attempt, details, { phase, updatedAt: new Date().toISOString() });
}

function sendErrorDetails(error: Failure | undefined) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || "오류 설명 없음").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 400),
    status: error?.status ?? error?.statusCode ?? null,
    code: error?.body?.code ?? error?.code ?? null,
  };
}

function responseShape(response: DiscordResponse | undefined) {
  const body = response?.body;
  const header = response?.headers?.get?.("content-type") ?? response?.headers?.["content-type"];
  const keys = (value: unknown) => value && typeof value === "object" ? Object.keys(value).slice(0, 30) : [];
  return {
    responseType: typeof response,
    responseKeys: keys(response),
    bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
    bodyKeys: keys(body),
    contentType: typeof header === "string" ? header.slice(0, 100) : null,
    looksLikeHtml: [body, response?.text].some(value => typeof value === "string" && /^\s*(?:<!doctype\s+html|<html)/i.test(value)),
    bodyStringLength: typeof body === "string" ? body.length : null,
    hasTopLevelId: Boolean(response?.id),
    hasDataId: Boolean(response?.data?.id),
  };
}

async function sendImagesDirectly(files: File[], channelId: string, attempt: SendAttempt) {
  markSend(attempt, "모듈 조회");
  const CloudUpload = platform.discord.uploadModule();
  const rest = platform.discord.restModule();
  if (!CloudUpload || !rest) throw new Error("즉시 전송 모듈을 찾지 못했습니다. 진단 탭을 확인해 주세요.");
  attempt.restModule = {
    keys: Object.keys(rest).slice(0, 40),
    postParameterCount: rest.post.length,
    // Function source contains code only, not request arguments or closure values.
    postImplementation: Function.prototype.toString.call(rest.post).slice(0, 600),
  };
  const attachments = [];
  for (const [index, file] of files.entries()) {
    markSend(attempt, "업로드 객체 생성", { attachmentIndex: index + 1, attachmentCount: files.length, imageBytes: files.reduce((sum, image) => sum + image.size, 0) });
    const upload = new CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId);
    markSend(attempt, "Discord 파일 업로드", {
      listenerCleanup: typeof upload.off === "function" ? "off" : typeof upload.removeListener === "function" ? "removeListener" : "none",
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        // Listener cleanup must not prevent a completed upload from settling.
        try {
          const remove = upload.off ?? upload.removeListener;
          remove?.call(upload, "complete", complete);
          remove?.call(upload, "error", fail);
        } catch (_error) { const error = _error as Failure; attempt.cleanupError = sendErrorDetails(error); }
      };
      const complete = () => { cleanup(); markSend(attempt, "Discord 업로드 완료", { hasUploadedFilename: Boolean(upload.uploadedFilename) }); resolve(); };
      const fail = (error?: Failure) => {
        cleanup();
        attempt.uploadError = sendErrorDetails(error || upload.error);
        reject(new Error("이미지 업로드에 실패했습니다. 진단 탭의 마지막 전송 결과를 확인해 주세요."));
      };
      const timer = setTimeout(() => {
        cleanup();
        try { upload.cancel(); } catch { /* Preserve the timeout error if cancellation also fails. */ }
        reject(new Error("이미지 업로드 시간이 초과되었습니다."));
      }, 120000);
      upload.on("complete", complete);
      upload.on("error", fail);
      try { Promise.resolve(upload.upload()).catch(fail); } catch (_error) { const error = _error as Failure; fail(error); }
    });
    if (!upload.uploadedFilename) throw new Error("업로드 결과에 파일 경로가 없습니다.");
    attachments.push({ id: String(index), filename: upload.filename || file.name, uploaded_filename: upload.uploadedFilename });
  }
  await postDCCon(rest, channelId, attempt, attachments);
}

async function postDCCon(rest: DiscordRest, channelId: string, attempt: SendAttempt, attachments: Attachment[]) {
  const timestampNonce = (BigInt(Date.now()) - 1420070400000n) << 22n;
  lastMessageNonce = timestampNonce > lastMessageNonce ? timestampNonce : lastMessageNonce + 1n;
  // Send only plugin-owned files; leave composer text and reply untouched.
  markSend(attempt, "메시지 생성 요청");
  const response = await rest.post({
    url: `/channels/${channelId}/messages`,
    body: {
      content: "", nonce: String(lastMessageNonce), enforce_nonce: true,
      type: 0, sticker_ids: [], allowed_mentions: { parse: [] },
      attachments,
    },
  });
  const body = response?.body as {id?: string; code?: number} | undefined;
  markSend(attempt, "메시지 생성 응답", {
    responseShape: responseShape(response),
    httpStatus: response?.status ?? null,
    apiCode: body?.code ?? null,
    hasMessageId: Boolean(body?.id),
  });
  if (response?.ok === false || response?.status! >= 400) {
    throw new Error(`메시지 전송 실패 (HTTP ${response.status ?? "오류"}).`);
  }
  if (!body?.id) throw new Error("전송 성공을 확인할 수 없습니다. 채널과 진단 결과를 확인해 주세요. 자동 재전송하지 않습니다.");
}

let bufferGeneration = 0;

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
async function mergeAnimationReason(files: File[]) {
  if (files.length < 2 || files.length > 3) return "애니메이션 2~3개를 모아 주세요.";
  const timings = await Promise.all(files.map(animationTiming));
  if (timings.some(info => info.count < 2)) return "애니메이션 이미지끼리만 합칠 수 있습니다.";
  if (timings.some(info => info.duration !== timings[0].duration)) return "애니메이션 재생 길이가 같아야 합니다.";
  if (timings.some(info => info.loops !== timings[0].loops)) return "애니메이션 반복 횟수가 같아야 합니다.";
  return "";
}
async function mergeAnimatedImages(files: File[], checkActive: () => void) {
  checkActive();
  const reason = await mergeAnimationReason(files);
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
  const generation = bufferGeneration;
  const key = JSON.stringify({type: "merged", version: 1, images: entries.map(({con}) => [con.path, con.ext])});
  const requestKey = generation + ":" + key;
  if (!mergedRequests.has(requestKey)) {
    const request = (async () => {
      let target, cached;
      if (platform.cacheAvailable()) {
        const hash = platform.sha256(key);
        target = cachePath("merged", hash);
        try {cached = await readCacheFile("merged", hash);} catch { /* Cache miss: compose the animations. */ }
      }
      checkActive();
      const cachedFile = cached && typeof cached !== "string" && isWebP(cached) &&
        new DataView(cached.buffer, cached.byteOffset, cached.byteLength).getUint32(4, true) + 8 === cached.length
        ? webpFile(cached) : null;
      if (cachedFile?.name === "dccon.webp") return cachedFile;
      const file = await mergeAnimatedImages(entries.map(entry => entry.file), checkActive);
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

// 디시콘 메시지 전송 함수
const sendDCConMessage = (con: Con | null, { keepOpen = false, channelId = currentChannelId, splitNine = false, mergeImages = false } = {}) => {
  const startedAt = new Date().toISOString();
  const generation = bufferGeneration;
  if (sendingChannels.has(channelId)) return Promise.resolve(false);
  const sending = !keepOpen;
  if (sending) sendingChannels.add(channelId);
  PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
  const attempt: SendAttempt = { startedAt, outcome: "진행 중", keepOpen, phase: "작업 대기",
    mode: keepOpen ? "버퍼 누적" : platform.composer?.attachFiles ? "입력창 첨부" : "즉시 전송" };
  const task = (channelTasks.get(channelId) ?? Promise.resolve()).then(async () => {
    lastSendAttempt = attempt;
    try {
      if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
      markSend(attempt, "채널 확인", { hasChannel: Boolean(channelId) });
      if (!channelId) throw new Error("현재 채널을 찾을 수 없습니다.");
      if (splitNine && (con || keepOpen || activeQueue(channelId).length !== 1))
        throw Error("이미지를 정확히 1개 모았을 때만 9개로 나눠 보낼 수 있습니다.");
      if (mergeImages && (con || keepOpen || splitNine || activeQueue(channelId).length < 2 || activeQueue(channelId).length > 3))
        throw Error("애니메이션 2~3개를 모았을 때만 합쳐 보낼 수 있습니다.");
      if (!con && !activeQueue(channelId).length) return false;
      if (keepOpen && activeQueue(channelId).length >= 9)
        throw new Error("최대 9개까지 모을 수 있습니다. 일반 클릭으로 마지막 콘과 함께 보내세요.");
      markSend(attempt, "캐시 / 이미지 준비");
      const image = con ? await getDCConImage(con) : null;
      attempt.imageBytes = image?.size ?? 0;
      if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
      markSend(attempt, "전송 준비");
      let sentCons = [con!];
      if (keepOpen) {
        markSend(attempt, "버퍼 추가");
        updateQueue(channelId, [...activeQueue(channelId), {file: image!, con: con!}]);
        markSend(attempt, "완료", { outcome: "버퍼 누적 완료", queuedCount: activeQueue(channelId).length });
      } else {
        const queued = activeQueue(channelId);
        let files = [...queued.map(entry => entry.file), ...(image ? [image] : [])];
        if (splitNine) {
          markSend(attempt, "이미지 9분할");
          files = await splitImageIntoNine(queued[0].file, () => {
            if (generation !== bufferGeneration) throw Error("이미지 분할이 중단되었습니다.");
          });
        }
        if (mergeImages) {
          markSend(attempt, "애니메이션 합치기");
          files = [await getMergedImage(queued, () => {
            if (generation !== bufferGeneration) throw Error("이미지 합치기가 중단되었습니다.");
          })];
        }
        if (platform.composer?.attachFiles) {
          markSend(attempt, "입력창 첨부");
          await platform.composer.attachFiles(files, channelId);
        } else {
          await sendImagesDirectly(files, channelId, attempt);
        }
        if (generation === bufferGeneration) updateQueue(channelId, []);
        sentCons = [...queued.map(entry => entry.con), ...(con ? [con] : [])];
        markSend(attempt, "완료", { outcome: platform.composer?.attachFiles ? "입력창에 전달 완료" : "전송 성공 확인", sentCount: files.length });
      }
      if (sending) {
        let recent = loadData("recent", []);
        for (const item of sentCons) recent = [item, ...recent.filter(entry => entry.path !== item.path)].slice(0, 20);
        saveData("recent", recent);
        PluginEvents.dispatch({ type: "DCCON_RECENT_UPDATE" });
      }
      if (sending) PluginEvents.dispatch({ type: "DCCON_CLOSE", channelId });
      return true;
    } catch (_error) { const error = _error as Failure;
      attempt.outcome = "실패";
      attempt.error = sendErrorDetails(error);
      attempt.updatedAt = new Date().toISOString();
      platform.logger.error("discord-dccon", "Failed to send discord-dccon:", error);
      platform.ui.showToast((platform.composer?.attachFiles ? "디시콘 첨부 실패 (" : "디시콘 전송 실패 (") + attempt.phase + "): " + error.message, { type: "error", timeout: 10000 });
      return false;
    } finally {
      if (sending) sendingChannels.delete(channelId);
      PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
    }
  });
  channelTasks.set(channelId, task);
  task.then(() => { if (channelTasks.get(channelId) === task) channelTasks.delete(channelId); });
  return task;
};

class BufferTray extends platform.react.Component<ChannelProps, {mergeReady: boolean; mergeReason: string}> {
  declare mergeSequence: number;
  declare mergeFiles?: File[];
  declare refresh: () => void;

  constructor(props: ChannelProps) {
    super(props);
    this.state = {mergeReady: false, mergeReason: "애니메이션 2~3개를 모아 주세요."};
    this.mergeSequence = 0;
    this.refresh = () => {this.forceUpdate(); this.checkMerge();};
  }
  componentDidMount() { PluginEvents.subscribe("DCCON_BUFFER_UPDATE", this.refresh); this.checkMerge(); }
  componentDidUpdate(previous: ChannelProps) {if (previous.channelId !== this.props.channelId) this.checkMerge();}
  componentWillUnmount() {this.mergeSequence++; PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refresh);}
  checkMerge() {
    const files = activeQueue(this.props.channelId).map(entry => entry.file);
    if (this.mergeFiles?.length === files.length && files.every((file, index) => file === this.mergeFiles![index])) return;
    this.mergeFiles = files;
    const sequence = ++this.mergeSequence;
    this.setState({mergeReady: false, mergeReason: "재생 정보 확인 중…"});
    mergeAnimationReason(files).then(reason => {
      if (sequence === this.mergeSequence) this.setState({mergeReady: !reason, mergeReason: reason});
    }, () => {
      if (sequence === this.mergeSequence) this.setState({mergeReady: false, mergeReason: "애니메이션 정보를 읽지 못했습니다."});
    });
  }
  render() {
    const h = platform.react.createElement;
    const channelId = this.props.channelId;
    const entries = activeQueue(channelId);
    const busy = sendingChannels.has(channelId);
    if (!entries.length && !busy) return null;
    return h("section", { className: "dccon-buffer", "aria-label": "전송 대기 디시콘" },
      h("div", { className: "dccon-buffer-heading" },
        h("span", {role: "status"}, busy ? (platform.composer?.attachFiles ? "첨부 중…" : "전송 중…") : "모아둔 콘 " + entries.length + "/9"),
        h("div", {className: "dccon-buffer-actions"},
          h("button", {type: "button", disabled: busy, onClick: () => removeBuffered(channelId)}, "전체 비우기"),
          h("button", {type: "button", className: "dccon-buffer-send", disabled: busy || !entries.length,
            onClick: () => sendDCConMessage(null, {channelId})}, platform.composer?.attachFiles ? "입력창에 첨부" : "전송"))),
      h("div", {className: "dccon-buffer-preview"},
        h("div", {className: "dccon-buffer-items", "data-count": entries.length}, entries.map((entry, index) => h("button", {
        key: index, type: "button", disabled: busy, title: entry.con.title + " 제거",
        "aria-label": entry.con.title + " 제거", onClick: () => removeBuffered(channelId, entry),
      }, h("div", {className: "dccon-buffer-media"}, h(BufferImage, {file: entry.file, title: entry.con.title})),
        h("span", {className: "dccon-buffer-order", "aria-hidden": true}, index + 1),
        h("span", {className: "dccon-buffer-remove", "aria-hidden": true}, "×"))))),
      h("button", {type: "button", className: "dccon-buffer-split", disabled: busy || entries.length !== 1,
        title: "이미지 1개를 3×3으로 나눕니다. 애니메이션은 유지됩니다.",
        onClick: () => sendDCConMessage(null, {channelId, splitNine: true})}, platform.composer?.attachFiles ? "9개로 쪼개서 첨부" : "9개로 쪼개서 보내기"),
      h("button", {type: "button", className: "dccon-buffer-merge", disabled: busy || !this.state.mergeReady,
        title: this.state.mergeReason || "선택 순서대로 가로로 이어붙입니다. 원본 크기와 애니메이션을 유지합니다.",
        onClick: () => sendDCConMessage(null, {channelId, mergeImages: true})}, platform.composer?.attachFiles ? "합쳐서 첨부" : "합쳐서 전송"),
      this.state.mergeReason && h("p", {className: "dccon-buffer-merge-reason", role: "status"}, this.state.mergeReason),
      h("p", {className: "dccon-buffer-hint"}, platform.composer?.attachFiles
        ? "일반 클릭은 콘을 하나 더 추가해 입력창에 첨부합니다. Discord에서 직접 전송하세요."
        : "예상 배치 · 기기마다 크기는 달라질 수 있어요. 일반 클릭은 콘을 하나 더 추가해 전송합니다."));
  }
}
class BufferImage extends platform.react.Component<BufferImageProps, {url: string | null}> {

  constructor(props: BufferImageProps) { super(props); this.state = {url: null}; }
  componentDidMount() { this.setState({url: URL.createObjectURL(this.props.file)}); }
  componentDidUpdate(previous: BufferImageProps) {
    if (previous.file !== this.props.file) {
      URL.revokeObjectURL(this.state.url!);
      this.setState({url: URL.createObjectURL(this.props.file)});
    }
  }
  componentWillUnmount() { if (this.state.url) URL.revokeObjectURL(this.state.url!); }
  render() { return this.state.url && platform.react.createElement("img", {src: this.state.url, alt: this.props.title, className: this.props.className}); }
}

class PersonalImage extends platform.react.Component<PersonalImageProps, {file: File | null}> {
  declare disposed: boolean;

  constructor(props: PersonalImageProps) { super(props); this.state = {file: null}; }
  componentDidMount() {
    getDCConImage(this.props.con).then(file => {
      if (!this.disposed) this.setState({file});
    }).catch(() => { if (!this.disposed) this.props.onError?.(); });
  }
  componentWillUnmount() { this.disposed = true; }
  render() { return this.state.file && platform.react.createElement(BufferImage, {file: this.state.file, title: this.props.con.title, className: this.props.className}); }
}

class PersonalConManager extends platform.react.Component<Record<string, never>, PersonalState> {
  declare disposed: boolean;
  declare controller?: AbortController;
  declare working: boolean;
  declare refresh: () => void;

  constructor(props: Record<string, never>) {
    super(props);
    this.state = {items: personalCons(), open: false, input: "", title: "", prepared: null, busy: false, message: ""};
    this.refresh = () => this.setState({items: personalCons()});
  }
  componentDidMount() { PluginEvents.subscribe("DCCON_PERSONAL_UPDATE", this.refresh); }
  componentWillUnmount() {
    this.disposed = true;
    this.controller?.abort();
    PluginEvents.unsubscribe("DCCON_PERSONAL_UPDATE", this.refresh);
  }
  async work(action: (signal: AbortSignal) => Promise<unknown>) {
    if (this.working) return;
    this.working = true;
    this.controller = new AbortController();
    this.setState({busy: true, message: ""});
    try { await action(this.controller.signal); }
    catch (_error) { const error = _error as Failure; if (!this.disposed) this.setState({message: error.message}); }
    finally { this.working = false; if (!this.disposed) this.setState({busy: false}); }
  }
  open() {
    this.setState({open: true, input: "", title: "", prepared: null});
    return this.work(async signal => {
      let text;
      try {
        try { text = await platform.readClipboardText(); }
        catch { text = await navigator.clipboard.readText(); }
      } catch {
        if (!this.disposed) this.setState({message: "클립보드를 읽지 못했습니다. 이미지 링크를 직접 입력해 주세요."});
        return;
      }
      try { personalURL(text); }
      catch { if (!this.disposed) this.setState({message: "클립보드에 지원되는 링크가 없습니다. 디시콘 또는 아카콘 이미지 링크를 입력해 주세요."}); return; }
      if (signal.aborted) return;
      this.setState({input: text});
      const prepared = await preparePersonalCon(text, signal);
      if (!signal.aborted) this.setState({prepared, message: "클립보드의 이미지입니다. 확인 후 추가해 주세요."});
    });
  }
  add() {
    return this.work(async signal => {
      const prepared = this.state.prepared || await preparePersonalCon(this.state.input, signal);
      if (signal.aborted) return;
      await storePersonalCon(prepared, this.state.title, signal);
      if (!this.disposed) this.setState({open: false, prepared: null, message: "개별 콘에 추가했습니다."});
    });
  }
  render() {
    const h = platform.react.createElement, s = this.state;
    return h("div", {className: "dccon-personal"},
      h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.open()}, "콘 추가"),
      s.open && h("form", {className: "dccon-personal-form", onSubmit: event => {event.preventDefault(); this.add();}},
        h("label", null, "이미지 링크", h("input", {value: s.input, disabled: s.busy, placeholder: "디시콘 · 아카콘 이미지 URL", onChange: e => this.setState({input: (e.target as HTMLInputElement).value, prepared: null})})),
        h("label", null, "이름 (선택)", h("input", {value: s.title, disabled: s.busy, maxLength: 100, onChange: e => this.setState({title: (e.target as HTMLInputElement).value})})),
        s.prepared && h("div", {className: "dccon-personal-preview"}, h(BufferImage, {file: s.prepared.file, title: "추가할 콘 미리보기"})),
        h("div", {className: "dccon-personal-actions"},
          h("button", {type: "submit", className: "dccon-button", disabled: s.busy || !s.input.trim()}, s.busy ? "처리 중…" : "추가"),
          h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.setState({open: false, prepared: null, message: ""})}, "취소"))),
      h("p", {role: "status"}, s.busy ? "이미지를 처리하고 있습니다…" : s.message),
      !s.items.length && h("p", null, "개별 이미지를 등록하면 내 디시콘의 ‘개별 콘’에서 사용할 수 있습니다."),
      ...s.items.map(con => h("div", {className: "dccon-card", key: con.path},
        h("div", {className: "dccon-personal-preview"}, h(PersonalImage, {con})),
        h("div", {className: "dccon-card-content"}, h("h3", null, con.title)),
        h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.work(() => removePersonalCon(con))}, "제거"))));
  }
}

class PackThumbnail extends platform.react.Component<ThumbnailProps, {index: number}> {

  constructor(props: ThumbnailProps) {
    super(props);
    this.state = { index: 0 };
  }

  render() {
    const { pack, className } = this.props;
    if (pack.info.package_idx === PERSONAL_PACK) {
      const con = pack.detail[0];
      return con ? platform.react.createElement(PersonalImage, {key: con.path, con, className}) : null;
    }
    const paths = [...new Set([pack.info.main_img_path, pack.detail[0]?.path, pack.info.list_img_path].filter(Boolean))];
    if (!paths[this.state.index]) {
      return platform.react.createElement("span", { className, "aria-hidden": true }, pack.info.title.slice(0, 1));
    }
    const next = () => this.setState(state => ({ index: state.index + 1 }));
    return platform.react.createElement(DCConImage, {
      className, alt: "", src: DCConProxyURL + paths[this.state.index], loading: "lazy",
      onError: next,
      onLoad: event => { if (event.currentTarget.naturalWidth <= 1 || event.currentTarget.naturalHeight <= 1) next(); },
    });
  }
}

// 카테고리 컴포넌트
class DCConCategory extends platform.react.Component<{dccon: Pack}, {expanded: boolean}> {

  constructor(props: {dccon: Pack}) {
    super(props);
    this.state = {
      expanded: !loadData("collapsedPacks", {})[String(props.dccon.info.package_idx)],
    };
  }

  render() {
    const { dccon } = this.props;
    const strings = getLocaleStrings();

    return platform.react.createElement(
      "div",
      { className: "dccon-category" },
      platform.react.createElement(
        "button",
        {
          type: "button",
          "aria-expanded": this.state.expanded,
          className: `dccon-category-header ${
            this.state.expanded ? "expanded" : "collapsed"
          }`,
          onClick: () => {
            const expanded = !this.state.expanded;
            const collapsed = loadData("collapsedPacks", {});
            const id = String(dccon.info.package_idx);
            if (expanded) delete collapsed[id];
            else collapsed[id] = true;
            saveData("collapsedPacks", collapsed);
            this.setState({ expanded });
          },
        },
        platform.react.createElement(PackThumbnail, {
          pack: dccon,
          className: "dccon-category-icon",
        }),
        platform.react.createElement(
          "div",
          { className: "dccon-category-name" },
          dccon.info.title
        ),
        platform.react.createElement(
          "div",
          { className: "dccon-category-toggle" },
          platform.react.createElement(
            "svg",
            {
              width: "24",
              height: "24",
              viewBox: "0 0 24 24",
            },
            platform.react.createElement("path", {
              fill: "currentColor",
              d: this.state.expanded
                ? "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"
                : "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
            })
          )
        )
      ),
      this.state.expanded &&
        platform.react.createElement(
          "div",
          { className: "dccon-items" },
          dccon.detail.map((con) =>
            platform.react.createElement(DCConItem, {
              key: con.idx,
              con: con,
              packageIdx: dccon.info.package_idx,
            })
          )
        )
    );
  }
}

// 디시콘 아이템 컴포넌트
class DCConItem extends platform.react.Component<ItemProps, {error: boolean; busy: boolean; favorite: boolean}> {
  declare refreshFavorite: () => void;
  declare sending: boolean;

  constructor(props: ItemProps) {
    super(props);
    this.state = { error: false, busy: false, favorite: loadData("favorites", []).some(con => con.path === props.con.path) };
    this.refreshFavorite = () => this.setState({ favorite: loadData("favorites", []).some(con => con.path === this.props.con.path) });
  }

  componentDidMount() { PluginEvents.subscribe("DCCON_FAVORITES_UPDATE", this.refreshFavorite); }
  componentWillUnmount() { PluginEvents.unsubscribe("DCCON_FAVORITES_UPDATE", this.refreshFavorite); }

  toggleFavorite() {
    const con = { ...this.props.con, packageIdx: this.props.packageIdx };
    const favorites = loadData("favorites", []);
    saveData("favorites", favorites.some(item => item.path === con.path)
      ? favorites.filter(item => item.path !== con.path) : [...favorites, con]);
    PluginEvents.dispatch({ type: "DCCON_FAVORITES_UPDATE" });
  }

  async attach(event: React.MouseEvent) {
    if (this.sending) return;
    const keepOpen = event.shiftKey;
    this.sending = true;
    this.setState({ busy: true });
    try {
      await sendDCConMessage({ ...this.props.con, packageIdx: this.props.packageIdx }, { keepOpen });
    } finally {
      this.sending = false;
      this.setState({ busy: false });
    }
  }

  render() {
    const h = platform.react.createElement;
    const { con } = this.props;
    return h("div", { className: "dccon-tile" },
      h("button", { type: "button", title: con.title + " · Shift+클릭: 이미지 모아두기",
        "aria-label": con.title, className: "dccon-item", disabled: this.state.busy || this.state.error,
        onClick: event => this.attach(event),
      }, this.state.error ? h("span", { className: "dccon-item-error" }, "이미지 로드 실패")
        : con.path.startsWith("personal:") ? h(PersonalImage, {con, onError: () => this.setState({error: true})})
        : h(DCConImage, { src: DCConProxyURL + con.path, alt: con.title, loading: "lazy", onError: () => this.setState({ error: true }) }),
        this.state.busy && h("span", { className: "dccon-loading", role: "status" }, "처리 중…")
      ),
      h("button", { type: "button", className: "dccon-favorite", "aria-label": this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가",
        title: this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가", "aria-pressed": this.state.favorite, onClick: () => this.toggleFavorite(),
      }, this.state.favorite ? "★" : "☆")
    );
  }
}

// 디시콘 패널 컴포넌트 업데이트
class DCConPanel extends platform.react.Component<PanelProps, PanelState> {
  declare personalRefresh: () => void;
  declare clearSearch: () => void;
  declare refresh: () => void;
  declare embeddingRefresh: () => void;
  declare mounted: boolean;
  declare searchGeneration: number;
  declare searchTimer?: ReturnType<typeof setTimeout>;
  declare embeddingPhase: string;
  declare content: HTMLDivElement | null;

  constructor(props: PanelProps) {
    super(props);
    this.state = { textFilter: "", selected: "all", dccons: pickerPacks() };
    this.personalRefresh = () => {
      this.setState({dccons: pickerPacks(), semanticResults: (this.state.semanticResults || []).filter(({con}) =>
        !con.path.startsWith("personal:") || personalCons().some(item => item.path === con.path))});
    };
    this.clearSearch = () => this.changeSearch("");
    this.refresh = () => this.setState({ revision: (this.state.revision ?? 0) + 1 });
    this.embeddingRefresh = () => {
      this.refresh();
      const phase = Embedding.status.phase;
      if (!Embedding.enabled() || (phase !== this.embeddingPhase && ["이미지 색인", "준비 완료", "완료 · 일부 실패"].includes(phase))) this.changeSearch(this.state.textFilter);
      this.embeddingPhase = phase;
    };
  }

  componentDidMount() {
    PluginEvents.subscribe("DCCON_PERSONAL_UPDATE", this.personalRefresh);
    PluginEvents.subscribe("DCCON_FAVORITES_UPDATE", this.refresh);
    PluginEvents.subscribe("DCCON_RECENT_UPDATE", this.refresh);
    this.mounted = true;
    PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.embeddingRefresh);
  }

  componentWillUnmount() {
    PluginEvents.unsubscribe("DCCON_PERSONAL_UPDATE", this.personalRefresh);
    PluginEvents.unsubscribe("DCCON_FAVORITES_UPDATE", this.refresh);
    PluginEvents.unsubscribe("DCCON_RECENT_UPDATE", this.refresh);
    this.mounted = false; clearTimeout(this.searchTimer); this.searchGeneration = (this.searchGeneration || 0) + 1;
    Embedding.cancelSearch();
    PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.embeddingRefresh);
  }

  changeSearch(text: string) {
    clearTimeout(this.searchTimer);
    Embedding.cancelSearch();
    const generation = this.searchGeneration = (this.searchGeneration || 0) + 1;
    const semantic = Embedding.enabled() && text.trim();
    this.setState({textFilter: text, semanticResults: [], searchError: "", searching: Boolean(semantic)});
    if (!semantic) return;
    this.searchTimer = setTimeout(async () => {
      try {
        const semanticResults = await Embedding.search(text.trim());
        if (this.mounted && generation === this.searchGeneration) this.setState({semanticResults, searching: false});
      } catch (_error) { const error = _error as Failure;
        if (this.mounted && generation === this.searchGeneration) this.setState({searchError: String(error.message), searching: false});
      }
    }, 350);
  }

  filterDccons() {
    const query = this.state.textFilter.trim().toLowerCase();
    return this.state.dccons
      .filter(pack => this.state.selected === "all" || String(pack.info.package_idx) === this.state.selected)
      .map(pack => ({ ...pack, detail: !query || pack.info.title.toLowerCase().includes(query)
        ? pack.detail : pack.detail.filter(con => con.title.toLowerCase().includes(query)) }))
      .filter(pack => pack.detail.length > 0);
  }

  render() {
    if (this.props.type !== "dccon") return null;
    const h = platform.react.createElement;
    const packs = this.filterDccons();
    const query = this.state.textFilter.trim().toLowerCase();
    const isFavorites = this.state.selected === "favorites";
    const semantic = Embedding.enabled() && Boolean(query);
    const semanticResults = (this.state.semanticResults || []).filter(({con}) => {
      if (this.state.selected === "all") return true;
      if (["favorites", "recent"].includes(this.state.selected)) return loadData(this.state.selected as "favorites" | "recent", []).some(item => item.path === con.path);
      return String(con.packageIdx) === this.state.selected;
    }).slice(0, 60);
    const recent = loadData(isFavorites ? "favorites" : "recent", []).filter(con => !query || con.title.toLowerCase().includes(query));
    const select = (id: string) => {
      this.setState({ selected: id });
      this.content?.scrollTo?.({ top: 0 });
    };
    const navButton = (id: string, label: string, child: React.ReactNode) => h("button", {
      key: id, type: "button", className: "dccon-rail-button",
      title: label, "aria-label": label, "aria-pressed": this.state.selected === id,
      onClick: () => select(id),
    }, child);
    return h("div", { className: "dccon-pickerContainer" },
      h("div", { className: "dccon-header" },
        h("div", { className: "dccon-search-field" },
          h("svg", { "aria-hidden": true, width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
            h("circle", { cx: 10, cy: 10, r: 6 }), h("path", { d: "m15 15 6 6" })),
          h("input", { className: "dccon-search-input", "aria-label": "디시콘 검색", placeholder: Embedding.enabled() ? "표정이나 상황으로 검색하기" : "디시콘 이름이나 팩 검색하기",
            autoFocus: !window.matchMedia?.("(any-pointer: coarse)").matches, value: this.state.textFilter,
            onChange: e => this.changeSearch((e.target as HTMLInputElement).value),
          }),
          this.state.textFilter && h("button", { type: "button", "aria-label": "검색 지우기", onClick: this.clearSearch }, "×")
        )
      ),
      h("div", { className: "dccon-browser" },
        h("nav", { className: "dccon-rail", "aria-label": "디시콘 팩" },
          navButton("all", "전체 디시콘", h(ManduIcon)),
          navButton("recent", "최근 사용", "◷"),
          navButton("favorites", "즐겨찾기", "★"),
          h("div", { className: "dccon-rail-divider" }),
          ...this.state.dccons.map(pack => navButton(String(pack.info.package_idx), pack.info.title,
            h(PackThumbnail, { pack }))),
          h("button", { type: "button", className: "dccon-rail-button", "aria-label": "팩 추가 / 관리", title: "팩 추가 / 관리", onClick: this.props.onManage }, "+")
        ),
        h("div", { className: "dccon-browser-content", ref: element => { this.content = element as HTMLDivElement | null; } },
          semantic ? h("section", null,
            h("h3", {className: "dccon-section-title"}, "의미 기반 검색"),
            h("p", {role: "status"}, this.state.searching ? "검색 중…" : this.state.searchError || `완료된 색인에서 ${semanticResults.length}개 결과`),
            h("div", {className: "dccon-items"}, semanticResults.map(({con}) => h(DCConItem, {key: Embedding.key(con), con, packageIdx: con.packageIdx}))))
          : (this.state.selected === "recent" || isFavorites)
            ? h("section", null, h("h3", { className: "dccon-section-title" }, isFavorites ? "즐겨찾기" : "최근 사용"),
                recent.length ? h("div", { className: "dccon-items" }, recent.map(con => h(DCConItem, { key: con.idx, con, packageIdx: con.packageIdx })))
                  : h("div", { className: "dccon-empty-state", role: "status" }, query ? "검색 결과가 없습니다." : isFavorites ? "콘의 ☆ 버튼으로 즐겨찾기를 추가하세요." : "사용한 디시콘이 여기에 표시됩니다."))
            : packs.length ? packs.map(pack => h(DCConCategory, { key: pack.info.package_idx, dccon: pack }))
              : h("div", { className: "dccon-empty-state", role: "status" },
                  this.state.dccons.length ? "검색 결과가 없습니다. 다른 이름으로 검색해 보세요." : "아직 등록한 디시콘이 없습니다.",
                  !this.state.dccons.length && h("button", { type: "button", onClick: this.props.onManage }, "팩 추가하기"))
        )
      ),
      h("div", { className: "dccon-footer" }, platform.composer?.attachFiles
        ? "클릭: 입력창에 첨부 · Shift+클릭: 모아두기 · 전송은 Discord에서 직접"
        : "클릭: 누적 콘과 함께 전송 · Shift+클릭: 모아두기 (최대 9개)")
    );
  }
}

// #region Settings
// 데이터 저장/로드 유틸리티 함수들
function loadData<K extends keyof Settings>(key: K): Settings[K] | undefined;
function loadData<K extends keyof Settings>(key: K, defaultData: Settings[K]): Settings[K];
function loadData<K extends keyof Settings>(key: K, defaultData?: Settings[K]): Settings[K] | undefined {
  defaultData = structuredClone(defaultData);

  // BetterDiscord can return the cached object. Never share it with React state.
  const data = structuredClone(SharedConfig.data ? SharedConfig.data[key] : platform.data.load(key)) as Settings[K] | undefined;
  if (data == null) return defaultData;

  // 기본값 처리
  for (const k in defaultData) {
    if (data[k] == null && defaultData[k] != null) {
      data[k] = defaultData[k];
    }
  }

  return data;
}

function saveData<K extends keyof Settings>(key: K, data: Settings[K]) {
  const result = SharedConfig.data ? SharedConfig.save(key, data) : platform.data.save!(key, data);
  if (["dccons", "personalCons"].includes(key) && Embedding.enabled()) void Embedding.index();
  return result;
}

function uniquePacks(packs: Pack[]) {
  const seen = new Set();
  return packs.filter(pack => {
    const id = String(pack.info.package_idx);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function loadPacks() {
  return uniquePacks(loadData("dccons", []));
}

// 디시콘 검색 결과를 가져오는 함수
const getDCConSearchResult = (query: string) => {
  return new Promise<PackSearchResult[]>((resolve, reject) => {
    platform.net.fetch(
      encodeURI("https://dccon.dcinside.com/hot/1/title/" + query)
    )
      .then((r) => r.text())
      .then((body) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(body, "text/html");

        if (doc.getElementsByClassName("dccon_search_none").length > 0) {
          resolve([]);
          return;
        }

        const results = [...doc.getElementsByClassName("link_product")].map(
          (el) => {
            const idx = (el as HTMLAnchorElement).href.split("#")[1];
            const thumbId = (el.children[0] as HTMLImageElement).src.split("=")[1];
            const name = (el.children[1] as HTMLElement).innerText;
            const seller = (el.children[2] as HTMLElement).innerText;

            return { idx, thumbId, name, seller };
          }
        );

        resolve(results);
      })
      .catch((err) => reject(err));
  });
};

// 버튼 컴포넌트
const Button = (props: ButtonProps) => {
  return platform.react.createElement(
    "button",
    {
      type: "button",
      className: `bd-button dccon-button ${props.color || ""}`,
      onClick: props.onClick,
      disabled: props.disabled,
      style: { ...props.style },
    },
    props.text
  );
};

// 디시콘 카드 컴포넌트 (검색 결과용)
class DCConCard extends platform.react.Component<CardProps, {isAdding: boolean}> {
  declare adding: boolean;

  constructor(props: CardProps) {
    super(props);

    this.state = {
      isAdding: false,
    };
  }

  render() {
    const { item } = this.props;
    const existingDccon = this.props.savedDccons.find(
      (d) => String(d.info?.package_idx) === String(item.idx)
    );

    const strings = getLocaleStrings();

    return platform.react.createElement(
      "div",
      {
        className: "dccon-card",
      },
      platform.react.createElement(DCConImage, {
        src: `${DCConProxyURL}${item.thumbId}`,
        style: { borderRadius: "8px" },
      }),
      platform.react.createElement(
        "div",
        { className: "dccon-card-content" },
        platform.react.createElement("h3", {}, item.name),
        platform.react.createElement("span", {}, item.seller),
        platform.react.createElement(Button, {
          text: existingDccon
            ? strings.settings.added
            : this.state.isAdding
            ? strings.settings.adding
            : strings.settings.addDccon,
          disabled: existingDccon !== undefined || this.state.isAdding,
          onClick: async () => {
            if (this.adding || existingDccon) return;
            this.adding = true;
            this.setState({ isAdding: true });

            try {
              const dcconData = await getDCCon(item.idx);
              // Re-read after the request so concurrent additions cannot duplicate a pack.
              saveData("dccons", uniquePacks([...loadPacks(), dcconData]));
              warmCache(dcconData.detail);

              this.props.onAdd(dcconData);
              platform.ui.showToast("디시콘이 추가되었습니다.", {
                type: "success",
              });
            } catch (_err) { const err = _err as Failure;
              platform.logger.error("discord-dccon", "디시콘 추가 실패:", err);
              platform.ui.showToast("디시콘 추가에 실패했습니다.", {
                type: "error",
              });
            } finally {
              this.adding = false;
              this.setState({ isAdding: false });
            }
          },
          style: {
            marginTop: "auto",
            marginLeft: "auto",
          },
        })
      )
    );
  }
}

// 저장된 디시콘 카드 컴포넌트 (추가된 디시콘 관리용)
class SavedDCConCard extends platform.react.Component<SavedCardProps, Record<string, never>> {

  render() {
    const { dccon } = this.props;
    const strings = getLocaleStrings();

    return platform.react.createElement(
      "div",
      {
        className: "dccon-card",
      },
      platform.react.createElement(PackThumbnail, {
        pack: dccon,
        style: { borderRadius: "8px" },
      }),
      platform.react.createElement(
        "div",
        { className: "dccon-card-content" },
        platform.react.createElement("h3", {}, dccon.info.title),
        platform.react.createElement(
          "span",
          {},
          `${dccon.detail.length}개의 디시콘`
        ),
        platform.react.createElement("div", {className: "dccon-pack-actions"},
        platform.react.createElement("div", {className: "dccon-pack-order", role: "group", "aria-label": dccon.info.title + " 순서 조절"},
          ...([[-1, "위로", this.props.isFirst], [1, "아래로", this.props.isLast]] as const).map(([direction, label, disabled]) =>
            platform.react.createElement("button", {key: direction, type: "button", disabled,
              "aria-label": dccon.info.title + " " + label, onClick: () => this.props.onMove(direction)}, label))),
        platform.react.createElement(Button, {
          text: strings.settings.remove,
          color: "dccon-item-error",
          onClick: () => {
            const dccons = loadPacks();
            const newDccons = dccons.filter(
              (d) => String(d.info.package_idx) !== String(dccon.info.package_idx)
            );
            saveData("dccons", newDccons);
            this.props.onRemove(dccon.info.package_idx);
            platform.ui.showToast("디시콘이 제거되었습니다.", { type: "success" });
          },
          style: {
            marginLeft: "auto",
          },
        }))
      )
    );
  }
}

function inspectInstantSend() {
  if (platform.composer?.attachFiles) return {
    mode: "입력창 첨부 · 직접 전송",
    composerAvailable: platform.composer.available?.() ?? null,
    lastSendAttempt: lastSendAttempt ? structuredClone(lastSendAttempt) : "아직 첨부 시도 없음",
  };
  const report: Record<string, unknown> = platform.discord.inspect();
  report.lastSendAttempt = lastSendAttempt ? structuredClone(lastSendAttempt) : "아직 전송 시도 없음";
  return report;
}

const EMBEDDING_SPEC = "q8-image560-video6x280-v2";
function readEmbeddingVectors(saved: {spec?: string; vectors?: Record<string, unknown>} | undefined): VectorMap {
  if (!["q8-560-gif3-browser-v1", EMBEDDING_SPEC].includes(saved?.spec!) || !saved?.vectors) return {};
  return Object.fromEntries(Object.entries(saved.vectors).filter(([key, vector]) =>
    (saved.spec === EMBEDDING_SPEC || !key.endsWith(":gif")) && Array.isArray(vector) &&
    vector.length === 768 && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < 0.001)) as VectorMap;
}

// Runs in a browser Worker: no Node, native addons, or local PoC server required.

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
                const file = await getDCConImage(con);
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

class EmbeddingEnvironmentPanel extends platform.react.Component<Record<string, never>, {revision?: number}> {
  declare refresh: () => void;

  constructor(props: Record<string, never>) { super(props); this.state = {}; this.refresh = () => this.setState({revision: (this.state.revision || 0) + 1}); }
  componentDidMount() { PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
  componentWillUnmount() { PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
  render() {
    const h = platform.react.createElement;
    return h("section", {className: "dccon-embedding-environment"},
      h("h3", null, "디시콘 임베딩"),
      h("label", null, h("input", {type: "checkbox", checked: Embedding.enabled(), onChange: e => Embedding.toggle(e.target.checked)}), " 의미 기반 검색 활성화"),
      h("p", null, "활성화하면 EmbeddingGemma 2 모델(약 550 MB)을 다운로드하고 WebGPU로 이미지를 임베딩 합니다."),
      Embedding.enabled() && h("div", {className: "dccon-embedding-progress"},
        h("p", {role: "status"}, `${Embedding.status.phase} ${Embedding.status.file || ""} · ${Embedding.status.completed}/${Embedding.status.total} · 실패 ${Embedding.status.errors}`),
        h("progress", {"aria-label": "디시콘 색인 진행률", max: Math.max(1, Embedding.status.total), value: ["이미지 색인", "준비 완료", "완료 · 일부 실패", "오류", "꺼짐"].includes(Embedding.status.phase) ? Embedding.status.completed : undefined}),
        Embedding.status.error && h("p", {role: "alert"}, Embedding.status.error),
        ["오류", "꺼짐", "완료 · 일부 실패"].includes(Embedding.status.phase) && h(Button, {text: "다시 시도", onClick: () => Embedding.start()})),
      h("p", null, "모델은 공통 캐시의 models, 벡터는 vectors 아래에 보관됩니다. 비활성화 하면 작업 중단합니다."));
  }
}

// 설정 패널 컴포넌트
class DCConSettingsPanel extends platform.react.Component<{section?: string}, SettingsState> {
  declare reportInput: HTMLTextAreaElement | null;

  constructor(props: {section?: string}) {
    super(props);

    this.state = {
      activeTab: "saved",
      searchQuery: "",
      searchResults: [],
      isSearching: false,
      savedDccons: loadPacks(),
    };

    this.handleSearch = this.handleSearch.bind(this);
    this.handleTabChange = this.handleTabChange.bind(this);
  }

  async handleSearch() {
    if (this.state.searchQuery.trim() === "") return;

    this.setState({ isSearching: true });

    try {
      const results = await getDCConSearchResult(this.state.searchQuery);
      this.setState({ searchResults: results });
    } catch (_err) { const err = _err as Failure;
      platform.logger.error("discord-dccon", "디시콘 검색 실패:", err);
      platform.ui.showToast("디시콘 검색에 실패했습니다.", { type: "error" });
    }

    this.setState({ isSearching: false });
  }

  handleTabChange(tab: string) {
    this.setState({ activeTab: tab });
  }

  renderSearch() {
    const strings = getLocaleStrings();

    return platform.react.createElement(
      "div",
      { className: "dccon-search-container" },
      platform.react.createElement(
        "div",
        { className: "dccon-search-bar" },
        platform.react.createElement("input", {
          type: "text",
          placeholder: strings.settings.searchDccon,
          value: this.state.searchQuery,
          onChange: (e) => this.setState({ searchQuery: (e.target as HTMLInputElement).value }),
          onKeyDown: (e) => {
            if (e.key === "Enter") this.handleSearch();
          },
        }),
        platform.react.createElement(Button, {
          text: this.state.isSearching ? "검색 중…" : "검색",
          disabled:
            this.state.isSearching || this.state.searchQuery.trim() === "",
          onClick: this.handleSearch,
          style: { marginLeft: "8px" },
        })
      ),
      platform.react.createElement(
        "div",
        { className: "dccon-search-results" },
        this.state.searchResults.length > 0
          ? this.state.searchResults.map((result) =>
              platform.react.createElement(DCConCard, {
                key: result.idx,
                item: result,
                savedDccons: this.state.savedDccons,
                onAdd: () => {
                  this.setState({ savedDccons: loadPacks() });
                },
              })
            )
          : this.state.searchQuery !== "" && !this.state.isSearching
          ? platform.react.createElement(
              "div",
              { className: "dccon-empty-state" },
              strings.settings.noResults
            )
          : null
      )
    );
  }

  renderDiagnostics() {
    const h = platform.react.createElement;
    return h("div", { className: "dccon-diagnostics" },
      h("h3", null, "문제 해결 · 버그 제보"),
      h("p", null, "디시콘이 보내지지 않거나 오류가 발생했나요? 문제가 발생한 직후 진단 정보를 만들어 제보에 첨부해 주세요."),
      h("ol", {className: "dccon-report-steps"},
        h("li", null, "문제가 발생한 조작과 기대했던 동작을 적어 주세요."),
        h("li", null, "아래에서 진단 정보를 생성하고 복사해 주세요."),
        h("li", null, "복사한 정보와 재현 순서를 버그 제보에 함께 붙여넣어 주세요.")),
      h("p", null, "진단은 자동으로 제출되지 않으며, 메시지를 보내거나 입력 중인 내용을 변경하지 않습니다."),
      h(Button, { text: this.state.diagnosticReport ? "진단 정보 새로고침" : "진단 정보 만들기", onClick: () => {
        const report = inspectInstantSend();
        this.setState({ diagnosticReport: JSON.stringify({ pluginVersion: "4.0.0-beta.2", generatedAt: new Date().toISOString(), ...report }, null, 2),
          copyStatus: "" });
      } }),
      this.state.diagnosticReport && h("div", null,
        h("textarea", { className: "dccon-diagnostic-report", "aria-label": "진단 결과", readOnly: true,
          value: this.state.diagnosticReport, ref: element => { this.reportInput = element as HTMLTextAreaElement | null; }, onFocus: event => (event.target as HTMLTextAreaElement).select(),
        }),
        h(Button, { text: "제보용 정보 복사", onClick: async () => {
          this.reportInput?.focus();
          this.reportInput?.select();
          try {
            await navigator.clipboard.writeText(this.state.diagnosticReport!);
            this.setState({ copyStatus: "복사했습니다. 버그 제보에 재현 순서와 함께 붙여넣어 주세요." });
          } catch {
            this.setState({ copyStatus: "결과를 선택했습니다. Ctrl+C로 복사해 주세요." });
          }
        } }),
        h("p", { role: "status" }, this.state.copyStatus || "제보 전에 내용을 확인해 주세요. 계정 토큰이나 인증 정보는 추가하지 마세요.")
      )
    );
  }

  renderSaved() {
    const strings = getLocaleStrings();

    return platform.react.createElement(
      "div",
      { className: "dccon-saved-container" },
      this.state.savedDccons.length > 0
        ? this.state.savedDccons.map((dccon, index) =>
            platform.react.createElement(SavedDCConCard, {
              key: dccon.info.package_idx,
              dccon: dccon,
              isFirst: index === 0,
              isLast: index === this.state.savedDccons.length - 1,
              onMove: direction => {
                const packs = loadPacks();
                const from = packs.findIndex(pack => String(pack.info.package_idx) === String(dccon.info.package_idx));
                const to = from + direction;
                if (from < 0 || to < 0 || to >= packs.length) return;
                [packs[from], packs[to]] = [packs[to], packs[from]];
                saveData("dccons", packs);
                this.setState({savedDccons: packs});
              },
              onRemove: () => {
                this.setState({ savedDccons: loadPacks() });
              },
            })
          )
        : platform.react.createElement(
            "div",
            { className: "dccon-empty-state" },
            "추가된 디시콘이 없습니다. '디시콘샵' 탭에서 디시콘을 추가해보세요."
          )
    );
  }

  render() {
    const h = platform.react.createElement;
    if (this.props.section === "settings") {
      return h("div", {className: "dccon-settings-panel dccon-user-settings"},
        h(EmbeddingEnvironmentPanel), this.renderDiagnostics());
    }
    return h("div", {className: "dccon-settings-panel"},
      h("div", {className: "dccon-tab-menu"},
        ...[["saved", "내 디시콘"], ["shop", "디시콘샵"], ["personal", "개별 콘"]].map(([tab, label]) => h("button", {
          key: tab, type: "button", className: "dccon-tab-item " + (this.state.activeTab === tab ? "active" : ""),
          onClick: () => this.handleTabChange(tab),
        }, label))),
      h("div", {className: "dccon-tab-content"}, this.state.activeTab === "saved" ? this.renderSaved() : this.state.activeTab === "personal" ? h(PersonalConManager) : this.renderSearch()));
  }

}
// #endregion

// 메인 플러그인 클래스
class DCCon {
  declare meta: PluginMeta;
  declare strings: ReturnType<typeof getLocaleStrings>;
  declare startGeneration: number;
  declare startError: Failure | null;
  declare startPromise?: Promise<void>;
  declare unmountToolbar: (() => void) | null;
  declare localeListener: (() => void) | null;
  constructor(meta: PluginMeta) {
    this.meta = meta;
    this.strings = getLocaleStrings();
    this.startGeneration = 0;
  }

  getSettingsPanel() {
    if (platform.cacheAvailable() && !SharedConfig.data)
      return platform.react.createElement("div", null, this.startError ? "설정 읽기 실패: " + this.startError.message : "공통 설정을 불러오는 중입니다.");
    return platform.react.createElement(DCConSettingsPanel, {section: "settings"});
  }

  start() {
    const generation = ++this.startGeneration;
    this.startError = null;
    if (!platform.config && !platform.cacheAvailable()) return this.startReady();
    this.startPromise = (async () => {
      try {await SharedConfig.open();}
      catch (_error) { const error = _error as Failure;
        this.startError = error;
        platform.logger.error("discord-dccon", "Configuration migration failed", error);
        platform.ui.showToast("설정 이전 실패: " + error.message + " · 다음 시작에 재시도합니다.", {type: "error", timeout: 10000});
        return;
      }
      if (generation === this.startGeneration) this.startReady();
    })().catch(error => {
      platform.logger.error("discord-dccon", "Plugin startup failed", error);
      platform.ui.showToast("디시콘 시작 실패: " + error.message, {type: "error", timeout: 10000});
    });
    return this.startPromise;
  }

  startReady() {


    // 기존 데이터 초기화
    if (loadData("dccons") === undefined) {
      saveData("dccons", []);
    }
    const savedPacks = loadData("dccons", []);
    const repairedPacks = uniquePacks(savedPacks);
    if (savedPacks.length !== repairedPacks.length) {
      if (loadData("dcconsBeforeDedup") === undefined) {
        saveData("dcconsBeforeDedup", savedPacks);
      }
      saveData("dccons", repairedPacks);
    }

    if (loadData("recent") === undefined) {
      saveData("recent", []);
    }


    warmCache(repairedPacks.flatMap(pack => pack.detail));
    if (Embedding.enabled()) void Embedding.start();
    this.unmountToolbar = mountToolbar(DCConButton);


    platform.styles.add(this.meta.name, this.css);

    // 언어 변경 리스너 추가
    this.localeListener = () => {this.strings = getLocaleStrings();};
    LocaleStore.addChangeListener(this.localeListener);
  }

  stop() {
    this.startGeneration++;
    cacheGeneration++;
    bufferGeneration++;
    queuedCons.clear();
    if (this.localeListener) LocaleStore.removeChangeListener?.(this.localeListener);
    this.localeListener = null;
    Embedding.stop();
    WebPCache.stop();
    this.unmountToolbar?.();
    this.unmountToolbar = null;
    PluginEvents.dispatch({ type: "DCCON_UNPATCH_ALL" });
    platform.styles.remove(this.meta.name);
  }

  get css() { return styles; }
}

return DCCon;
}
