/**
 * @name discord-dccon
 * @description 디스코드에서 디시콘을 쉽게 사용할 수 있게 도와주는 플러그인입니다.
 * @version 3.5.1
 * @author 80ROkWOC4j
 * @website https://github.com/80ROkWOC4j/discord-dccon
 * @source https://github.com/80ROkWOC4j/discord-dccon
 * @authorLink https://github.com/80ROkWOC4j
 */

// Derived from DCCon2 by minibox (Discord author ID: 310247242546151434).
// Original repository: https://github.com/minibox24/DCCon2 (no longer available).
// Modified version maintained by 80ROkWOC4j; modified on 2026-10-08.
// Distributed under GNU GPL version 3; see LICENSE. Original attribution retained.
// Reference: https://github.com/Dastan21/BDAddons/blob/main/plugins/FavoriteMedia/FavoriteMedia.plugin.js

/* global BdApi */

const DCConBaseURL = "https://dcimg5.dcinside.com/dccon.php?no=";
const DCConProxyURL = "https://dccon-proxy.minibox.workers.dev/?no=";

const ManduIcon = (props) => {
  const size = props.size || "24px";

  return BdApi.React.createElement(
    "svg",
    {
      viewBox: "0 0 512 512",
      className: classes.icon.icon,
      "aria-hidden": "false",
      width: size,
      height: size,
    },
    BdApi.React.createElement("path", {
      transform: "translate(0,512) scale(0.1,-0.1)",
      fill: "currentColor",
      d: "M2490 4778 c-142 -20 -270 -116 -332 -248 -30 -65 -35 -70 -58 -65 -60 14 -195 17 -249 5 -179 -39 -278 -147 -360 -391 -26 -79 -30 -85 -72 -108 -341 -182 -501 -295 -723 -511 -340 -331 -569 -722 -654 -1120 -91 -420 -29 -784 190 -1112 74 -111 257 -298 373 -380 480 -339 1130 -509 1955 -509 733 0 1322 133 1785 401 148 86 244 159 365 280 169 167 278 341 344 545 119 368 71 803 -133 1220 -126 255 -278 462 -497 675 -222 216 -383 329 -723 511 -44 23 -45 26 -82 137 -21 63 -50 134 -65 159 -53 91 -150 164 -263 199 -56 18 -182 19 -245 3 -26 -6 -48 -10 -49 -8 -2 2 -18 35 -36 72 -61 126 -192 226 -316 242 -27 3 -59 7 -70 9 -11 2 -49 -1 -85 -6z m-470 -1163 c62 -32 92 -105 72 -174 -17 -55 -364 -396 -409 -403 -111 -16 -198 72 -178 179 6 32 32 64 173 207 92 92 181 177 197 187 36 23 105 25 145 4z m621 -8 c64 -42 70 -68 67 -284 -3 -177 -5 -194 -24 -220 -47 -63 -132 -84 -195 -47 -70 41 -74 54 -77 267 -2 168 0 196 15 227 26 50 76 80 133 80 32 0 58 -7 81 -23z m597 9 c15 -8 104 -92 199 -188 187 -189 198 -207 174 -288 -13 -45 -69 -96 -112 -102 -74 -11 -86 -4 -276 185 -192 189 -211 216 -200 284 8 46 30 79 70 103 38 24 106 26 145 6z",
    })
  );
};

// These events are private to discord-dccon; no Discord dispatcher is needed.
const eventListeners = new Map();
const PluginEvents = {
  subscribe(type, listener) {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type).add(listener);
  },
  unsubscribe(type, listener) {
    const listeners = eventListeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) eventListeners.delete(type);
  },
  dispatch(event) {
    for (const listener of [...(eventListeners.get(event.type) ?? [])]) {
      listener(event);
    }
  },
};
const LocaleStore = BdApi.Webpack.getByKeys("locale", "initialize");

const classes = {
  icon: BdApi.Webpack.getByKeys("icon", "active", "buttonWrapper") ?? {},
  textarea: BdApi.Webpack.getByKeys("channelTextArea", "buttonContainer", "button") ?? {},
};

let currentChannelId = "";

// Both installations mount the picker beside the native composer controls.
function mountToolbar(Button) {
  const roots = new Map();
  const store = BdApi.Webpack.getStore("SelectedChannelStore");
  let pending = false, stopped = false;
  function channelFor(editor) {
    for (let fiber = BdApi.ReactUtils.getInternalInstance(editor); fiber; fiber = fiber.return) {
      const channel = fiber.memoizedProps?.channel;
      if (channel?.id) return channel.id;
    }
    return store?.getChannelId?.();
  }
  function update() {
    pending = false;
    if (stopped) return;
    const active = new Set();
    for (const editor of document.querySelectorAll('[role="textbox"][contenteditable="true"]')) {
      const composer = editor.closest('[class*="channelTextArea"]');
      const toolbar = composer?.querySelector('[class*="buttons_"]');
      const channelId = channelFor(editor);
      if (!toolbar || !channelId) continue;
      active.add(toolbar);
      let entry = roots.get(toolbar);
      if (entry && !toolbar.contains(entry.host)) {
        entry.root.unmount(); roots.delete(toolbar); entry = null;
      }
      if (!entry) {
        const host = document.createElement("div");
        host.className = "dccon-toolbar-host";
        host.style.cssText = "display:flex;align-items:center;flex:0 0 auto";
        toolbar.append(host);
        entry = {host, root: BdApi.ReactDOM.createRoot(host)};
        roots.set(toolbar, entry);
      }
      if (entry.channelId !== channelId) {
        entry.channelId = channelId;
        entry.root.render(BdApi.React.createElement(Button, {channelId}));
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
  store?.addChangeListener(schedule);
  update();
  return () => {
    stopped = true; observer.disconnect(); store?.removeChangeListener(schedule);
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
  return translations[language] || translations.en;
}

// 디시콘 API 관련 함수
const getDCCon = (idx) => {
  return new Promise((resolve, reject) => {
    BdApi.Net.fetch("https://dccon.dcinside.com/index/package_detail", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: `package_idx=${idx}`,
    })
      .then((r) => r.text())
      .then((body) => {
        const original = JSON.parse(body);

        const info = {
          package_idx: original.info.package_idx,
          title: original.info.title,
          main_img_path: original.info.main_img_path,
          list_img_path: original.info.list_img_path,
        };

        const detail = original.detail.map((x) => {
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
class DCConButton extends BdApi.React.Component {
  constructor(props) {
    super(props);
    this.state = { active: false, page: "picker", left: 0, top: 0, height: 480 };
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
    window.addEventListener("resize", this.close);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  componentDidUpdate(previousProps) {
    if (previousProps.channelId !== this.props.channelId) this.close();
  }

  componentWillUnmount() {
    PluginEvents.unsubscribe("DCCON_CLOSE", this.close);
    PluginEvents.unsubscribe("DCCON_UNPATCH_ALL", this.close);
    PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refreshBuffer);
    window.removeEventListener("resize", this.close);
    document.removeEventListener("keydown", this.onKeyDown, true);
  }

  close(event) {
    if (event?.channelId && event.channelId !== this.props.channelId) return;
    if (this.state.active) this.setState({ active: false });
  }

  toggle(event) {
    if (this.state.active) return this.close();
    PluginEvents.dispatch({ type: "DCCON_CLOSE" });
    currentChannelId = this.props.channelId;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 16);
    const height = Math.min(540, window.innerHeight - 16);
    this.setState({
      active: true,
      page: "picker",
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, rect.top - height - 8),
      height,
    });
  }

  render() {
    const h = BdApi.React.createElement;
    const expanded = this.state.page === "picker" && activeQueue(this.props.channelId).length > 0;
    const width = this.state.active ? Math.min(expanded ? 780 : 520, window.innerWidth - 16) : 520;
    return h("div", { className: (classes.textarea.buttonContainer ?? "") + " dccon-buttonContainer" },
      h("button", {
        type: "button",
        className: "dccon-button dccon-trigger",
        "aria-label": "디시콘",
        "aria-haspopup": "dialog",
        "aria-expanded": this.state.active,
        ref: (button) => { this.button = button; },
        onClick: (event) => this.toggle(event),
      }, h(ManduIcon)),
      this.state.active && BdApi.ReactDOM.createPortal(
        h("div", { className: "dccon-overlay", onMouseDown: this.close },
          h("section", {
            className: "dccon-popover" + (expanded ? " dccon-popover-expanded" : ""),
            role: "dialog",
            "aria-label": "디시콘 선택",
            style: { left: Math.max(8, this.state.left - (expanded ? 260 : 0)), top: this.state.top, height: this.state.height, width },
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
function personalFile(con) {
  if (!/^personal:[a-f0-9]{64}$/.test(con.path)) throw Error("개별 콘 파일 정보가 올바르지 않습니다.");
  return require("path").join(BdApi.Plugins.folder, "discord-dccon-library", con.path.slice(9));
}
function imageFS(method, ...args) {
  return new Promise((resolve, reject) => require("fs")[method](...args,
    (error, value) => error ? reject(error) : resolve(value)));
}
function personalCons() { return loadData("personalCons", []); }
function pickerPacks() {
  const packs = loadPacks(), detail = personalCons();
  return detail.length ? [{info: {package_idx: PERSONAL_PACK, title: "개별 콘"}, detail}, ...packs] : packs;
}
function personalURL(text) {
  let url;
  try { url = new URL(text.trim()); } catch { throw Error("디시콘 또는 아카콘 이미지 링크를 입력해 주세요."); }
  const dc = /^dcimg\d*\.dcinside\.com$/.test(url.hostname) && url.pathname === "/dccon.php" && /^[a-f0-9]+$/i.test(url.searchParams.get("no") || "");
  const arca = url.hostname === "ac.arca.live";
  if (url.protocol !== "https:" || url.username || url.password || url.port || (!dc && !arca))
    throw Error("디시콘(dcimg*.dcinside.com) 또는 아카콘(ac.arca.live) 이미지 링크만 추가할 수 있습니다.");
  url.hash = "";
  return url;
}
async function personalVideo(bytes, signal) {
  const video = document.createElement("video"), canvas = document.createElement("canvas");
  const source = URL.createObjectURL(new Blob([bytes], {type: "video/mp4"}));
  const wait = (event, start) => new Promise((resolve, reject) => {
    let eventReady = false, frameReady = false;
    const finish = error => {
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
    const context = canvas.getContext("2d"), frames = [], count = Math.ceil(video.duration * 30);
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw Error("추가가 취소되었습니다.");
      if (i) await wait("seeked", () => {video.currentTime = i / 30;});
      context.drawImage(video, 0, 0);
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!png) throw Error("영상 프레임을 읽지 못했습니다.");
      frames.push({bytes: new Uint8Array(await png.arrayBuffer()), duration: Math.max(1,
        Math.round(Math.min((i + 1) / 30, video.duration) * 1000) - Math.round(i / 30 * 1000))});
    }
    const result = await WebPCache.convert(new Uint8Array(), frames);
    if (signal?.aborted) throw Error("추가가 취소되었습니다.");
    return result;
  } finally {video.removeAttribute("src"); video.load(); URL.revokeObjectURL(source);}
}
async function preparePersonalCon(text, signal) {
  let url = personalURL(text);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (signal?.aborted) throw Error("추가가 취소되었습니다.");
    response = await BdApi.Net.fetch(url.href, {responseType: "arraybuffer", redirect: "manual", signal,
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
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const ext = starts(137,80,78,71,13,10,26,10) ? "png" : starts(71,73,70,56) ? "gif"
    : starts(255,216,255) ? "jpg" : starts(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? "webp"
    : String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" ? "mp4" : null;
  if (!ext) throw Error("PNG, JPEG, GIF, WebP 또는 MP4 콘만 추가할 수 있습니다.");
  const file = ext === "mp4" ? webpFile(await personalVideo(bytes, signal))
    : new File([bytes], `discord-dccon.${ext}`, {type: ext === "jpg" ? "image/jpeg" : `image/${ext}`});
  const bitmap = await createImageBitmap(file);
  bitmap.close();
  if (signal?.aborted) throw Error("추가가 취소되었습니다.");
  const hash = require("crypto").createHash("sha256").update(bytes).digest("hex");
  return {file, con: {idx: "personal-" + hash, path: "personal:" + hash, ext, title: "개별 콘", packageIdx: PERSONAL_PACK}};
}
async function storePersonalCon(prepared, title, signal) {
  const {con, file} = prepared;
  if (personalCons().some(item => item.path === con.path)) throw Error("이미 등록된 콘입니다.");
  const target = personalFile(con);
  await imageFS("mkdir", require("path").dirname(target), {recursive: true});
  const bytes = await WebPCache.convert(new Uint8Array(await file.arrayBuffer()));
  if (signal?.aborted) throw Error("추가가 취소되었습니다.");
  await imageFS("writeFile", target + ".tmp", bytes);
  await imageFS("rename", target + ".tmp", target);
  // Re-read after disk IO so simultaneous saves cannot overwrite another entry.
  const items = personalCons();
  if (items.some(item => item.path === con.path)) throw Error("이미 등록된 콘입니다.");
  saveData("personalCons", [...items, {...con, title: title.trim() || `개별 콘 ${items.length + 1}`}]);
  PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
}
async function removePersonalCon(con) {
  if ([...sendingChannels].some(channel => activeQueue(channel).some(entry => entry.con.path === con.path)))
    throw Error("전송 중인 콘은 잠시 후 제거해 주세요.");
  try { await imageFS("unlink", personalFile(con)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  saveData("personalCons", personalCons().filter(item => item.path !== con.path));
  for (const key of ["favorites", "recent"]) saveData(key, loadData(key, []).filter(item => item.path !== con.path));
  for (const [channel, entries] of queuedCons) updateQueue(channel, entries.filter(entry => entry.con.path !== con.path));
  PluginEvents.dispatch({type: "DCCON_PERSONAL_UPDATE"});
  PluginEvents.dispatch({type: "DCCON_FAVORITES_UPDATE"});
  PluginEvents.dispatch({type: "DCCON_RECENT_UPDATE"});
}

// Disk cache uses hashed names so remote paths never become filesystem paths.
function isWebP(bytes) {
  return bytes.length >= 20 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}
function webpFile(bytes) {
  const animated = isWebP(bytes) && bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(12, 16)) === "VP8X" && (bytes[20] & 0x02) !== 0;
  return new File([bytes], animated ? "dccon.webp" : "dccon.gif", {type: "image/webp"});
}

// BEGIN GENERATED SPLIT WORKER
const SPLIT_WORKER_SOURCE = "var Gi=Object.create;var ei=Object.defineProperty;var Qi=Object.getOwnPropertyDescriptor;var Ji=Object.getOwnPropertyNames;var Ki=Object.getPrototypeOf,Zi=Object.prototype.hasOwnProperty;var St=(r=>typeof require<\"u\"?require:typeof Proxy<\"u\"?new Proxy(r,{get:(t,e)=>(typeof require<\"u\"?require:t)[e]}):r)(function(r){if(typeof require<\"u\")return require.apply(this,arguments);throw Error('Dynamic require of \"'+r+'\" is not supported')});var ea=(r,t,e)=>()=>{if(e)throw e[0];try{return r&&(t=r(r=0)),t}catch(n){throw e=[n],n}};var tt=(r,t)=>()=>{try{return t||r((t={exports:{}}).exports,t),t.exports}catch(e){throw t=0,e}};var ta=(r,t,e,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of Ji(t))!Zi.call(r,o)&&o!==e&&ei(r,o,{get:()=>t[o],enumerable:!(n=Qi(t,o))||n.enumerable});return r};var Cn=(r,t,e)=>(e=r!=null?Gi(Ki(r)):{},ta(t||!r||!r.__esModule?ei(e,\"default\",{value:r,enumerable:!0}):e,r));var ni=tt(Tr=>{\"use strict\";X();Tr.byteLength=na;Tr.toByteArray=aa;Tr.fromByteArray=ua;var Ne=[],Ae=[],ra=typeof Uint8Array<\"u\"?Uint8Array:Array,Pn=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\";for(pt=0,ti=Pn.length;pt<ti;++pt)Ne[pt]=Pn[pt],Ae[Pn.charCodeAt(pt)]=pt;var pt,ti;Ae[45]=62;Ae[95]=63;function ri(r){var t=r.length;if(t%4>0)throw new Error(\"Invalid string. Length must be a multiple of 4\");var e=r.indexOf(\"=\");e===-1&&(e=t);var n=e===t?0:4-e%4;return[e,n]}function na(r){var t=ri(r),e=t[0],n=t[1];return(e+n)*3/4-n}function ia(r,t,e){return(t+e)*3/4-e}function aa(r){var t,e=ri(r),n=e[0],o=e[1],f=new ra(ia(r,n,o)),l=0,_=o>0?n-4:n,A;for(A=0;A<_;A+=4)t=Ae[r.charCodeAt(A)]<<18|Ae[r.charCodeAt(A+1)]<<12|Ae[r.charCodeAt(A+2)]<<6|Ae[r.charCodeAt(A+3)],f[l++]=t>>16&255,f[l++]=t>>8&255,f[l++]=t&255;return o===2&&(t=Ae[r.charCodeAt(A)]<<2|Ae[r.charCodeAt(A+1)]>>4,f[l++]=t&255),o===1&&(t=Ae[r.charCodeAt(A)]<<10|Ae[r.charCodeAt(A+1)]<<4|Ae[r.charCodeAt(A+2)]>>2,f[l++]=t>>8&255,f[l++]=t&255),f}function oa(r){return Ne[r>>18&63]+Ne[r>>12&63]+Ne[r>>6&63]+Ne[r&63]}function sa(r,t,e){for(var n,o=[],f=t;f<e;f+=3)n=(r[f]<<16&16711680)+(r[f+1]<<8&65280)+(r[f+2]&255),o.push(oa(n));return o.join(\"\")}function ua(r){for(var t,e=r.length,n=e%3,o=[],f=16383,l=0,_=e-n;l<_;l+=f)o.push(sa(r,l,l+f>_?_:l+f));return n===1?(t=r[e-1],o.push(Ne[t>>2]+Ne[t<<4&63]+\"==\")):n===2&&(t=(r[e-2]<<8)+r[e-1],o.push(Ne[t>>10]+Ne[t>>4&63]+Ne[t<<2&63]+\"=\")),o.join(\"\")}});var ii=tt(An=>{X();/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */An.read=function(r,t,e,n,o){var f,l,_=o*8-n-1,A=(1<<_)-1,g=A>>1,F=-7,b=e?o-1:0,L=e?-1:1,S=r[t+b];for(b+=L,f=S&(1<<-F)-1,S>>=-F,F+=_;F>0;f=f*256+r[t+b],b+=L,F-=8);for(l=f&(1<<-F)-1,f>>=-F,F+=n;F>0;l=l*256+r[t+b],b+=L,F-=8);if(f===0)f=1-g;else{if(f===A)return l?NaN:(S?-1:1)*(1/0);l=l+Math.pow(2,n),f=f-g}return(S?-1:1)*l*Math.pow(2,f-n)};An.write=function(r,t,e,n,o,f){var l,_,A,g=f*8-o-1,F=(1<<g)-1,b=F>>1,L=o===23?Math.pow(2,-24)-Math.pow(2,-77):0,S=n?0:f-1,B=n?1:-1,W=t<0||t===0&&1/t<0?1:0;for(t=Math.abs(t),isNaN(t)||t===1/0?(_=isNaN(t)?1:0,l=F):(l=Math.floor(Math.log(t)/Math.LN2),t*(A=Math.pow(2,-l))<1&&(l--,A*=2),l+b>=1?t+=L/A:t+=L*Math.pow(2,1-b),t*A>=2&&(l++,A/=2),l+b>=F?(_=0,l=F):l+b>=1?(_=(t*A-1)*Math.pow(2,o),l=l+b):(_=t*Math.pow(2,b-1)*Math.pow(2,o),l=0));o>=8;r[e+S]=_&255,S+=B,_/=256,o-=8);for(l=l<<o|_,g+=o;g>0;r[e+S]=l&255,S+=B,l/=256,g-=8);r[e+S-B]|=W*128}});var Un=tt(Ut=>{\"use strict\";X();/*!\n * The buffer module from node.js, for the browser.\n *\n * @author   Feross Aboukhadijeh <https://feross.org>\n * @license  MIT\n */var Tn=ni(),kt=ii(),ai=typeof Symbol==\"function\"&&typeof Symbol.for==\"function\"?Symbol.for(\"nodejs.util.inspect.custom\"):null;Ut.Buffer=y;Ut.SlowBuffer=pa;Ut.INSPECT_MAX_BYTES=50;var xr=2147483647;Ut.kMaxLength=xr;y.TYPED_ARRAY_SUPPORT=fa();!y.TYPED_ARRAY_SUPPORT&&typeof console<\"u\"&&typeof console.error==\"function\"&&console.error(\"This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support.\");function fa(){try{let r=new Uint8Array(1),t={foo:function(){return 42}};return Object.setPrototypeOf(t,Uint8Array.prototype),Object.setPrototypeOf(r,t),r.foo()===42}catch{return!1}}Object.defineProperty(y.prototype,\"parent\",{enumerable:!0,get:function(){if(y.isBuffer(this))return this.buffer}});Object.defineProperty(y.prototype,\"offset\",{enumerable:!0,get:function(){if(y.isBuffer(this))return this.byteOffset}});function ze(r){if(r>xr)throw new RangeError('The value \"'+r+'\" is invalid for option \"size\"');let t=new Uint8Array(r);return Object.setPrototypeOf(t,y.prototype),t}function y(r,t,e){if(typeof r==\"number\"){if(typeof t==\"string\")throw new TypeError('The \"string\" argument must be of type string. Received type number');return Sn(r)}return fi(r,t,e)}y.poolSize=8192;function fi(r,t,e){if(typeof r==\"string\")return ha(r,t);if(ArrayBuffer.isView(r))return ca(r);if(r==null)throw new TypeError(\"The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type \"+typeof r);if(We(r,ArrayBuffer)||r&&We(r.buffer,ArrayBuffer)||typeof SharedArrayBuffer<\"u\"&&(We(r,SharedArrayBuffer)||r&&We(r.buffer,SharedArrayBuffer)))return Fn(r,t,e);if(typeof r==\"number\")throw new TypeError('The \"value\" argument must not be of type number. Received type number');let n=r.valueOf&&r.valueOf();if(n!=null&&n!==r)return y.from(n,t,e);let o=da(r);if(o)return o;if(typeof Symbol<\"u\"&&Symbol.toPrimitive!=null&&typeof r[Symbol.toPrimitive]==\"function\")return y.from(r[Symbol.toPrimitive](\"string\"),t,e);throw new TypeError(\"The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type \"+typeof r)}y.from=function(r,t,e){return fi(r,t,e)};Object.setPrototypeOf(y.prototype,Uint8Array.prototype);Object.setPrototypeOf(y,Uint8Array);function li(r){if(typeof r!=\"number\")throw new TypeError('\"size\" argument must be of type number');if(r<0)throw new RangeError('The value \"'+r+'\" is invalid for option \"size\"')}function la(r,t,e){return li(r),r<=0?ze(r):t!==void 0?typeof e==\"string\"?ze(r).fill(t,e):ze(r).fill(t):ze(r)}y.alloc=function(r,t,e){return la(r,t,e)};function Sn(r){return li(r),ze(r<0?0:Rn(r)|0)}y.allocUnsafe=function(r){return Sn(r)};y.allocUnsafeSlow=function(r){return Sn(r)};function ha(r,t){if((typeof t!=\"string\"||t===\"\")&&(t=\"utf8\"),!y.isEncoding(t))throw new TypeError(\"Unknown encoding: \"+t);let e=hi(r,t)|0,n=ze(e),o=n.write(r,t);return o!==e&&(n=n.slice(0,o)),n}function xn(r){let t=r.length<0?0:Rn(r.length)|0,e=ze(t);for(let n=0;n<t;n+=1)e[n]=r[n]&255;return e}function ca(r){if(We(r,Uint8Array)){let t=new Uint8Array(r);return Fn(t.buffer,t.byteOffset,t.byteLength)}return xn(r)}function Fn(r,t,e){if(t<0||r.byteLength<t)throw new RangeError('\"offset\" is outside of buffer bounds');if(r.byteLength<t+(e||0))throw new RangeError('\"length\" is outside of buffer bounds');let n;return t===void 0&&e===void 0?n=new Uint8Array(r):e===void 0?n=new Uint8Array(r,t):n=new Uint8Array(r,t,e),Object.setPrototypeOf(n,y.prototype),n}function da(r){if(y.isBuffer(r)){let t=Rn(r.length)|0,e=ze(t);return e.length===0||r.copy(e,0,0,t),e}if(r.length!==void 0)return typeof r.length!=\"number\"||Bn(r.length)?ze(0):xn(r);if(r.type===\"Buffer\"&&Array.isArray(r.data))return xn(r.data)}function Rn(r){if(r>=xr)throw new RangeError(\"Attempt to allocate Buffer larger than maximum size: 0x\"+xr.toString(16)+\" bytes\");return r|0}function pa(r){return+r!=r&&(r=0),y.alloc(+r)}y.isBuffer=function(t){return t!=null&&t._isBuffer===!0&&t!==y.prototype};y.compare=function(t,e){if(We(t,Uint8Array)&&(t=y.from(t,t.offset,t.byteLength)),We(e,Uint8Array)&&(e=y.from(e,e.offset,e.byteLength)),!y.isBuffer(t)||!y.isBuffer(e))throw new TypeError('The \"buf1\", \"buf2\" arguments must be one of type Buffer or Uint8Array');if(t===e)return 0;let n=t.length,o=e.length;for(let f=0,l=Math.min(n,o);f<l;++f)if(t[f]!==e[f]){n=t[f],o=e[f];break}return n<o?-1:o<n?1:0};y.isEncoding=function(t){switch(String(t).toLowerCase()){case\"hex\":case\"utf8\":case\"utf-8\":case\"ascii\":case\"latin1\":case\"binary\":case\"base64\":case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return!0;default:return!1}};y.concat=function(t,e){if(!Array.isArray(t))throw new TypeError('\"list\" argument must be an Array of Buffers');if(t.length===0)return y.alloc(0);let n;if(e===void 0)for(e=0,n=0;n<t.length;++n)e+=t[n].length;let o=y.allocUnsafe(e),f=0;for(n=0;n<t.length;++n){let l=t[n];if(We(l,Uint8Array))f+l.length>o.length?(y.isBuffer(l)||(l=y.from(l)),l.copy(o,f)):Uint8Array.prototype.set.call(o,l,f);else if(y.isBuffer(l))l.copy(o,f);else throw new TypeError('\"list\" argument must be an Array of Buffers');f+=l.length}return o};function hi(r,t){if(y.isBuffer(r))return r.length;if(ArrayBuffer.isView(r)||We(r,ArrayBuffer))return r.byteLength;if(typeof r!=\"string\")throw new TypeError('The \"string\" argument must be one of type string, Buffer, or ArrayBuffer. Received type '+typeof r);let e=r.length,n=arguments.length>2&&arguments[2]===!0;if(!n&&e===0)return 0;let o=!1;for(;;)switch(t){case\"ascii\":case\"latin1\":case\"binary\":return e;case\"utf8\":case\"utf-8\":return In(r).length;case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return e*2;case\"hex\":return e>>>1;case\"base64\":return _i(r).length;default:if(o)return n?-1:In(r).length;t=(\"\"+t).toLowerCase(),o=!0}}y.byteLength=hi;function ga(r,t,e){let n=!1;if((t===void 0||t<0)&&(t=0),t>this.length||((e===void 0||e>this.length)&&(e=this.length),e<=0)||(e>>>=0,t>>>=0,e<=t))return\"\";for(r||(r=\"utf8\");;)switch(r){case\"hex\":return Aa(this,t,e);case\"utf8\":case\"utf-8\":return di(this,t,e);case\"ascii\":return Ca(this,t,e);case\"latin1\":case\"binary\":return Pa(this,t,e);case\"base64\":return Ea(this,t,e);case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return Ta(this,t,e);default:if(n)throw new TypeError(\"Unknown encoding: \"+r);r=(r+\"\").toLowerCase(),n=!0}}y.prototype._isBuffer=!0;function gt(r,t,e){let n=r[t];r[t]=r[e],r[e]=n}y.prototype.swap16=function(){let t=this.length;if(t%2!==0)throw new RangeError(\"Buffer size must be a multiple of 16-bits\");for(let e=0;e<t;e+=2)gt(this,e,e+1);return this};y.prototype.swap32=function(){let t=this.length;if(t%4!==0)throw new RangeError(\"Buffer size must be a multiple of 32-bits\");for(let e=0;e<t;e+=4)gt(this,e,e+3),gt(this,e+1,e+2);return this};y.prototype.swap64=function(){let t=this.length;if(t%8!==0)throw new RangeError(\"Buffer size must be a multiple of 64-bits\");for(let e=0;e<t;e+=8)gt(this,e,e+7),gt(this,e+1,e+6),gt(this,e+2,e+5),gt(this,e+3,e+4);return this};y.prototype.toString=function(){let t=this.length;return t===0?\"\":arguments.length===0?di(this,0,t):ga.apply(this,arguments)};y.prototype.toLocaleString=y.prototype.toString;y.prototype.equals=function(t){if(!y.isBuffer(t))throw new TypeError(\"Argument must be a Buffer\");return this===t?!0:y.compare(this,t)===0};y.prototype.inspect=function(){let t=\"\",e=Ut.INSPECT_MAX_BYTES;return t=this.toString(\"hex\",0,e).replace(/(.{2})/g,\"$1 \").trim(),this.length>e&&(t+=\" ... \"),\"<Buffer \"+t+\">\"};ai&&(y.prototype[ai]=y.prototype.inspect);y.prototype.compare=function(t,e,n,o,f){if(We(t,Uint8Array)&&(t=y.from(t,t.offset,t.byteLength)),!y.isBuffer(t))throw new TypeError('The \"target\" argument must be one of type Buffer or Uint8Array. Received type '+typeof t);if(e===void 0&&(e=0),n===void 0&&(n=t?t.length:0),o===void 0&&(o=0),f===void 0&&(f=this.length),e<0||n>t.length||o<0||f>this.length)throw new RangeError(\"out of range index\");if(o>=f&&e>=n)return 0;if(o>=f)return-1;if(e>=n)return 1;if(e>>>=0,n>>>=0,o>>>=0,f>>>=0,this===t)return 0;let l=f-o,_=n-e,A=Math.min(l,_),g=this.slice(o,f),F=t.slice(e,n);for(let b=0;b<A;++b)if(g[b]!==F[b]){l=g[b],_=F[b];break}return l<_?-1:_<l?1:0};function ci(r,t,e,n,o){if(r.length===0)return-1;if(typeof e==\"string\"?(n=e,e=0):e>2147483647?e=2147483647:e<-2147483648&&(e=-2147483648),e=+e,Bn(e)&&(e=o?0:r.length-1),e<0&&(e=r.length+e),e>=r.length){if(o)return-1;e=r.length-1}else if(e<0)if(o)e=0;else return-1;if(typeof t==\"string\"&&(t=y.from(t,n)),y.isBuffer(t))return t.length===0?-1:oi(r,t,e,n,o);if(typeof t==\"number\")return t=t&255,typeof Uint8Array.prototype.indexOf==\"function\"?o?Uint8Array.prototype.indexOf.call(r,t,e):Uint8Array.prototype.lastIndexOf.call(r,t,e):oi(r,[t],e,n,o);throw new TypeError(\"val must be string, number or Buffer\")}function oi(r,t,e,n,o){let f=1,l=r.length,_=t.length;if(n!==void 0&&(n=String(n).toLowerCase(),n===\"ucs2\"||n===\"ucs-2\"||n===\"utf16le\"||n===\"utf-16le\")){if(r.length<2||t.length<2)return-1;f=2,l/=2,_/=2,e/=2}function A(F,b){return f===1?F[b]:F.readUInt16BE(b*f)}let g;if(o){let F=-1;for(g=e;g<l;g++)if(A(r,g)===A(t,F===-1?0:g-F)){if(F===-1&&(F=g),g-F+1===_)return F*f}else F!==-1&&(g-=g-F),F=-1}else for(e+_>l&&(e=l-_),g=e;g>=0;g--){let F=!0;for(let b=0;b<_;b++)if(A(r,g+b)!==A(t,b)){F=!1;break}if(F)return g}return-1}y.prototype.includes=function(t,e,n){return this.indexOf(t,e,n)!==-1};y.prototype.indexOf=function(t,e,n){return ci(this,t,e,n,!0)};y.prototype.lastIndexOf=function(t,e,n){return ci(this,t,e,n,!1)};function wa(r,t,e,n){e=Number(e)||0;let o=r.length-e;n?(n=Number(n),n>o&&(n=o)):n=o;let f=t.length;n>f/2&&(n=f/2);let l;for(l=0;l<n;++l){let _=parseInt(t.substr(l*2,2),16);if(Bn(_))return l;r[e+l]=_}return l}function ya(r,t,e,n){return Fr(In(t,r.length-e),r,e,n)}function ma(r,t,e,n){return Fr(Sa(t),r,e,n)}function va(r,t,e,n){return Fr(_i(t),r,e,n)}function _a(r,t,e,n){return Fr(Ra(t,r.length-e),r,e,n)}y.prototype.write=function(t,e,n,o){if(e===void 0)o=\"utf8\",n=this.length,e=0;else if(n===void 0&&typeof e==\"string\")o=e,n=this.length,e=0;else if(isFinite(e))e=e>>>0,isFinite(n)?(n=n>>>0,o===void 0&&(o=\"utf8\")):(o=n,n=void 0);else throw new Error(\"Buffer.write(string, encoding, offset[, length]) is no longer supported\");let f=this.length-e;if((n===void 0||n>f)&&(n=f),t.length>0&&(n<0||e<0)||e>this.length)throw new RangeError(\"Attempt to write outside buffer bounds\");o||(o=\"utf8\");let l=!1;for(;;)switch(o){case\"hex\":return wa(this,t,e,n);case\"utf8\":case\"utf-8\":return ya(this,t,e,n);case\"ascii\":case\"latin1\":case\"binary\":return ma(this,t,e,n);case\"base64\":return va(this,t,e,n);case\"ucs2\":case\"ucs-2\":case\"utf16le\":case\"utf-16le\":return _a(this,t,e,n);default:if(l)throw new TypeError(\"Unknown encoding: \"+o);o=(\"\"+o).toLowerCase(),l=!0}};y.prototype.toJSON=function(){return{type:\"Buffer\",data:Array.prototype.slice.call(this._arr||this,0)}};function Ea(r,t,e){return t===0&&e===r.length?Tn.fromByteArray(r):Tn.fromByteArray(r.slice(t,e))}function di(r,t,e){e=Math.min(r.length,e);let n=[],o=t;for(;o<e;){let f=r[o],l=null,_=f>239?4:f>223?3:f>191?2:1;if(o+_<=e){let A,g,F,b;switch(_){case 1:f<128&&(l=f);break;case 2:A=r[o+1],(A&192)===128&&(b=(f&31)<<6|A&63,b>127&&(l=b));break;case 3:A=r[o+1],g=r[o+2],(A&192)===128&&(g&192)===128&&(b=(f&15)<<12|(A&63)<<6|g&63,b>2047&&(b<55296||b>57343)&&(l=b));break;case 4:A=r[o+1],g=r[o+2],F=r[o+3],(A&192)===128&&(g&192)===128&&(F&192)===128&&(b=(f&15)<<18|(A&63)<<12|(g&63)<<6|F&63,b>65535&&b<1114112&&(l=b))}}l===null?(l=65533,_=1):l>65535&&(l-=65536,n.push(l>>>10&1023|55296),l=56320|l&1023),n.push(l),o+=_}return ba(n)}var si=4096;function ba(r){let t=r.length;if(t<=si)return String.fromCharCode.apply(String,r);let e=\"\",n=0;for(;n<t;)e+=String.fromCharCode.apply(String,r.slice(n,n+=si));return e}function Ca(r,t,e){let n=\"\";e=Math.min(r.length,e);for(let o=t;o<e;++o)n+=String.fromCharCode(r[o]&127);return n}function Pa(r,t,e){let n=\"\";e=Math.min(r.length,e);for(let o=t;o<e;++o)n+=String.fromCharCode(r[o]);return n}function Aa(r,t,e){let n=r.length;(!t||t<0)&&(t=0),(!e||e<0||e>n)&&(e=n);let o=\"\";for(let f=t;f<e;++f)o+=ka[r[f]];return o}function Ta(r,t,e){let n=r.slice(t,e),o=\"\";for(let f=0;f<n.length-1;f+=2)o+=String.fromCharCode(n[f]+n[f+1]*256);return o}y.prototype.slice=function(t,e){let n=this.length;t=~~t,e=e===void 0?n:~~e,t<0?(t+=n,t<0&&(t=0)):t>n&&(t=n),e<0?(e+=n,e<0&&(e=0)):e>n&&(e=n),e<t&&(e=t);let o=this.subarray(t,e);return Object.setPrototypeOf(o,y.prototype),o};function ne(r,t,e){if(r%1!==0||r<0)throw new RangeError(\"offset is not uint\");if(r+t>e)throw new RangeError(\"Trying to access beyond buffer length\")}y.prototype.readUintLE=y.prototype.readUIntLE=function(t,e,n){t=t>>>0,e=e>>>0,n||ne(t,e,this.length);let o=this[t],f=1,l=0;for(;++l<e&&(f*=256);)o+=this[t+l]*f;return o};y.prototype.readUintBE=y.prototype.readUIntBE=function(t,e,n){t=t>>>0,e=e>>>0,n||ne(t,e,this.length);let o=this[t+--e],f=1;for(;e>0&&(f*=256);)o+=this[t+--e]*f;return o};y.prototype.readUint8=y.prototype.readUInt8=function(t,e){return t=t>>>0,e||ne(t,1,this.length),this[t]};y.prototype.readUint16LE=y.prototype.readUInt16LE=function(t,e){return t=t>>>0,e||ne(t,2,this.length),this[t]|this[t+1]<<8};y.prototype.readUint16BE=y.prototype.readUInt16BE=function(t,e){return t=t>>>0,e||ne(t,2,this.length),this[t]<<8|this[t+1]};y.prototype.readUint32LE=y.prototype.readUInt32LE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),(this[t]|this[t+1]<<8|this[t+2]<<16)+this[t+3]*16777216};y.prototype.readUint32BE=y.prototype.readUInt32BE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),this[t]*16777216+(this[t+1]<<16|this[t+2]<<8|this[t+3])};y.prototype.readBigUInt64LE=rt(function(t){t=t>>>0,Bt(t,\"offset\");let e=this[t],n=this[t+7];(e===void 0||n===void 0)&&er(t,this.length-8);let o=e+this[++t]*2**8+this[++t]*2**16+this[++t]*2**24,f=this[++t]+this[++t]*2**8+this[++t]*2**16+n*2**24;return BigInt(o)+(BigInt(f)<<BigInt(32))});y.prototype.readBigUInt64BE=rt(function(t){t=t>>>0,Bt(t,\"offset\");let e=this[t],n=this[t+7];(e===void 0||n===void 0)&&er(t,this.length-8);let o=e*2**24+this[++t]*2**16+this[++t]*2**8+this[++t],f=this[++t]*2**24+this[++t]*2**16+this[++t]*2**8+n;return(BigInt(o)<<BigInt(32))+BigInt(f)});y.prototype.readIntLE=function(t,e,n){t=t>>>0,e=e>>>0,n||ne(t,e,this.length);let o=this[t],f=1,l=0;for(;++l<e&&(f*=256);)o+=this[t+l]*f;return f*=128,o>=f&&(o-=Math.pow(2,8*e)),o};y.prototype.readIntBE=function(t,e,n){t=t>>>0,e=e>>>0,n||ne(t,e,this.length);let o=e,f=1,l=this[t+--o];for(;o>0&&(f*=256);)l+=this[t+--o]*f;return f*=128,l>=f&&(l-=Math.pow(2,8*e)),l};y.prototype.readInt8=function(t,e){return t=t>>>0,e||ne(t,1,this.length),this[t]&128?(255-this[t]+1)*-1:this[t]};y.prototype.readInt16LE=function(t,e){t=t>>>0,e||ne(t,2,this.length);let n=this[t]|this[t+1]<<8;return n&32768?n|4294901760:n};y.prototype.readInt16BE=function(t,e){t=t>>>0,e||ne(t,2,this.length);let n=this[t+1]|this[t]<<8;return n&32768?n|4294901760:n};y.prototype.readInt32LE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),this[t]|this[t+1]<<8|this[t+2]<<16|this[t+3]<<24};y.prototype.readInt32BE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),this[t]<<24|this[t+1]<<16|this[t+2]<<8|this[t+3]};y.prototype.readBigInt64LE=rt(function(t){t=t>>>0,Bt(t,\"offset\");let e=this[t],n=this[t+7];(e===void 0||n===void 0)&&er(t,this.length-8);let o=this[t+4]+this[t+5]*2**8+this[t+6]*2**16+(n<<24);return(BigInt(o)<<BigInt(32))+BigInt(e+this[++t]*2**8+this[++t]*2**16+this[++t]*2**24)});y.prototype.readBigInt64BE=rt(function(t){t=t>>>0,Bt(t,\"offset\");let e=this[t],n=this[t+7];(e===void 0||n===void 0)&&er(t,this.length-8);let o=(e<<24)+this[++t]*2**16+this[++t]*2**8+this[++t];return(BigInt(o)<<BigInt(32))+BigInt(this[++t]*2**24+this[++t]*2**16+this[++t]*2**8+n)});y.prototype.readFloatLE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),kt.read(this,t,!0,23,4)};y.prototype.readFloatBE=function(t,e){return t=t>>>0,e||ne(t,4,this.length),kt.read(this,t,!1,23,4)};y.prototype.readDoubleLE=function(t,e){return t=t>>>0,e||ne(t,8,this.length),kt.read(this,t,!0,52,8)};y.prototype.readDoubleBE=function(t,e){return t=t>>>0,e||ne(t,8,this.length),kt.read(this,t,!1,52,8)};function ce(r,t,e,n,o,f){if(!y.isBuffer(r))throw new TypeError('\"buffer\" argument must be a Buffer instance');if(t>o||t<f)throw new RangeError('\"value\" argument is out of bounds');if(e+n>r.length)throw new RangeError(\"Index out of range\")}y.prototype.writeUintLE=y.prototype.writeUIntLE=function(t,e,n,o){if(t=+t,e=e>>>0,n=n>>>0,!o){let _=Math.pow(2,8*n)-1;ce(this,t,e,n,_,0)}let f=1,l=0;for(this[e]=t&255;++l<n&&(f*=256);)this[e+l]=t/f&255;return e+n};y.prototype.writeUintBE=y.prototype.writeUIntBE=function(t,e,n,o){if(t=+t,e=e>>>0,n=n>>>0,!o){let _=Math.pow(2,8*n)-1;ce(this,t,e,n,_,0)}let f=n-1,l=1;for(this[e+f]=t&255;--f>=0&&(l*=256);)this[e+f]=t/l&255;return e+n};y.prototype.writeUint8=y.prototype.writeUInt8=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,1,255,0),this[e]=t&255,e+1};y.prototype.writeUint16LE=y.prototype.writeUInt16LE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,2,65535,0),this[e]=t&255,this[e+1]=t>>>8,e+2};y.prototype.writeUint16BE=y.prototype.writeUInt16BE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,2,65535,0),this[e]=t>>>8,this[e+1]=t&255,e+2};y.prototype.writeUint32LE=y.prototype.writeUInt32LE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,4,4294967295,0),this[e+3]=t>>>24,this[e+2]=t>>>16,this[e+1]=t>>>8,this[e]=t&255,e+4};y.prototype.writeUint32BE=y.prototype.writeUInt32BE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,4,4294967295,0),this[e]=t>>>24,this[e+1]=t>>>16,this[e+2]=t>>>8,this[e+3]=t&255,e+4};function pi(r,t,e,n,o){vi(t,n,o,r,e,7);let f=Number(t&BigInt(4294967295));r[e++]=f,f=f>>8,r[e++]=f,f=f>>8,r[e++]=f,f=f>>8,r[e++]=f;let l=Number(t>>BigInt(32)&BigInt(4294967295));return r[e++]=l,l=l>>8,r[e++]=l,l=l>>8,r[e++]=l,l=l>>8,r[e++]=l,e}function gi(r,t,e,n,o){vi(t,n,o,r,e,7);let f=Number(t&BigInt(4294967295));r[e+7]=f,f=f>>8,r[e+6]=f,f=f>>8,r[e+5]=f,f=f>>8,r[e+4]=f;let l=Number(t>>BigInt(32)&BigInt(4294967295));return r[e+3]=l,l=l>>8,r[e+2]=l,l=l>>8,r[e+1]=l,l=l>>8,r[e]=l,e+8}y.prototype.writeBigUInt64LE=rt(function(t,e=0){return pi(this,t,e,BigInt(0),BigInt(\"0xffffffffffffffff\"))});y.prototype.writeBigUInt64BE=rt(function(t,e=0){return gi(this,t,e,BigInt(0),BigInt(\"0xffffffffffffffff\"))});y.prototype.writeIntLE=function(t,e,n,o){if(t=+t,e=e>>>0,!o){let A=Math.pow(2,8*n-1);ce(this,t,e,n,A-1,-A)}let f=0,l=1,_=0;for(this[e]=t&255;++f<n&&(l*=256);)t<0&&_===0&&this[e+f-1]!==0&&(_=1),this[e+f]=(t/l>>0)-_&255;return e+n};y.prototype.writeIntBE=function(t,e,n,o){if(t=+t,e=e>>>0,!o){let A=Math.pow(2,8*n-1);ce(this,t,e,n,A-1,-A)}let f=n-1,l=1,_=0;for(this[e+f]=t&255;--f>=0&&(l*=256);)t<0&&_===0&&this[e+f+1]!==0&&(_=1),this[e+f]=(t/l>>0)-_&255;return e+n};y.prototype.writeInt8=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,1,127,-128),t<0&&(t=255+t+1),this[e]=t&255,e+1};y.prototype.writeInt16LE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,2,32767,-32768),this[e]=t&255,this[e+1]=t>>>8,e+2};y.prototype.writeInt16BE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,2,32767,-32768),this[e]=t>>>8,this[e+1]=t&255,e+2};y.prototype.writeInt32LE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,4,2147483647,-2147483648),this[e]=t&255,this[e+1]=t>>>8,this[e+2]=t>>>16,this[e+3]=t>>>24,e+4};y.prototype.writeInt32BE=function(t,e,n){return t=+t,e=e>>>0,n||ce(this,t,e,4,2147483647,-2147483648),t<0&&(t=4294967295+t+1),this[e]=t>>>24,this[e+1]=t>>>16,this[e+2]=t>>>8,this[e+3]=t&255,e+4};y.prototype.writeBigInt64LE=rt(function(t,e=0){return pi(this,t,e,-BigInt(\"0x8000000000000000\"),BigInt(\"0x7fffffffffffffff\"))});y.prototype.writeBigInt64BE=rt(function(t,e=0){return gi(this,t,e,-BigInt(\"0x8000000000000000\"),BigInt(\"0x7fffffffffffffff\"))});function wi(r,t,e,n,o,f){if(e+n>r.length)throw new RangeError(\"Index out of range\");if(e<0)throw new RangeError(\"Index out of range\")}function yi(r,t,e,n,o){return t=+t,e=e>>>0,o||wi(r,t,e,4,34028234663852886e22,-34028234663852886e22),kt.write(r,t,e,n,23,4),e+4}y.prototype.writeFloatLE=function(t,e,n){return yi(this,t,e,!0,n)};y.prototype.writeFloatBE=function(t,e,n){return yi(this,t,e,!1,n)};function mi(r,t,e,n,o){return t=+t,e=e>>>0,o||wi(r,t,e,8,17976931348623157e292,-17976931348623157e292),kt.write(r,t,e,n,52,8),e+8}y.prototype.writeDoubleLE=function(t,e,n){return mi(this,t,e,!0,n)};y.prototype.writeDoubleBE=function(t,e,n){return mi(this,t,e,!1,n)};y.prototype.copy=function(t,e,n,o){if(!y.isBuffer(t))throw new TypeError(\"argument should be a Buffer\");if(n||(n=0),!o&&o!==0&&(o=this.length),e>=t.length&&(e=t.length),e||(e=0),o>0&&o<n&&(o=n),o===n||t.length===0||this.length===0)return 0;if(e<0)throw new RangeError(\"targetStart out of bounds\");if(n<0||n>=this.length)throw new RangeError(\"Index out of range\");if(o<0)throw new RangeError(\"sourceEnd out of bounds\");o>this.length&&(o=this.length),t.length-e<o-n&&(o=t.length-e+n);let f=o-n;return this===t&&typeof Uint8Array.prototype.copyWithin==\"function\"?this.copyWithin(e,n,o):Uint8Array.prototype.set.call(t,this.subarray(n,o),e),f};y.prototype.fill=function(t,e,n,o){if(typeof t==\"string\"){if(typeof e==\"string\"?(o=e,e=0,n=this.length):typeof n==\"string\"&&(o=n,n=this.length),o!==void 0&&typeof o!=\"string\")throw new TypeError(\"encoding must be a string\");if(typeof o==\"string\"&&!y.isEncoding(o))throw new TypeError(\"Unknown encoding: \"+o);if(t.length===1){let l=t.charCodeAt(0);(o===\"utf8\"&&l<128||o===\"latin1\")&&(t=l)}}else typeof t==\"number\"?t=t&255:typeof t==\"boolean\"&&(t=Number(t));if(e<0||this.length<e||this.length<n)throw new RangeError(\"Out of range index\");if(n<=e)return this;e=e>>>0,n=n===void 0?this.length:n>>>0,t||(t=0);let f;if(typeof t==\"number\")for(f=e;f<n;++f)this[f]=t;else{let l=y.isBuffer(t)?t:y.from(t,o),_=l.length;if(_===0)throw new TypeError('The value \"'+t+'\" is invalid for argument \"value\"');for(f=0;f<n-e;++f)this[f+e]=l[f%_]}return this};var Rt={};function kn(r,t,e){Rt[r]=class extends e{constructor(){super(),Object.defineProperty(this,\"message\",{value:t.apply(this,arguments),writable:!0,configurable:!0}),this.name=`${this.name} [${r}]`,this.stack,delete this.name}get code(){return r}set code(o){Object.defineProperty(this,\"code\",{configurable:!0,enumerable:!0,value:o,writable:!0})}toString(){return`${this.name} [${r}]: ${this.message}`}}}kn(\"ERR_BUFFER_OUT_OF_BOUNDS\",function(r){return r?`${r} is outside of buffer bounds`:\"Attempt to access memory outside buffer bounds\"},RangeError);kn(\"ERR_INVALID_ARG_TYPE\",function(r,t){return`The \"${r}\" argument must be of type number. Received type ${typeof t}`},TypeError);kn(\"ERR_OUT_OF_RANGE\",function(r,t,e){let n=`The value of \"${r}\" is out of range.`,o=e;return Number.isInteger(e)&&Math.abs(e)>2**32?o=ui(String(e)):typeof e==\"bigint\"&&(o=String(e),(e>BigInt(2)**BigInt(32)||e<-(BigInt(2)**BigInt(32)))&&(o=ui(o)),o+=\"n\"),n+=` It must be ${t}. Received ${o}`,n},RangeError);function ui(r){let t=\"\",e=r.length,n=r[0]===\"-\"?1:0;for(;e>=n+4;e-=3)t=`_${r.slice(e-3,e)}${t}`;return`${r.slice(0,e)}${t}`}function xa(r,t,e){Bt(t,\"offset\"),(r[t]===void 0||r[t+e]===void 0)&&er(t,r.length-(e+1))}function vi(r,t,e,n,o,f){if(r>e||r<t){let l=typeof t==\"bigint\"?\"n\":\"\",_;throw f>3?t===0||t===BigInt(0)?_=`>= 0${l} and < 2${l} ** ${(f+1)*8}${l}`:_=`>= -(2${l} ** ${(f+1)*8-1}${l}) and < 2 ** ${(f+1)*8-1}${l}`:_=`>= ${t}${l} and <= ${e}${l}`,new Rt.ERR_OUT_OF_RANGE(\"value\",_,r)}xa(n,o,f)}function Bt(r,t){if(typeof r!=\"number\")throw new Rt.ERR_INVALID_ARG_TYPE(t,\"number\",r)}function er(r,t,e){throw Math.floor(r)!==r?(Bt(r,e),new Rt.ERR_OUT_OF_RANGE(e||\"offset\",\"an integer\",r)):t<0?new Rt.ERR_BUFFER_OUT_OF_BOUNDS:new Rt.ERR_OUT_OF_RANGE(e||\"offset\",`>= ${e?1:0} and <= ${t}`,r)}var Fa=/[^+/0-9A-Za-z-_]/g;function Ia(r){if(r=r.split(\"=\")[0],r=r.trim().replace(Fa,\"\"),r.length<2)return\"\";for(;r.length%4!==0;)r=r+\"=\";return r}function In(r,t){t=t||1/0;let e,n=r.length,o=null,f=[];for(let l=0;l<n;++l){if(e=r.charCodeAt(l),e>55295&&e<57344){if(!o){if(e>56319){(t-=3)>-1&&f.push(239,191,189);continue}else if(l+1===n){(t-=3)>-1&&f.push(239,191,189);continue}o=e;continue}if(e<56320){(t-=3)>-1&&f.push(239,191,189),o=e;continue}e=(o-55296<<10|e-56320)+65536}else o&&(t-=3)>-1&&f.push(239,191,189);if(o=null,e<128){if((t-=1)<0)break;f.push(e)}else if(e<2048){if((t-=2)<0)break;f.push(e>>6|192,e&63|128)}else if(e<65536){if((t-=3)<0)break;f.push(e>>12|224,e>>6&63|128,e&63|128)}else if(e<1114112){if((t-=4)<0)break;f.push(e>>18|240,e>>12&63|128,e>>6&63|128,e&63|128)}else throw new Error(\"Invalid code point\")}return f}function Sa(r){let t=[];for(let e=0;e<r.length;++e)t.push(r.charCodeAt(e)&255);return t}function Ra(r,t){let e,n,o,f=[];for(let l=0;l<r.length&&!((t-=2)<0);++l)e=r.charCodeAt(l),n=e>>8,o=e%256,f.push(o),f.push(n);return f}function _i(r){return Tn.toByteArray(Ia(r))}function Fr(r,t,e,n){let o;for(o=0;o<n&&!(o+e>=t.length||o>=r.length);++o)t[o+e]=r[o];return o}function We(r,t){return r instanceof t||r!=null&&r.constructor!=null&&r.constructor.name!=null&&r.constructor.name===t.name}function Bn(r){return r!==r}var ka=(function(){let r=\"0123456789abcdef\",t=new Array(256);for(let e=0;e<16;++e){let n=e*16;for(let o=0;o<16;++o)t[n+o]=r[e]+r[o]}return t})();function rt(r){return typeof BigInt>\"u\"?Ba:r}function Ba(){throw new Error(\"BigInt not supported\")}});var z,X=ea(()=>{z=Cn(Un())});var $n=tt((uo,Ci)=>{X();var Ln={};if(typeof globalThis>\"u\"){let r=St(\"fs\"),{promisify:t}=St(\"util\"),{basename:e}=St(\"path\");Ln={read:t(r.read),write:t(r.write),open:t(r.open),close:t(r.close),basename:e,avail:!0}}else{let r=async()=>{throw new Error(\"Running inside a browser; filesystem support is not available\")};Ln={read:r,write:r,open:r,close:r,basename:r,err:r,avail:!1}}Ci.exports=Ln});var Ai=tt((lo,Pi)=>{X();var Lt=$n(),Mn=z.Buffer.alloc(1);Mn[0]=0;var ye={NONE:0,FILE:1,BUFFER:2},nt={TYPE_LOSSY:0,TYPE_LOSSLESS:1,TYPE_EXTENDED:2};function La(r){return(r[7]<<8|r[6])&16383}function $a(r){return(r[9]<<8|r[8])&16383}function Oa(r){return((r[2]<<8|r[1])&16383)+1}function Da(r){return((r[4]<<16|r[3]<<8|r[2])>>6&16383)+1}function Ma(r){return!!(r[4]&16)}function Te(r,t){let e=z.Buffer.alloc(8),n=t.length;return e.write(r,0),e.writeUInt32LE(n,4),n&1?{size:n+9,chunks:[e,t,Mn]}:{size:n+8,chunks:[e,t]}}var On=class r{constructor(){this.type=ye.NONE}readFile(t){this.type=ye.FILE,this.path=t}readBuffer(t){this.type=ye.BUFFER,this.buf=t,this.cursor=0}async readBytes(t,e){let{type:n}=this;if(n==ye.FILE){let o=z.Buffer.alloc(t),f;return f=(await Lt.read(this.fp,o,0,t,void 0)).bytesRead,e||f==t?o:void 0}else if(n==ye.BUFFER){let o=this.buf.slice(this.cursor,this.cursor+t);return this.cursor+=t,o}else throw new Error(\"Reader not initialized\")}async readFileHeader(){let t=await this.readBytes(12);if(t===void 0)throw new Error(\"Reached end while reading header\");if(t.toString(\"utf8\",0,4)!=\"RIFF\")throw new Error(\"Bad header (not RIFF)\");if(t.toString(\"utf8\",8,12)!=\"WEBP\")throw new Error(\"Bad header (not WEBP)\");return{fileSize:t.readUInt32LE(4)}}async readChunkHeader(){let t=await this.readBytes(8,!0);if(t.length==0)return{fourCC:\"\\0\\0\\0\\0\",size:0};if(t.length<8)throw new Error(\"Reached end while reading chunk header\");return{fourCC:t.toString(\"utf8\",0,4),size:t.readUInt32LE(4)}}async readChunkContents(t){let e=await this.readBytes(t);return t&1&&await this.readBytes(1),e}async readChunk_raw(t,e){let n=await this.readChunkContents(e);if(n===void 0)throw new Error(`Reached end while reading ${t} chunk`);return{raw:n}}async readChunk_VP8(t){let e=await this.readChunkContents(t);if(e===void 0)throw new Error(\"Reached end while reading VP8 chunk\");return{raw:e,width:La(e),height:$a(e)}}async readChunk_VP8L(t){let e=await this.readChunkContents(t);if(e===void 0)throw new Error(\"Reached end while reading VP8L chunk\");return{raw:e,alpha:Ma(e),width:Oa(e),height:Da(e)}}async readChunk_VP8X(t){let e=await this.readChunkContents(t);if(e===void 0)throw new Error(\"Reached end while reading VP8X chunk\");return{raw:e,hasICCP:!!(e[0]&32),hasAlpha:!!(e[0]&16),hasEXIF:!!(e[0]&8),hasXMP:!!(e[0]&4),hasAnim:!!(e[0]&2),width:e.readUIntLE(4,3)+1,height:e.readUIntLE(7,3)+1}}async readChunk_ANIM(t){let e=await this.readChunkContents(t);if(e===void 0)throw new Error(\"Reached end while reading ANIM chunk\");return{raw:e,bgColor:e.slice(0,4),loops:e.readUInt16LE(4)}}async readChunk_ANMF(t){let e=await this.readChunkContents(t);if(e===void 0)throw new Error(\"Reached end while reading ANMF chunk\");let n={raw:e,x:e.readUIntLE(0,3),y:e.readUIntLE(3,3),width:e.readUIntLE(6,3)+1,height:e.readUIntLE(9,3)+1,delay:e.readUIntLE(12,3),blend:!(e[15]&2),dispose:!!(e[15]&1)},o=!0,f=new r;for(f.readBuffer(e),f.cursor=16;o;){let l=await f.readChunkHeader();switch(l.fourCC){case\"VP8 \":n.vp8||(n.type=nt.TYPE_LOSSY,n.vp8=await f.readChunk_VP8(l.size),n.alph&&(n.vp8.alpha=!0));break;case\"VP8L\":n.vp8l||(n.type=nt.TYPE_LOSSLESS,n.vp8l=await f.readChunk_VP8L(l.size));break;case\"ALPH\":n.alph||(n.alph=await f.readChunk_ALPH(l.size),n.vp8&&(n.vp8.alpha=!0));break;default:o=!1;break}if(f.cursor>=e.length)break}return n}async readChunk_ALPH(t){return this.readChunk_raw(\"ALPH\",t)}async readChunk_ICCP(t){return this.readChunk_raw(\"ICCP\",t)}async readChunk_EXIF(t){return this.readChunk_raw(\"EXIF\",t)}async readChunk_XMP(t){return this.readChunk_raw(\"XMP \",t)}async readChunk_skip(t){if(await this.readChunkContents(t)===void 0)throw new Error(\"Reached end while skipping chunk\")}async read(){this.type==ye.FILE&&(this.fp=await Lt.open(this.path,\"r\"));let t=!0,e=!0,{fileSize:n}=await this.readFileHeader(),o={};for(;t;){let{fourCC:f,size:l}=await this.readChunkHeader();switch(f){case\"VP8 \":o.vp8?await this.readChunk_skip(l):(o.vp8=await this.readChunk_VP8(l),o.alph&&(o.vp8.alpha=!0),e&&(o.type=nt.TYPE_LOSSY,t=!1));break;case\"VP8L\":o.vp8l?await this.readChunk_skip(l):(o.vp8l=await this.readChunk_VP8L(l),e&&(o.type=nt.TYPE_LOSSLESS,t=!1));break;case\"VP8X\":o.extended?await this.readChunk_skip(l):(o.type=nt.TYPE_EXTENDED,o.extended=await this.readChunk_VP8X(l));break;case\"ANIM\":if(o.anim)await this.readChunk_skip(l);else{let{raw:_,bgColor:A,loops:g}=await this.readChunk_ANIM(l);o.anim={bgColor:[A[2],A[1],A[0],A[3]],loops:g,frames:[],raw:_}}break;case\"ANMF\":o.anim.frames.push(await this.readChunk_ANMF(l));break;case\"ALPH\":o.alph?await this.readChunk_skip(l):(o.alph=await this.readChunk_ALPH(l),o.vp8&&(o.vp8.alpha=!0));break;case\"ICCP\":o.iccp?await this.readChunk_skip(l):o.iccp=await this.readChunk_ICCP(l);break;case\"EXIF\":o.exif?await this.readChunk_skip(l):o.exif=await this.readChunk_EXIF(l);break;case\"XMP \":o.xmp?await this.readChunk_skip(l):o.xmp=await this.readChunk_XMP(l);break;case\"\\0\\0\\0\\0\":t=!1;break;default:await this.readChunk_skip(l);break}e=!1}return this.type==ye.FILE&&await Lt.close(this.fp),o}},Dn=class{constructor(){this.type=ye.NONE,this.chunks=[],this.width=this.height=0}reset(){this.chunks.length=0,width=0,height=0}writeFile(t){this.type=ye.FILE,this.path=t}writeBuffer(){this.type=ye.BUFFER}async commit(){let{chunks:t}=this,e=4,n;if(this.type==ye.NONE)throw new Error(\"Writer not initialized\");if(t.length==0)throw new Error(\"Nothing to write\");for(let o=1,f=t.length;o<f;o++)e+=t[o].length;if(t[0].writeUInt32LE(e,4),this.type==ye.FILE){n=await Lt.open(this.path,\"w\");for(let o=0,f=t.length;o<f;o++)await Lt.write(n,t[o],0,void 0,void 0);await Lt.close(n)}else return z.Buffer.concat(t)}writeBytes(...t){if(this.type==ye.NONE)throw new Error(\"Writer not initialized\");this.chunks.push(...t)}writeFileHeader(){let t=z.Buffer.alloc(12);t.write(\"RIFF\",0),t.write(\"WEBP\",8),this.writeBytes(t)}writeChunk_VP8(t){this.writeBytes(...Te(\"VP8 \",t.raw).chunks)}writeChunk_VP8L(t){this.writeBytes(...Te(\"VP8L\",t.raw).chunks)}writeChunk_VP8X(t){let e=z.Buffer.alloc(18);e.write(\"VP8X\",0),e.writeUInt32LE(10,4),e.writeUIntLE(t.width-1,12,3),e.writeUIntLE(t.height-1,15,3),t.hasICCP&&(e[8]|=32),t.hasAlpha&&(e[8]|=16),t.hasEXIF&&(e[8]|=8),t.hasXMP&&(e[8]|=4),t.hasAnim&&(e[8]|=2),this.vp8x=e,this.writeBytes(e)}updateChunk_VP8X_size(t,e){this.vp8x.writeUIntLE(t,12,3),this.vp8x.writeUIntLE(e,15,3)}writeChunk_ANIM(t){let e=z.Buffer.alloc(14);e.write(\"ANIM\",0),e.writeUInt32LE(6,4),e.writeUInt8(t.bgColor[2],8),e.writeUInt8(t.bgColor[1],9),e.writeUInt8(t.bgColor[0],10),e.writeUInt8(t.bgColor[3],11),e.writeUInt16LE(t.loops,12),this.writeBytes(e)}writeChunk_ANMF(t){let e=z.Buffer.alloc(24),{img:n}=t,o=16,f=!1;switch(e.write(\"ANMF\",0),e.writeUIntLE(t.x,8,3),e.writeUIntLE(t.y,11,3),e.writeUIntLE(t.delay,20,3),t.blend||(e[23]|=2),t.dispose&&(e[23]|=1),n.type){case nt.TYPE_LOSSY:{let l;this.width=Math.max(this.width,n.vp8.width),this.height=Math.max(this.height,n.vp8.height),e.writeUIntLE(n.vp8.width-1,14,3),e.writeUIntLE(n.vp8.height-1,17,3),this.writeBytes(e),n.vp8.alpha&&(l=Te(\"ALPH\",n.alph.raw),this.writeBytes(...l.chunks),o+=l.size),l=Te(\"VP8 \",n.vp8.raw),this.writeBytes(...l.chunks),o+=l.size}break;case nt.TYPE_LOSSLESS:{let l=Te(\"VP8L\",n.vp8l.raw);this.width=Math.max(this.width,n.vp8l.width),this.height=Math.max(this.height,n.vp8l.height),e.writeUIntLE(n.vp8l.width-1,14,3),e.writeUIntLE(n.vp8l.height-1,17,3),n.vp8l.alpha&&(f=!0),this.writeBytes(e,...l.chunks),o+=l.size}break;case nt.TYPE_EXTENDED:if(n.extended.hasAnim){let l=n.anim.frames;n.extended.hasAlpha&&(f=!0);for(let _=0,A=l.length;_<A;_++){let g=z.Buffer.alloc(8),F=l[_].raw;this.width=Math.max(this.width,l[_].width+t.x),this.height=Math.max(this.height,l[_].height+t.y),g.write(\"ANMF\",0),g.writeUInt32LE(F.length,4),F.writeUIntLE(t.x,0,3),F.writeUIntLE(t.y,3,3),F.writeUIntLE(t.delay,12,3),t.blend?F[15]&=253:F[15]|=2,t.dispose?F[15]|=1:F[15]&=254,this.writeBytes(g,F),F.length&1&&this.writeBytes(Mn)}}else{let l;this.width=Math.max(this.width,n.extended.width),this.height=Math.max(this.height,n.extended.height),n.vp8?(e.writeUIntLE(n.vp8.width-1,14,3),e.writeUIntLE(n.vp8.height-1,17,3),this.writeBytes(e),n.alph&&(l=Te(\"ALPH\",n.alph.raw),f=!0,this.writeBytes(...l.chunks),o+=l.size),l=Te(\"VP8 \",n.vp8.raw),this.writeBytes(...l.chunks),o+=l.size):n.vp8l&&(e.writeUIntLE(n.vp8l.width-1,14,3),e.writeUIntLE(n.vp8l.height-1,17,3),n.vp8l.alpha&&(f=!0),l=Te(\"VP8L\",n.vp8l.raw),this.writeBytes(e,...l.chunks),o+=l.size)}break;default:throw new Error(\"Unknown image type\")}e.writeUInt32LE(o,4),f&&(this.vp8x[8]|=16)}writeChunk_ALPH(t){this.writeBytes(...Te(\"ALPH\",t.raw).chunks)}writeChunk_ICCP(t){this.writeBytes(...Te(\"ICCP\",t.raw).chunks)}writeChunk_EXIF(t){this.writeBytes(...Te(\"EXIF\",t.raw).chunks)}writeChunk_XMP(t){this.writeBytes(...Te(\"XMP \",t.raw).chunks)}};Pi.exports={WebPReader:On,WebPWriter:Dn}});var Ti=tt((Ir,Wn)=>{X();var Nn=(()=>{var r=typeof document<\"u\"&&document.currentScript?document.currentScript.src:void 0;return typeof __filename<\"u\"&&(r=r||__filename),(function(t){t=t||{};var e=typeof t<\"u\"?t:{},n,o;e.ready=new Promise(function(i,a){n=i,o=a});var f=Object.assign({},e),l=[],_=\"./this.program\",A=(i,a)=>{throw a},g=typeof globalThis==\"object\",F=typeof importScripts==\"function\",b=typeof process==\"object\"&&typeof process.versions==\"object\"&&typeof process.versions.node==\"string\",L=\"\";function S(i){return e.locateFile?e.locateFile(i,L):L+i}var B,W,Z,Se;function me(i){if(i instanceof Qn)return;le(\"exiting due to exception: \"+i)}var de,Ve,it;b?(F?L=St(\"path\").dirname(L)+\"/\":L=__dirname+\"/\",it=(()=>{Ve||(de=St(\"fs\"),Ve=St(\"path\"))}),B=function(a,h){return it(),a=Ve.normalize(a),de.readFileSync(a,h?void 0:\"utf8\")},Z=(i=>{var a=B(i,!0);return a.buffer||(a=new Uint8Array(a)),a}),W=((i,a,h)=>{it(),i=Ve.normalize(i),de.readFile(i,function(d,v){d?h(d):a(v.buffer)})}),process.argv.length>1&&(_=process.argv[1].replace(/\\\\/g,\"/\")),l=process.argv.slice(2),process.on(\"uncaughtException\",function(i){if(!(i instanceof Qn))throw i}),process.on(\"unhandledRejection\",function(i){throw i}),A=((i,a)=>{if(Lr())throw process.exitCode=i,a;me(a),process.exit(i)}),e.inspect=function(){return\"[Emscripten Module object]\"}):(g||F)&&(F?L=self.location.href:typeof document<\"u\"&&document.currentScript&&(L=document.currentScript.src),r&&(L=r),L.indexOf(\"blob:\")!==0?L=L.substr(0,L.replace(/[?#].*/,\"\").lastIndexOf(\"/\")+1):L=\"\",B=(i=>{var a=new XMLHttpRequest;return a.open(\"GET\",i,!1),a.send(null),a.responseText}),F&&(Z=(i=>{var a=new XMLHttpRequest;return a.open(\"GET\",i,!1),a.responseType=\"arraybuffer\",a.send(null),new Uint8Array(a.response)})),W=((i,a,h)=>{var d=new XMLHttpRequest;d.open(\"GET\",i,!0),d.responseType=\"arraybuffer\",d.onload=(()=>{if(d.status==200||d.status==0&&d.response){a(d.response);return}h()}),d.onerror=h,d.send(null)}),Se=(i=>document.title=i));var pe=e.print||console.log.bind(console),le=e.printErr||console.warn.bind(console);Object.assign(e,f),f=null,e.arguments&&(l=e.arguments),e.thisProgram&&(_=e.thisProgram),e.quit&&(A=e.quit);var G=0,Re=i=>{G=i},ve;e.wasmBinary&&(ve=e.wasmBinary);var at=e.noExitRuntime||!0;typeof WebAssembly!=\"object\"&&Je(\"no native wasm support detected\");var qe,wt=!1,oe;function Sr(i,a){i||Je(a)}function nr(i){var a=e[\"_\"+i];return a}function ke(i,a,h,d,v){var C={string:function(Y){var K=0;if(Y!=null&&Y!==0){var we=(Y.length<<2)+1;K=_n(we),$t(Y,K,we)}return K},array:function(Y){var K=_n(Y.length);return Br(Y,K),K}};function P(Y){return a===\"string\"?ee(Y):a===\"boolean\"?!!Y:Y}var m=nr(i),T=[],k=0;if(d)for(var $=0;$<d.length;$++){var O=C[h[$]];O?(k===0&&(k=qn()),T[$]=O(d[$])):T[$]=d[$]}var M=m.apply(null,T);function re(Y){return k!==0&&Gn(k),P(Y)}return M=re(M),M}function se(i,a,h,d){h=h||[];var v=h.every(function(P){return P===\"number\"}),C=a!==\"string\";return C&&v&&!d?nr(i):function(){return ke(i,a,h,arguments,d)}}var Be=typeof TextDecoder<\"u\"?new TextDecoder(\"utf8\"):void 0;function yt(i,a,h){for(var d=a+h,v=a;i[v]&&!(v>=d);)++v;if(v-a>16&&i.subarray&&Be)return Be.decode(i.subarray(a,v));for(var C=\"\";a<v;){var P=i[a++];if(!(P&128)){C+=String.fromCharCode(P);continue}var m=i[a++]&63;if((P&224)==192){C+=String.fromCharCode((P&31)<<6|m);continue}var T=i[a++]&63;if((P&240)==224?P=(P&15)<<12|m<<6|T:P=(P&7)<<18|m<<12|T<<6|i[a++]&63,P<65536)C+=String.fromCharCode(P);else{var k=P-65536;C+=String.fromCharCode(55296|k>>10,56320|k&1023)}}return C}function ee(i,a){return i?yt(ue,i,a):\"\"}function Q(i,a,h,d){if(!(d>0))return 0;for(var v=h,C=h+d-1,P=0;P<i.length;++P){var m=i.charCodeAt(P);if(m>=55296&&m<=57343){var T=i.charCodeAt(++P);m=65536+((m&1023)<<10)|T&1023}if(m<=127){if(h>=C)break;a[h++]=m}else if(m<=2047){if(h+1>=C)break;a[h++]=192|m>>6,a[h++]=128|m&63}else if(m<=65535){if(h+2>=C)break;a[h++]=224|m>>12,a[h++]=128|m>>6&63,a[h++]=128|m&63}else{if(h+3>=C)break;a[h++]=240|m>>18,a[h++]=128|m>>12&63,a[h++]=128|m>>6&63,a[h++]=128|m&63}}return a[h]=0,h-v}function $t(i,a,h){return Q(i,ue,a,h)}function ir(i){for(var a=0,h=0;h<i.length;++h){var d=i.charCodeAt(h);d>=55296&&d<=57343&&(d=65536+((d&1023)<<10)|i.charCodeAt(++h)&1023),d<=127?++a:d<=2047?a+=2:d<=65535?a+=3:a+=4}return a}var Ot=typeof TextDecoder<\"u\"?new TextDecoder(\"utf-16le\"):void 0;function ar(i,a){for(var h=i,d=h>>1,v=d+a/2;!(d>=v)&&_e[d];)++d;if(h=d<<1,h-i>32&&Ot)return Ot.decode(ue.subarray(i,h));for(var C=\"\",P=0;!(P>=a/2);++P){var m=Ge[i+P*2>>1];if(m==0)break;C+=String.fromCharCode(m)}return C}function or(i,a,h){if(h===void 0&&(h=2147483647),h<2)return 0;h-=2;for(var d=a,v=h<i.length*2?h/2:i.length,C=0;C<v;++C){var P=i.charCodeAt(C);Ge[a>>1]=P,a+=2}return Ge[a>>1]=0,a-d}function sr(i){return i.length*2}function ur(i,a){for(var h=0,d=\"\";!(h>=a/4);){var v=xe[i+h*4>>2];if(v==0)break;if(++h,v>=65536){var C=v-65536;d+=String.fromCharCode(55296|C>>10,56320|C&1023)}else d+=String.fromCharCode(v)}return d}function Rr(i,a,h){if(h===void 0&&(h=2147483647),h<4)return 0;for(var d=a,v=d+h-4,C=0;C<i.length;++C){var P=i.charCodeAt(C);if(P>=55296&&P<=57343){var m=i.charCodeAt(++C);P=65536+((P&1023)<<10)|m&1023}if(xe[a>>2]=P,a+=4,a+4>v)break}return xe[a>>2]=0,a-d}function kr(i){for(var a=0,h=0;h<i.length;++h){var d=i.charCodeAt(h);d>=55296&&d<=57343&&++h,a+=4}return a}function Br(i,a){mt.set(i,a)}var Dt,mt,ue,Ge,_e,xe,fe,fr,lr;function ot(i){Dt=i,e.HEAP8=mt=new Int8Array(i),e.HEAP16=Ge=new Int16Array(i),e.HEAP32=xe=new Int32Array(i),e.HEAPU8=ue=new Uint8Array(i),e.HEAPU16=_e=new Uint16Array(i),e.HEAPU32=fe=new Uint32Array(i),e.HEAPF32=fr=new Float32Array(i),e.HEAPF64=lr=new Float64Array(i)}var jn=e.INITIAL_MEMORY||16777216,Mt,Ue=[],Nt=[],hr=[],cr=!1,Ur=0;function Lr(){return at||Ur>0}function Wt(){if(e.preRun)for(typeof e.preRun==\"function\"&&(e.preRun=[e.preRun]);e.preRun.length;)Dr(e.preRun.shift());Yt(Ue)}function $r(){cr=!0,Yt(Nt)}function Or(){if(e.postRun)for(typeof e.postRun==\"function\"&&(e.postRun=[e.postRun]);e.postRun.length;)vt(e.postRun.shift());Yt(hr)}function Dr(i){Ue.unshift(i)}function Mr(i){Nt.unshift(i)}function vt(i){hr.unshift(i)}var Le=0,Qe=null,Ee=null;function He(i){Le++,e.monitorRunDependencies&&e.monitorRunDependencies(Le)}function _t(i){if(Le--,e.monitorRunDependencies&&e.monitorRunDependencies(Le),Le==0&&(Qe!==null&&(clearInterval(Qe),Qe=null),Ee)){var a=Ee;Ee=null,a()}}e.preloadedImages={},e.preloadedAudios={};function Je(i){e.onAbort&&e.onAbort(i),i=\"Aborted(\"+i+\")\",le(i),wt=!0,oe=1,i+=\". Build with -s ASSERTIONS=1 for more info.\";var a=new WebAssembly.RuntimeError(i);throw o(a),a}var Nr=\"data:application/octet-stream;base64,\";function dr(i){return i.startsWith(Nr)}function Vt(i){return i.startsWith(\"file://\")}var te;te=\"libwebp.wasm\",dr(te)||(te=S(te));function Ht(i){try{if(i==te&&ve)return new Uint8Array(ve);if(Z)return Z(i);throw\"both async and sync fetching of the wasm failed\"}catch(a){Je(a)}}function pr(){if(!ve&&(g||F)){if(typeof fetch==\"function\"&&!Vt(te))return fetch(te,{credentials:\"same-origin\"}).then(function(i){if(!i.ok)throw\"failed to load wasm binary file at '\"+te+\"'\";return i.arrayBuffer()}).catch(function(){return Ht(te)});if(W)return new Promise(function(i,a){W(te,function(h){i(new Uint8Array(h))},a)})}return Promise.resolve().then(function(){return Ht(te)})}function gr(){var i={a:Di};function a(P,m){var T=P.exports;e.asm=T,qe=e.asm.r,ot(qe.buffer),Mt=e.asm.z,Mr(e.asm.s),_t(\"wasm-instantiate\")}He(\"wasm-instantiate\");function h(P){a(P.instance)}function d(P){return pr().then(function(m){return WebAssembly.instantiate(m,i)}).then(function(m){return m}).then(P,function(m){le(\"failed to asynchronously prepare wasm: \"+m),Je(m)})}function v(){return!ve&&typeof WebAssembly.instantiateStreaming==\"function\"&&!dr(te)&&!Vt(te)&&!b&&typeof fetch==\"function\"?fetch(te,{credentials:\"same-origin\"}).then(function(P){var m=WebAssembly.instantiateStreaming(P,i);return m.then(h,function(T){return le(\"wasm streaming compile failed: \"+T),le(\"falling back to ArrayBuffer instantiation\"),d(h)})}):d(h)}if(e.instantiateWasm)try{var C=e.instantiateWasm(i,a);return C}catch(P){return le(\"Module.instantiateWasm callback failed with error: \"+P),!1}return v().catch(o),{}}function Yt(i){for(;i.length>0;){var a=i.shift();if(typeof a==\"function\"){a(e);continue}var h=a.func;typeof h==\"number\"?a.arg===void 0?Ye(h)():Ye(h)(a.arg):h(a.arg===void 0?null:a.arg)}}var Et=[];function Ye(i){var a=Et[i];return a||(i>=Et.length&&(Et.length=i+1),Et[i]=a=Mt.get(i)),a}function Wr(i,a,h,d){Je(\"Assertion failed: \"+ee(i)+\", at: \"+[a?ee(a):\"unknown filename\",h,d?ee(d):\"unknown function\"])}function wr(i,a,h,d,v){}function J(i){switch(i){case 1:return 0;case 2:return 1;case 4:return 2;case 8:return 3;default:throw new TypeError(\"Unknown type size: \"+i)}}function yr(){for(var i=new Array(256),a=0;a<256;++a)i[a]=String.fromCharCode(a);ie=i}var ie=void 0;function j(i){for(var a=\"\",h=i;ue[h];)a+=ie[ue[h++]];return a}var Ke={},$e={},ae={},mr=48,Vr=57;function jt(i){if(i===void 0)return\"_unknown\";i=i.replace(/[^a-zA-Z0-9_]/g,\"$\");var a=i.charCodeAt(0);return a>=mr&&a<=Vr?\"_\"+i:i}function Xt(i,a){return i=jt(i),new Function(\"body\",\"return function \"+i+`() {\n    \"use strict\";    return body.apply(this, arguments);\n};\n`)(a)}function Oe(i,a){var h=Xt(a,function(d){this.name=a,this.message=d;var v=new Error(d).stack;v!==void 0&&(this.stack=this.toString()+`\n`+v.replace(/^Error(:[^\\n]*)?\\n/,\"\"))});return h.prototype=Object.create(i.prototype),h.prototype.constructor=h,h.prototype.toString=function(){return this.message===void 0?this.name:this.name+\": \"+this.message},h}var Ze=void 0;function V(i){throw new Ze(i)}var zt=void 0;function bt(i){throw new zt(i)}function st(i,a,h){i.forEach(function(m){ae[m]=a});function d(m){var T=h(m);T.length!==i.length&&bt(\"Mismatched type converter count\");for(var k=0;k<i.length;++k)be(i[k],T[k])}var v=new Array(a.length),C=[],P=0;a.forEach(function(m,T){$e.hasOwnProperty(m)?v[T]=$e[m]:(C.push(m),Ke.hasOwnProperty(m)||(Ke[m]=[]),Ke[m].push(function(){v[T]=$e[m],++P,P===C.length&&d(v)}))}),C.length===0&&d(v)}function be(i,a,h={}){if(!(\"argPackAdvance\"in a))throw new TypeError(\"registerType registeredInstance requires argPackAdvance\");var d=a.name;if(i||V('type \"'+d+'\" must have a positive integer typeid pointer'),$e.hasOwnProperty(i)){if(h.ignoreDuplicateRegistrations)return;V(\"Cannot register type '\"+d+\"' twice\")}if($e[i]=a,delete ae[i],Ke.hasOwnProperty(i)){var v=Ke[i];delete Ke[i],v.forEach(function(C){C()})}}function vr(i,a,h,d,v){var C=J(h);a=j(a),be(i,{name:a,fromWireType:function(P){return!!P},toWireType:function(P,m){return m?d:v},argPackAdvance:8,readValueFromPointer:function(P){var m;if(h===1)m=mt;else if(h===2)m=Ge;else if(h===4)m=xe;else throw new TypeError(\"Unknown boolean type size: \"+a);return this.fromWireType(m[P>>C])},destructorFunction:null})}function Hr(i){if(!(this instanceof De)||!(i instanceof De))return!1;for(var a=this.$$.ptrType.registeredClass,h=this.$$.ptr,d=i.$$.ptrType.registeredClass,v=i.$$.ptr;a.baseClass;)h=a.upcast(h),a=a.baseClass;for(;d.baseClass;)v=d.upcast(v),d=d.baseClass;return a===d&&h===v}function Yr(i){return{count:i.count,deleteScheduled:i.deleteScheduled,preservePointerOnDelete:i.preservePointerOnDelete,ptr:i.ptr,ptrType:i.ptrType,smartPtr:i.smartPtr,smartPtrType:i.smartPtrType}}function qt(i){function a(h){return h.$$.ptrType.registeredClass.name}V(a(i)+\" instance already deleted\")}var Gt=!1;function _r(i){}function jr(i){i.smartPtr?i.smartPtrType.rawDestructor(i.smartPtr):i.ptrType.registeredClass.rawDestructor(i.ptr)}function Er(i){i.count.value-=1;var a=i.count.value===0;a&&jr(i)}function ut(i,a,h){if(a===h)return i;if(h.baseClass===void 0)return null;var d=ut(i,a,h.baseClass);return d===null?null:h.downcast(d)}var Qt={};function Xr(){return Object.keys(lt).length}function zr(){var i=[];for(var a in lt)lt.hasOwnProperty(a)&&i.push(lt[a]);return i}var Fe=[];function Ct(){for(;Fe.length;){var i=Fe.pop();i.$$.deleteScheduled=!1,i.delete()}}var ft=void 0;function qr(i){ft=i,Fe.length&&ft&&ft(Ct)}function Gr(){e.getInheritedInstanceCount=Xr,e.getLiveInheritedInstances=zr,e.flushPendingDeletes=Ct,e.setDelayFunction=qr}var lt={};function Qr(i,a){for(a===void 0&&V(\"ptr should not be undefined\");i.baseClass;)a=i.upcast(a),i=i.baseClass;return a}function Jr(i,a){return a=Qr(i,a),lt[a]}function Pt(i,a){(!a.ptrType||!a.ptr)&&bt(\"makeClassHandle requires ptr and ptrType\");var h=!!a.smartPtrType,d=!!a.smartPtr;return h!==d&&bt(\"Both smartPtrType and smartPtr must be specified\"),a.count={value:1},ht(Object.create(i,{$$:{value:a}}))}function Kr(i){var a=this.getPointee(i);if(!a)return this.destructor(i),null;var h=Jr(this.registeredClass,a);if(h!==void 0){if(h.$$.count.value===0)return h.$$.ptr=a,h.$$.smartPtr=i,h.clone();var d=h.clone();return this.destructor(i),d}function v(){return this.isSmartPointer?Pt(this.registeredClass.instancePrototype,{ptrType:this.pointeeType,ptr:a,smartPtrType:this,smartPtr:i}):Pt(this.registeredClass.instancePrototype,{ptrType:this,ptr:i})}var C=this.registeredClass.getActualType(a),P=Qt[C];if(!P)return v.call(this);var m;this.isConst?m=P.constPointerType:m=P.pointerType;var T=ut(a,this.registeredClass,m.registeredClass);return T===null?v.call(this):this.isSmartPointer?Pt(m.registeredClass.instancePrototype,{ptrType:m,ptr:T,smartPtrType:this,smartPtr:i}):Pt(m.registeredClass.instancePrototype,{ptrType:m,ptr:T})}function ht(i){return typeof FinalizationRegistry>\"u\"?(ht=(a=>a),i):(Gt=new FinalizationRegistry(a=>{Er(a.$$)}),ht=(a=>{var h=a.$$,d=!!h.smartPtr;if(d){var v={$$:h};Gt.register(a,v,a)}return a}),_r=(a=>Gt.unregister(a)),ht(i))}function Zr(){if(this.$$.ptr||qt(this),this.$$.preservePointerOnDelete)return this.$$.count.value+=1,this;var i=ht(Object.create(Object.getPrototypeOf(this),{$$:{value:Yr(this.$$)}}));return i.$$.count.value+=1,i.$$.deleteScheduled=!1,i}function en(){this.$$.ptr||qt(this),this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete&&V(\"Object already scheduled for deletion\"),_r(this),Er(this.$$),this.$$.preservePointerOnDelete||(this.$$.smartPtr=void 0,this.$$.ptr=void 0)}function tn(){return!this.$$.ptr}function rn(){return this.$$.ptr||qt(this),this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete&&V(\"Object already scheduled for deletion\"),Fe.push(this),Fe.length===1&&ft&&ft(Ct),this.$$.deleteScheduled=!0,this}function nn(){De.prototype.isAliasOf=Hr,De.prototype.clone=Zr,De.prototype.delete=en,De.prototype.isDeleted=tn,De.prototype.deleteLater=rn}function De(){}function br(i,a,h){if(i[a].overloadTable===void 0){var d=i[a];i[a]=function(){return i[a].overloadTable.hasOwnProperty(arguments.length)||V(\"Function '\"+h+\"' called with an invalid number of arguments (\"+arguments.length+\") - expects one of (\"+i[a].overloadTable+\")!\"),i[a].overloadTable[arguments.length].apply(this,arguments)},i[a].overloadTable=[],i[a].overloadTable[d.argCount]=d}}function an(i,a,h){e.hasOwnProperty(i)?((h===void 0||e[i].overloadTable!==void 0&&e[i].overloadTable[h]!==void 0)&&V(\"Cannot register public name '\"+i+\"' twice\"),br(e,i,i),e.hasOwnProperty(h)&&V(\"Cannot register multiple overloads of a function with the same number of arguments (\"+h+\")!\"),e[i].overloadTable[h]=a):(e[i]=a,h!==void 0&&(e[i].numArguments=h))}function on(i,a,h,d,v,C,P,m){this.name=i,this.constructor=a,this.instancePrototype=h,this.rawDestructor=d,this.baseClass=v,this.getActualType=C,this.upcast=P,this.downcast=m,this.pureVirtualFunctions=[]}function At(i,a,h){for(;a!==h;)a.upcast||V(\"Expected null or instance of \"+h.name+\", got an instance of \"+a.name),i=a.upcast(i),a=a.baseClass;return i}function sn(i,a){if(a===null)return this.isReference&&V(\"null is not a valid \"+this.name),0;a.$$||V('Cannot pass \"'+N(a)+'\" as a '+this.name),a.$$.ptr||V(\"Cannot pass deleted object as a pointer of type \"+this.name);var h=a.$$.ptrType.registeredClass,d=At(a.$$.ptr,h,this.registeredClass);return d}function un(i,a){var h;if(a===null)return this.isReference&&V(\"null is not a valid \"+this.name),this.isSmartPointer?(h=this.rawConstructor(),i!==null&&i.push(this.rawDestructor,h),h):0;a.$$||V('Cannot pass \"'+N(a)+'\" as a '+this.name),a.$$.ptr||V(\"Cannot pass deleted object as a pointer of type \"+this.name),!this.isConst&&a.$$.ptrType.isConst&&V(\"Cannot convert argument of type \"+(a.$$.smartPtrType?a.$$.smartPtrType.name:a.$$.ptrType.name)+\" to parameter type \"+this.name);var d=a.$$.ptrType.registeredClass;if(h=At(a.$$.ptr,d,this.registeredClass),this.isSmartPointer)switch(a.$$.smartPtr===void 0&&V(\"Passing raw pointer to smart pointer is illegal\"),this.sharingPolicy){case 0:a.$$.smartPtrType===this?h=a.$$.smartPtr:V(\"Cannot convert argument of type \"+(a.$$.smartPtrType?a.$$.smartPtrType.name:a.$$.ptrType.name)+\" to parameter type \"+this.name);break;case 1:h=a.$$.smartPtr;break;case 2:if(a.$$.smartPtrType===this)h=a.$$.smartPtr;else{var v=a.clone();h=this.rawShare(h,U.toHandle(function(){v.delete()})),i!==null&&i.push(this.rawDestructor,h)}break;default:V(\"Unsupporting sharing policy\")}return h}function fn(i,a){if(a===null)return this.isReference&&V(\"null is not a valid \"+this.name),0;a.$$||V('Cannot pass \"'+N(a)+'\" as a '+this.name),a.$$.ptr||V(\"Cannot pass deleted object as a pointer of type \"+this.name),a.$$.ptrType.isConst&&V(\"Cannot convert argument of type \"+a.$$.ptrType.name+\" to parameter type \"+this.name);var h=a.$$.ptrType.registeredClass,d=At(a.$$.ptr,h,this.registeredClass);return d}function ct(i){return this.fromWireType(fe[i>>2])}function ln(i){return this.rawGetPointee&&(i=this.rawGetPointee(i)),i}function hn(i){this.rawDestructor&&this.rawDestructor(i)}function cn(i){i!==null&&i.delete()}function dn(){Ie.prototype.getPointee=ln,Ie.prototype.destructor=hn,Ie.prototype.argPackAdvance=8,Ie.prototype.readValueFromPointer=ct,Ie.prototype.deleteObject=cn,Ie.prototype.fromWireType=Kr}function Ie(i,a,h,d,v,C,P,m,T,k,$){this.name=i,this.registeredClass=a,this.isReference=h,this.isConst=d,this.isSmartPointer=v,this.pointeeType=C,this.sharingPolicy=P,this.rawGetPointee=m,this.rawConstructor=T,this.rawShare=k,this.rawDestructor=$,!v&&a.baseClass===void 0?d?(this.toWireType=sn,this.destructorFunction=null):(this.toWireType=fn,this.destructorFunction=null):this.toWireType=un}function pn(i,a,h){e.hasOwnProperty(i)||bt(\"Replacing nonexistant public symbol\"),e[i].overloadTable!==void 0&&h!==void 0?e[i].overloadTable[h]=a:(e[i]=a,e[i].argCount=h)}function gn(i,a,h){var d=e[\"dynCall_\"+i];return h&&h.length?d.apply(null,[a].concat(h)):d.call(null,a)}function Xn(i,a,h){return i.includes(\"j\")?gn(i,a,h):Ye(a).apply(null,h)}function wn(i,a){var h=[];return function(){return h.length=0,Object.assign(h,arguments),Xn(i,a,h)}}function Me(i,a){i=j(i);function h(){return i.includes(\"j\")?wn(i,a):Ye(a)}var d=h();return typeof d!=\"function\"&&V(\"unknown function pointer with signature \"+i+\": \"+a),d}var Ce=void 0;function Cr(i){var a=zn(i),h=j(a);return Xe(a),h}function Jt(i,a){var h=[],d={};function v(C){if(!d[C]&&!$e[C]){if(ae[C]){ae[C].forEach(v);return}h.push(C),d[C]=!0}}throw a.forEach(v),new Ce(i+\": \"+h.map(Cr).join([\", \"]))}function yn(i,a,h,d,v,C,P,m,T,k,$,O,M){$=j($),C=Me(v,C),m&&(m=Me(P,m)),k&&(k=Me(T,k)),M=Me(O,M);var re=jt($);an(re,function(){Jt(\"Cannot construct \"+$+\" due to unbound types\",[d])}),st([i,a,h],d?[d]:[],function(Y){Y=Y[0];var K,we;d?(K=Y.registeredClass,we=K.instancePrototype):we=De.prototype;var Ft=Xt(re,function(){if(Object.getPrototypeOf(this)!==bn)throw new Ze(\"Use 'new' to construct \"+$);if(It.constructor_body===void 0)throw new Ze($+\" has no accessible constructor\");var Zn=It.constructor_body[arguments.length];if(Zn===void 0)throw new Ze(\"Tried to invoke ctor of \"+$+\" with invalid number of parameters (\"+arguments.length+\") - expected (\"+Object.keys(It.constructor_body).toString()+\") parameters instead!\");return Zn.apply(this,arguments)}),bn=Object.create(we,{constructor:{value:Ft}});Ft.prototype=bn;var It=new on($,Ft,bn,M,K,C,m,k),qi=new Ie($,It,!0,!1,!1),Jn=new Ie($+\"*\",It,!1,!1,!1),Kn=new Ie($+\" const*\",It,!1,!0,!1);return Qt[i]={pointerType:Jn,constPointerType:Kn},pn(re,Ft),[qi,Jn,Kn]})}function Kt(i,a){for(var h=[],d=0;d<i;d++)h.push(xe[(a>>2)+d]);return h}function Tt(i){for(;i.length;){var a=i.pop(),h=i.pop();h(a)}}function Pr(i,a,h,d,v,C){Sr(a>0);var P=Kt(a,h);v=Me(d,v),st([],[i],function(m){m=m[0];var T=\"constructor \"+m.name;if(m.registeredClass.constructor_body===void 0&&(m.registeredClass.constructor_body=[]),m.registeredClass.constructor_body[a-1]!==void 0)throw new Ze(\"Cannot register multiple constructors with identical number of parameters (\"+(a-1)+\") for class '\"+m.name+\"'! Overload resolution is currently only performed using the parameter count, not actual type info!\");return m.registeredClass.constructor_body[a-1]=(()=>{Jt(\"Cannot construct \"+m.name+\" due to unbound types\",P)}),st([],P,function(k){return k.splice(1,0,null),m.registeredClass.constructor_body[a-1]=u(T,k,null,v,C),[]}),[]})}function s(i,a){if(!(i instanceof Function))throw new TypeError(\"new_ called with constructor type \"+typeof i+\" which is not a function\");var h=Xt(i.name||\"unknownFunctionName\",function(){});h.prototype=i.prototype;var d=new h,v=i.apply(d,a);return v instanceof Object?v:d}function u(i,a,h,d,v){var C=a.length;C<2&&V(\"argTypes array size mismatch! Must at least get return value and 'this' types!\");for(var P=a[1]!==null&&h!==null,m=!1,T=1;T<a.length;++T)if(a[T]!==null&&a[T].destructorFunction===void 0){m=!0;break}for(var k=a[0].name!==\"void\",$=\"\",O=\"\",T=0;T<C-2;++T)$+=(T!==0?\", \":\"\")+\"arg\"+T,O+=(T!==0?\", \":\"\")+\"arg\"+T+\"Wired\";var M=\"return function \"+jt(i)+\"(\"+$+`) {\nif (arguments.length !== `+(C-2)+`) {\nthrowBindingError('function `+i+\" called with ' + arguments.length + ' arguments, expected \"+(C-2)+` args!');\n}\n`;m&&(M+=`var destructors = [];\n`);var re=m?\"destructors\":\"null\",Y=[\"throwBindingError\",\"invoker\",\"fn\",\"runDestructors\",\"retType\",\"classParam\"],K=[V,d,v,Tt,a[0],a[1]];P&&(M+=\"var thisWired = classParam.toWireType(\"+re+`, this);\n`);for(var T=0;T<C-2;++T)M+=\"var arg\"+T+\"Wired = argType\"+T+\".toWireType(\"+re+\", arg\"+T+\"); // \"+a[T+2].name+`\n`,Y.push(\"argType\"+T),K.push(a[T+2]);if(P&&(O=\"thisWired\"+(O.length>0?\", \":\"\")+O),M+=(k?\"var rv = \":\"\")+\"invoker(fn\"+(O.length>0?\", \":\"\")+O+`);\n`,m)M+=`runDestructors(destructors);\n`;else for(var T=P?1:2;T<a.length;++T){var we=T===1?\"thisWired\":\"arg\"+(T-2)+\"Wired\";a[T].destructorFunction!==null&&(M+=we+\"_dtor(\"+we+\"); // \"+a[T].name+`\n`,Y.push(we+\"_dtor\"),K.push(a[T].destructorFunction))}k&&(M+=`var ret = retType.fromWireType(rv);\nreturn ret;\n`),M+=`}\n`,Y.push(M);var Ft=s(Function,Y).apply(null,K);return Ft}function c(i,a,h,d,v,C,P,m){var T=Kt(h,d);a=j(a),C=Me(v,C),st([],[i],function(k){k=k[0];var $=k.name+\".\"+a;a.startsWith(\"@@\")&&(a=Symbol[a.substring(2)]),m&&k.registeredClass.pureVirtualFunctions.push(a);function O(){Jt(\"Cannot call \"+$+\" due to unbound types\",T)}var M=k.registeredClass.instancePrototype,re=M[a];return re===void 0||re.overloadTable===void 0&&re.className!==k.name&&re.argCount===h-2?(O.argCount=h-2,O.className=k.name,M[a]=O):(br(M,a,$),M[a].overloadTable[h-2]=O),st([],T,function(Y){var K=u($,Y,k,C,P);return M[a].overloadTable===void 0?(K.argCount=h-2,M[a]=K):M[a].overloadTable[h-2]=K,[]}),[]})}var p=[],w=[{},{value:void 0},{value:null},{value:!0},{value:!1}];function E(i){i>4&&--w[i].refcount===0&&(w[i]=void 0,p.push(i))}function I(){for(var i=0,a=5;a<w.length;++a)w[a]!==void 0&&++i;return i}function x(){for(var i=5;i<w.length;++i)if(w[i]!==void 0)return w[i];return null}function R(){e.count_emval_handles=I,e.get_first_emval=x}var U={toValue:function(i){return i||V(\"Cannot use deleted val. handle = \"+i),w[i].value},toHandle:function(i){switch(i){case void 0:return 1;case null:return 2;case!0:return 3;case!1:return 4;default:{var a=p.length?p.pop():w.length;return w[a]={refcount:1,value:i},a}}}};function H(i,a){a=j(a),be(i,{name:a,fromWireType:function(h){var d=U.toValue(h);return E(h),d},toWireType:function(h,d){return U.toHandle(d)},argPackAdvance:8,readValueFromPointer:ct,destructorFunction:null})}function N(i){if(i===null)return\"null\";var a=typeof i;return a===\"object\"||a===\"array\"||a===\"function\"?i.toString():\"\"+i}function q(i,a){switch(a){case 2:return function(h){return this.fromWireType(fr[h>>2])};case 3:return function(h){return this.fromWireType(lr[h>>3])};default:throw new TypeError(\"Unknown float type: \"+i)}}function he(i,a,h){var d=J(h);a=j(a),be(i,{name:a,fromWireType:function(v){return v},toWireType:function(v,C){return C},argPackAdvance:8,readValueFromPointer:q(a,d),destructorFunction:null})}function Pe(i,a,h){switch(a){case 0:return h?function(v){return mt[v]}:function(v){return ue[v]};case 1:return h?function(v){return Ge[v>>1]}:function(v){return _e[v>>1]};case 2:return h?function(v){return xe[v>>2]}:function(v){return fe[v>>2]};default:throw new TypeError(\"Unknown integer type: \"+i)}}function je(i,a,h,d,v){a=j(a),v===-1&&(v=4294967295);var C=J(h),P=O=>O;if(d===0){var m=32-8*h;P=(O=>O<<m>>>m)}var T=a.includes(\"unsigned\"),k=(O,M)=>{},$;T?$=function(O,M){return k(M,this.name),M>>>0}:$=function(O,M){return k(M,this.name),M},be(i,{name:a,fromWireType:P,toWireType:$,argPackAdvance:8,readValueFromPointer:Pe(a,C,d!==0),destructorFunction:null})}function ge(i,a,h){var d=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array],v=d[a];function C(P){P=P>>2;var m=fe,T=m[P],k=m[P+1];return new v(Dt,k,T)}h=j(h),be(i,{name:h,fromWireType:C,argPackAdvance:8,readValueFromPointer:C},{ignoreDuplicateRegistrations:!0})}function dt(i,a){a=j(a);var h=a===\"std::string\";be(i,{name:a,fromWireType:function(d){var v=fe[d>>2],C;if(h)for(var P=d+4,m=0;m<=v;++m){var T=d+4+m;if(m==v||ue[T]==0){var k=T-P,$=ee(P,k);C===void 0?C=$:(C+=\"\\0\",C+=$),P=T+1}}else{for(var O=new Array(v),m=0;m<v;++m)O[m]=String.fromCharCode(ue[d+4+m]);C=O.join(\"\")}return Xe(d),C},toWireType:function(d,v){v instanceof ArrayBuffer&&(v=new Uint8Array(v));var C,P=typeof v==\"string\";P||v instanceof Uint8Array||v instanceof Uint8ClampedArray||v instanceof Int8Array||V(\"Cannot pass non-string to std::string\"),h&&P?C=(()=>ir(v)):C=(()=>v.length);var m=C(),T=vn(4+m+1);if(fe[T>>2]=m,h&&P)$t(v,T+4,m+1);else if(P)for(var k=0;k<m;++k){var $=v.charCodeAt(k);$>255&&(Xe(T),V(\"String has UTF-16 code units that do not fit in 8 bits\")),ue[T+4+k]=$}else for(var k=0;k<m;++k)ue[T+4+k]=v[k];return d!==null&&d.push(Xe,T),T},argPackAdvance:8,readValueFromPointer:ct,destructorFunction:function(d){Xe(d)}})}function Zt(i,a,h){h=j(h);var d,v,C,P,m;a===2?(d=ar,v=or,P=sr,C=(()=>_e),m=1):a===4&&(d=ur,v=Rr,P=kr,C=(()=>fe),m=2),be(i,{name:h,fromWireType:function(T){for(var k=fe[T>>2],$=C(),O,M=T+4,re=0;re<=k;++re){var Y=T+4+re*a;if(re==k||$[Y>>m]==0){var K=Y-M,we=d(M,K);O===void 0?O=we:(O+=\"\\0\",O+=we),M=Y+a}}return Xe(T),O},toWireType:function(T,k){typeof k!=\"string\"&&V(\"Cannot pass non-string to C++ string type \"+h);var $=P(k),O=vn(4+$+a);return fe[O>>2]=$>>m,v(k,O+4,$+a),T!==null&&T.push(Xe,O),O},argPackAdvance:8,readValueFromPointer:ct,destructorFunction:function(T){Xe(T)}})}function xt(i,a){a=j(a),be(i,{isVoid:!0,name:a,argPackAdvance:0,fromWireType:function(){},toWireType:function(h,d){}})}function et(){Je(\"\")}function mn(i,a,h){ue.copyWithin(i,a,a+h)}function Ui(){return 2147483648}function Li(i){try{return qe.grow(i-Dt.byteLength+65535>>>16),ot(qe.buffer),1}catch{}}function $i(i){var a=ue.length;i=i>>>0;var h=Ui();if(i>h)return!1;let d=(T,k)=>T+(k-T%k)%k;for(var v=1;v<=4;v*=2){var C=a*(1+.2/v);C=Math.min(C,i+100663296);var P=Math.min(h,d(Math.max(i,C),65536)),m=Li(P);if(m)return!0}return!1}function Oi(i){Re(i)}yr(),Ze=e.BindingError=Oe(Error,\"BindingError\"),zt=e.InternalError=Oe(Error,\"InternalError\"),nn(),Gr(),dn(),Ce=e.UnboundTypeError=Oe(Error,\"UnboundTypeError\"),R();var Di={a:Wr,k:wr,i:vr,q:yn,p:Pr,b:c,o:H,h:he,d:je,c:ge,g:dt,e:Zt,j:xt,l:et,n:mn,m:$i,f:Oi},za=gr(),Mi=e.___wasm_call_ctors=function(){return(Mi=e.___wasm_call_ctors=e.asm.s).apply(null,arguments)},Ni=e._decodeRGBA=function(){return(Ni=e._decodeRGBA=e.asm.t).apply(null,arguments)},Wi=e._decodeFree=function(){return(Wi=e._decodeFree=e.asm.u).apply(null,arguments)},Vi=e._allocBuffer=function(){return(Vi=e._allocBuffer=e.asm.v).apply(null,arguments)},vn=e._malloc=function(){return(vn=e._malloc=e.asm.w).apply(null,arguments)},Hi=e._destroyBuffer=function(){return(Hi=e._destroyBuffer=e.asm.x).apply(null,arguments)},Xe=e._free=function(){return(Xe=e._free=e.asm.y).apply(null,arguments)},zn=e.___getTypeName=function(){return(zn=e.___getTypeName=e.asm.A).apply(null,arguments)},Yi=e.___embind_register_native_and_builtin_types=function(){return(Yi=e.___embind_register_native_and_builtin_types=e.asm.B).apply(null,arguments)},qn=e.stackSave=function(){return(qn=e.stackSave=e.asm.C).apply(null,arguments)},Gn=e.stackRestore=function(){return(Gn=e.stackRestore=e.asm.D).apply(null,arguments)},_n=e.stackAlloc=function(){return(_n=e.stackAlloc=e.asm.E).apply(null,arguments)},ji=e.dynCall_ji=function(){return(ji=e.dynCall_ji=e.asm.F).apply(null,arguments)},Xi=e.dynCall_jii=function(){return(Xi=e.dynCall_jii=e.asm.G).apply(null,arguments)},zi=e.dynCall_jiiiii=function(){return(zi=e.dynCall_jiiiii=e.asm.H).apply(null,arguments)};e.cwrap=se;var Ar;function Qn(i){this.name=\"ExitStatus\",this.message=\"Program terminated with exit(\"+i+\")\",this.status=i}Ee=function i(){Ar||En(),Ar||(Ee=i)};function En(i){if(i=i||l,Le>0||(Wt(),Le>0))return;function a(){Ar||(Ar=!0,e.calledRun=!0,!wt&&($r(),n(e),e.onRuntimeInitialized&&e.onRuntimeInitialized(),Or()))}e.setStatus?(e.setStatus(\"Running...\"),setTimeout(function(){setTimeout(function(){e.setStatus(\"\")},1),a()},1)):a()}if(e.run=En,e.preInit)for(typeof e.preInit==\"function\"&&(e.preInit=[e.preInit]);e.preInit.length>0;)e.preInit.pop()();return En(),t.ready})})();typeof Ir==\"object\"&&typeof Wn==\"object\"?Wn.exports=Nn:typeof define==\"function\"&&define.amd?define([],function(){return Nn}):typeof Ir==\"object\"&&(Ir.LibWebP=Nn)});var Ii=tt((go,Fi)=>{X();var Na=Ti(),xi={preset:{n:0,m:5},lossless:{n:0,m:9},quality:{n:0,m:100},method:{n:0,m:6},exact:{n:0,m:1}};function Wa(r){for(let t=0,e=Object.keys(r),n=e.length;t<n;t++){let o=e[t],f=xi[o];if(f&&(r[o]<f.n||r[o]>f.m))throw new Error(`${o} out of range ${f.n}..${f.m}`)}}function Va(r){for(let t=0,e=Object.keys(r),n=e.length;t<n;t++){let o=e[t],f=xi[o];if(f&&(r[o]<f.n||r[o]>f.m))throw new Error(`advanced.${o} out of range ${f.n}..${f.m}`)}}Fi.exports=class{enc=0;async init(){let t=this.Module=await Na();this.api=t.WebPEnc,this.api.getResult=e=>new Uint8Array(new Uint8Array(t.HEAP8.buffer,e.getResult(),e.getResultSize())),this.api.decodeRGBA=t.cwrap(\"decodeRGBA\",\"number\",[\"number\",\"number\"]),this.api.decodeFree=t.cwrap(\"decodeFree\",\"\",[\"number\"]),this.api.allocBuffer=t.cwrap(\"allocBuffer\",\"number\",[\"number\"]),this.api.destroyBuffer=t.cwrap(\"destroyBuffer\",\"\",[\"number\"])}initEnc(){this.enc||(this.enc=new this.Module.WebPEnc)}destroyEnc(){this.enc&&(this.enc.delete(),delete this.enc)}encodeImage(t,e,n,{preset:o,lossless:f,quality:l,method:_,exact:A,advanced:g}={}){let{api:F,Module:b}=this,L,S={},B;return this.initEnc(),B=this.enc,B.init(),Wa({preset:o,lossless:f,quality:l,method:_,exact:A}),o!=null&&B.setPreset(o),f!=null&&B.setLosslessPreset(f),l!=null&&B.setQuality(l),_!=null&&B.setMethod(_),A!=null&&B.setExact(!!A),g!=null&&(Va(g),g.imageHint!=null&&B.advImageHint(g.imageHint),g.targetSize!=null&&B.advTargetSize(g.targetSize),g.targetPSNR!=null&&B.advTargetPSNR(g.targetPSNR),g.segments!=null&&B.advSegments(g.segments),g.snsStrength!=null&&B.advSnsStrength(g.snsStrength),g.filterStrength!=null&&B.advFilterStrength(g.filterStrength),g.filterSharpness!=null&&B.advFilterSharpness(g.filterSharpness),g.filterType!=null&&B.advFilterType(g.filterType),g.autoFilter!=null&&B.advAutoFilter(g.autoFilter),g.alphaCompression!=null&&B.advAlphaCompression(g.alphaCompression),g.alphaFiltering!=null&&B.advAlphaFiltering(g.alphaFiltering),g.alphaQuality!=null&&B.advAlphaQuality(g.alphaQuality),g.pass!=null&&B.advPass(g.pass),g.showCompressed!=null&&B.advShowCompressed(g.showCompressed),g.preprocessing!=null&&B.advPreprocessing(g.preprocessing),g.partitions!=null&&B.advPartitions(g.partitions),g.partitionLimit!=null&&B.advPartitionLimit(g.partitionLimit),g.emulateJpegSize!=null&&B.advEmulateJpegSize(g.emulateJpegSize),g.threadLevel!=null&&B.advThreadLevel(g.threadLevel),g.lowMemory!=null&&B.advLowMemory(g.lowMemory),g.nearLossless!=null&&B.advNearLossless(g.nearLossless),g.useDeltaPalette!=null&&B.advUseDeltaPalette(g.useDeltaPalette),g.useSharpYUV!=null&&B.advUseSharpYUV(g.useSharpYUV),g.qMin!=null&&B.advQMin(g.qMin),g.qMax!=null&&B.advQMax(g.qMax)),L=F.allocBuffer(t.length),b.HEAP8.set(t,L),B.loadRGBA(L,e,n),F.destroyBuffer(L),S.res=B.encode(),S.res==0&&(S.buf=F.getResult(B)),this.destroyEnc(),S}decodeImage(t,e,n){let{api:o,Module:f}=this,l,_,A=o.allocBuffer(t.length);f.HEAP8.set(t,A);let g=o.decodeRGBA(A,t.length);return _=new Uint8Array(new Uint8Array(f.HEAP8.buffer,g,e*n*4)),o.decodeFree(g),o.destroyBuffer(A),_}}});var ki=tt((yo,Ri)=>{X();var{WebPReader:Ha,WebPWriter:Si}=Ai(),tr=$n(),Ya=z.Buffer.from([82,73,70,70,36,0,0,0,87,69,66,80,86,80,56,32,24,0,0,0,48,1,0,157,1,42,1,0,1,0,2,0,52,37,164,0,3,112,0,254,251,253,80,0]),D={TYPE_LOSSY:0,TYPE_LOSSLESS:1,TYPE_EXTENDED:2},rr={LIB_NOT_READY:-1,LIB_INVALID_CONFIG:-2,SUCCESS:0,VP8_ENC_ERROR_OUT_OF_MEMORY:1,VP8_ENC_ERROR_BITSTREAM_OUT_OF_MEMORY:2,VP8_ENC_ERROR_NULL_PARAMETER:3,VP8_ENC_ERROR_INVALID_CONFIGURATION:4,VP8_ENC_ERROR_BAD_DIMENSION:5,VP8_ENC_ERROR_PARTITION0_OVERFLOW:6,VP8_ENC_ERROR_PARTITION_OVERFLOW:7,VP8_ENC_ERROR_BAD_WRITE:8,VP8_ENC_ERROR_FILE_TOO_BIG:9,VP8_ENC_ERROR_USER_ABORT:10,VP8_ENC_ERROR_LAST:11},ja={DEFAULT:0,PICTURE:1,PHOTO:2,GRAPH:3},Xa={DEFAULT:0,PICTURE:1,PHOTO:2,DRAWING:3,ICON:4,TEXT:5},Vn=class r{constructor(){this.data=null,this.loaded=!1,this.path=\"\"}async initLib(){return r.initLib()}clear(){this.data=null,this.path=\"\",this.loaded=!1}get width(){let t=this.data;return this.loaded?t.extended?t.extended.width:t.vp8l?t.vp8l.width:t.vp8?t.vp8.width:void 0:void 0}get height(){let t=this.data;return this.loaded?t.extended?t.extended.height:t.vp8l?t.vp8l.height:t.vp8?t.vp8.height:void 0:void 0}get type(){return this.loaded?this.data.type:void 0}get hasAnim(){return this.loaded&&this.data.extended?this.data.extended.hasAnim:!1}get hasAlpha(){return this.loaded?this.data.extended?this.data.extended.hasAlpha:this.data.vp8?this.data.vp8.alpha:this.data.vp8l?this.data.vp8l.alpha:!1:!1}get anim(){return this.hasAnim?this.data.anim:void 0}get frames(){return this.anim?this.anim.frames:void 0}get iccp(){return this.data.extended&&this.data.extended.hasICCP?this.data.iccp.raw:void 0}set iccp(t){this.data.extended||this._convertToExtended(),t===void 0?(this.data.extended.hasICCP=!1,delete this.data.iccp):(this.data.iccp={raw:t},this.data.extended.hasICCP=!0)}get exif(){return this.data.extended&&this.data.extended.hasEXIF?this.data.exif.raw:void 0}set exif(t){this.data.extended||this._convertToExtended(),t===void 0?(this.data.extended.hasEXIF=!1,delete this.data.exif):(this.data.exif={raw:t},this.data.extended.hasEXIF=!0)}get xmp(){return this.data.extended&&this.data.extended.hasXMP?this.data.xmp.raw:void 0}set xmp(t){this.data.extended||this._convertToExtended(),t===void 0?(this.data.extended.hasXMP=!1,delete this.data.xmp):(this.data.xmp={raw:t},this.data.extended.hasXMP=!0)}_convertToExtended(){if(!this.loaded)throw new Error(\"No image loaded\");this.data.type=D.TYPE_EXTENDED,this.data.extended={hasICCP:!1,hasAlpha:!1,hasEXIF:!1,hasXMP:!1,width:this.data.vp8?this.data.vp8.width:this.data.vp8l?this.data.vp8l.width:1,height:this.data.vp8?this.data.vp8.height:this.data.vp8l?this.data.vp8l.height:1}}async _demuxFrame(t,e){let{hasICCP:n,hasEXIF:o,hasXMP:f}=this.data.extended?this.data.extended:{hasICCP:!1,hasEXIF:!1,hasXMP:!1},l=e.vp8&&e.vp8.alpha,_=new Si;if(typeof t==\"string\"?_.writeFile(t):_.writeBuffer(),_.writeFileHeader(),(n||o||f||l)&&_.writeChunk_VP8X({hasICCP:n,hasEXIF:o,hasXMP:f,hasAlpha:e.vp8l&&e.vp8l.alpha||l,width:e.width,height:e.height}),e.vp8l)_.writeChunk_VP8L(e.vp8l);else if(e.vp8)e.vp8.alpha&&_.writeChunk_ALPH(e.alph),_.writeChunk_VP8(e.vp8);else throw new Error(\"Frame has no VP8/VP8L?\");return(n||o||f||l)&&(this.data.extended.hasICCP&&_.writeChunk_ICCP(this.data.iccp),this.data.extended.hasEXIF&&_.writeChunk_EXIF(this.data.exif),this.data.extended.hasXMP&&_.writeChunk_XMP(this.data.xmp)),_.commit()}async _save(t,{width:e=void 0,height:n=void 0,frames:o=void 0,bgColor:f=[255,255,255,255],loops:l=0,delay:_=100,x:A=0,y:g=0,blend:F=!0,dispose:b=!1,exif:L=!1,iccp:S=!1,xmp:B=!1}={}){let W=e!==void 0?e:this.width-1,Z=n!==void 0?n:this.height-1,Se=this.hasAnim||o!==void 0;if(W<0||W>1<<24)throw new Error(\"Width out of range\");if(Z<0||Z>1<<24)throw new Error(\"Height out of range\");if(Z*W>Math.pow(2,32)-1)throw new Error(`Width * height too large (${W}, ${Z})`);if(Se){if(l<0||l>=1<<24)throw new Error(\"Loops out of range\");if(_<0||_>=1<<24)throw new Error(\"Delay out of range\");if(A<0||A>=1<<24)throw new Error(\"X out of range\");if(g<0||g>=1<<24)throw new Error(\"Y out of range\")}else if(W==0||Z==0)throw new Error(\"Width/height cannot be 0\");switch(t.writeFileHeader(),this.type){case D.TYPE_LOSSY:t.writeChunk_VP8(this.data.vp8);break;case D.TYPE_LOSSLESS:t.writeChunk_VP8L(this.data.vp8l);break;case D.TYPE_EXTENDED:{let me=S===!0?!!this.iccp:S,de=L===!0?!!this.exif:L,Ve=B===!0?!!this.xmp:B;if(t.writeChunk_VP8X({hasICCP:me,hasEXIF:de,hasXMP:Ve,hasAlpha:this.data.alph||this.data.vp8l&&this.data.vp8l.alpha,hasAnim:Se,width:W,height:Z}),me&&t.writeChunk_ICCP(S!==!0?S:this.data.iccp),Se){let it=o||this.frames;t.writeChunk_ANIM({bgColor:f,loops:l});for(let pe=0,le=it.length;pe<le;pe++){let G=it[pe],Re=G.delay==null?_:G.delay,ve=G.x==null?A:G.x,at=G.y==null?g:G.y,qe=G.blend==null?F:G.blend,wt=G.dispose==null?b:G.dispose,oe;if(Re<0||Re>=1<<24)throw new Error(`Delay out of range on frame ${pe}`);if(ve<0||ve>=1<<24)throw new Error(`X out of range on frame ${pe}`);if(at<0||at>=1<<24)throw new Error(`Y out of range on frame ${pe}`);G.path?(oe=new r,await oe.load(G.path),oe=oe.data):G.buffer?(oe=new r,await oe.load(G.buffer),oe=oe.data):G.img?oe=G.img.data:oe=G,t.writeChunk_ANMF({x:ve,y:at,delay:Re,blend:qe,dispose:wt,img:oe})}(W==0||Z==0)&&t.updateChunk_VP8X_size(W==0?t.width:W,Z==0?t.height:Z)}else this.data.vp8?(this.data.alph&&t.writeChunk_ALPH(this.data.alph),t.writeChunk_VP8(this.data.vp8)):this.data.vp8l&&t.writeChunk_VP8L(this.data.vp8l);de&&t.writeChunk_EXIF(L!==!0?L:this.data.exif),Ve&&t.writeChunk_XMP(B!==!0?B:this.data.xmp)}break;default:throw new Error(\"Unknown image type\")}return t.commit()}async load(t){let e=new Ha;typeof t==\"string\"?(tr.avail||await tr.err(),e.readFile(t),this.path=t):e.readBuffer(t),this.data=await e.read(),this.loaded=!0}convertToAnim(){this.data.extended||this._convertToExtended(),!this.hasAnim&&(this.data.vp8&&delete this.data.vp8,this.data.vp8l&&delete this.data.vp8l,this.data.alph&&delete this.data.alph,this.data.extended.hasAnim=!0,this.data.anim={bgColor:[255,255,255,255],loops:0,frames:[]})}async demux({path:t=void 0,buffers:e=!1,frame:n=-1,prefix:o=\"#FNAME#\",start:f=0,end:l=0}={}){if(!this.hasAnim)throw new Error(\"This image isn't an animation\");let _=l==0?this.frames.length:l,A=[];if(f<0&&(f=0),_>=this.frames.length&&(_=this.frames.length-1),f>_){let g=f;f=_,_=g}n!=-1&&(f=_=n);for(let g=f;g<=_;g++){let F=await this._demuxFrame(t?`${t}/${o}_${g}.webp`.replace(/#FNAME#/g,tr.basename(this.path,\".webp\")):void 0,this.anim.frames[g]);e&&A.push(F)}if(e)return A}async replaceFrame(t,e){if(!this.hasAnim)throw new Error(\"WebP isn't animated\");if(typeof t!=\"number\")throw new Error(\"Frame index expects a number\");if(t<0||t>=this.frames.length)throw new Error(`Frame index out of bounds (0 <= index < ${this.frames.length})`);let n=new r,o=this.frames[t];switch(await n.load(e),n.type){case D.TYPE_LOSSY:case D.TYPE_LOSSLESS:break;case D.TYPE_EXTENDED:if(n.hasAnim)throw new Error(\"Merging animations not currently supported\");break;default:throw new Error(\"Unknown WebP type\")}switch(o.type){case D.TYPE_LOSSY:o.vp8.alpha&&delete o.alph,delete o.vp8;break;case D.TYPE_LOSSLESS:delete o.vp8l;break;default:throw new Error(\"Unknown frame type\")}switch(n.type){case D.TYPE_LOSSY:o.vp8=n.data.vp8,o.type=D.TYPE_LOSSY;break;case D.TYPE_LOSSLESS:o.vp8l=n.data.vp8l,o.type=D.TYPE_LOSSLESS;break;case D.TYPE_EXTENDED:n.data.vp8?(o.vp8=n.data.vp8,n.data.vp8.alpha&&(o.alph=n.data.alph),o.type=D.TYPE_LOSSY):n.data.vp8l&&(o.vp8l=n.data.vp8l,o.type=D.TYPE_LOSSLESS);break}o.width=n.width,o.height=n.height}async save(t=this.path,{width:e=this.width,height:n=this.height,frames:o=this.frames,bgColor:f=this.hasAnim?this.anim.bgColor:[255,255,255,255],loops:l=this.hasAnim?this.anim.loops:0,delay:_=100,x:A=0,y:g=0,blend:F=!0,dispose:b=!1,exif:L=!!this.exif,iccp:S=!!this.iccp,xmp:B=!!this.xmp}={}){let W=new Si;return t!==null?(tr.avail||await tr.err(),W.writeFile(t)):W.writeBuffer(),this._save(W,{width:e,height:n,frames:o,bgColor:f,loops:l,delay:_,x:A,y:g,blend:F,dispose:b,exif:L,iccp:S,xmp:B})}async getImageData(){if(!r.libwebp)throw new Error(\"Must call Image.initLib() before using getImageData\");if(this.hasAnim)throw new Error(\"Calling getImageData on animations is not supported\");let t=await this.save(null);return r.libwebp.decodeImage(t,this.width,this.height)}async setImageData(t,{width:e=0,height:n=0,preset:o=void 0,quality:f=void 0,exact:l=void 0,lossless:_=void 0,method:A=void 0,advanced:g=void 0}={}){if(!r.libwebp)throw new Error(\"Must call Image.initLib() before using setImageData\");if(this.hasAnim)throw new Error(\"Calling setImageData on animations is not supported\");if(f!==void 0&&(f<0||f>100))throw new Error(\"Quality out of range\");if(_!==void 0&&(_<0||_>9))throw new Error(\"Lossless preset out of range\");if(A!==void 0&&(A<0||A>6))throw new Error(\"Method out of range\");let F=r.libwebp.encodeImage(t,e>0?e:this.width,n>0?n:this.height,{preset:o,quality:f,exact:l,lossless:_,method:A,advanced:g}),b=new r,L=!1,S;if(F.res!==rr.SUCCESS)return F.res;switch(await b.load(z.Buffer.from(F.buf)),this.type){case D.TYPE_LOSSY:delete this.data.vp8;break;case D.TYPE_LOSSLESS:delete this.data.vp8l;break;case D.TYPE_EXTENDED:S=this.data.extended,delete this.data.extended,(S.hasICCP||S.hasEXIF||S.hasXMP)&&(L=!0),this.data.vp8&&delete this.data.vp8,this.data.vp8l&&delete this.data.vp8l,this.data.alph&&delete this.data.alph;break}switch(b.type){case D.TYPE_LOSSY:L?(this.data.type=D.TYPE_EXTENDED,S.hasAlpha=!1,S.width=b.width,S.height=b.height,this.data.extended=S):this.data.type=D.TYPE_LOSSY,this.data.vp8=b.data.vp8;break;case D.TYPE_LOSSLESS:L?(this.data.type=D.TYPE_EXTENDED,S.hasAlpha=b.data.vp8l.alpha,S.width=b.width,S.height=b.height,this.data.extended=S):this.data.type=D.TYPE_LOSSLESS,this.data.vp8l=b.data.vp8l;break;case D.TYPE_EXTENDED:this.data.type=D.TYPE_EXTENDED,L?(S.hasAlpha=b.data.alph||b.data.vp8l&&b.data.vp8l.alpha,S.width=b.width,S.height=b.height,this.data.extended=S):this.data.extended=b.data.extended,b.data.vp8&&(this.data.vp8=b.data.vp8),b.data.vp8l&&(this.data.vp8l=b.data.vp8l),b.data.alph&&(this.data.alph=b.data.alph);break}return rr.SUCCESS}async getFrameData(t){if(!r.libwebp)throw new Error(\"Must call Image.initLib() before using getFrameData\");if(!this.hasAnim)throw new Error(\"Calling getFrameData on non-animations is not supported\");if(typeof t!=\"number\")throw new Error(\"Frame index expects a number\");if(t<0||t>=this.frames.length)throw new Error(\"Frame index out of range\");let e=this.frames[t],n=await this._demuxFrame(null,e);return r.libwebp.decodeImage(n,e.width,e.height)}async setFrameData(t,e,{width:n=0,height:o=0,preset:f=void 0,quality:l=void 0,exact:_=void 0,lossless:A=void 0,method:g=void 0,advanced:F=void 0}={}){if(!r.libwebp)throw new Error(\"Must call Image.initLib() before using setFrameData\");if(!this.hasAnim)throw new Error(\"Calling setFrameData on non-animations is not supported\");if(typeof t!=\"number\")throw new Error(\"Frame index expects a number\");if(t<0||t>=this.frames.length)throw new Error(\"Frame index out of range\");if(l!==void 0&&(l<0||l>100))throw new Error(\"Quality out of range\");if(A!==void 0&&(A<0||A>9))throw new Error(\"Lossless preset out of range\");if(g!==void 0&&(g<0||g>6))throw new Error(\"Method out of range\");let b=this.frames[t],L=r.libwebp.encodeImage(e,n>0?n:b.width,o>0?o:b.height,{preset:f,quality:l,exact:_,lossless:A,method:g,advanced:F}),S=new r;if(L.res!==rr.SUCCESS)return L.res;switch(await S.load(z.Buffer.from(L.buf)),b.type){case D.TYPE_LOSSY:delete b.vp8,b.alph&&delete b.alph;break;case D.TYPE_LOSSLESS:delete b.vp8l;break}switch(b.width=S.width,b.height=S.height,S.type){case D.TYPE_LOSSY:b.type=S.type,b.vp8=S.data.vp8;break;case D.TYPE_LOSSLESS:b.type=S.type,b.vp8l=S.data.vp8l;break;case D.TYPE_EXTENDED:S.data.vp8?(b.type=D.TYPE_LOSSY,b.vp8=S.data.vp8,S.data.vp8.alpha&&(b.alph=S.data.alph)):S.data.vp8l&&(b.type=D.TYPE_LOSSLESS,b.vp8l=S.data.vp8l);break}return rr.SUCCESS}static async initLib(){if(!r.libwebp){let t=Ii();r.libwebp=new t,await r.libwebp.init()}}static async save(t,e){if(e.frames&&(e.width===void 0||e.height===void 0))throw new Error(\"Must provide both width and height when passing frames\");return(await r.getEmptyImage(!!e.frames)).save(t,e)}static async getEmptyImage(t){let e=new r;return await e.load(Ya),t&&(e.exif=void 0),e}static async generateFrame({path:t=void 0,buffer:e=void 0,img:n=void 0,x:o=void 0,y:f=void 0,delay:l=void 0,blend:_=void 0,dispose:A=void 0}={}){let g=n;if(!t&&!e&&!n||t&&e&&n)throw new Error(\"Must provide either `path`, `buffer`, or `img`\");if(n||(g=new r,t?await g.load(t):await g.load(e)),g.hasAnim)throw new Error(\"Merging animations is not currently supported\");return{img:g,x:o,y:f,delay:l,blend:_,dispose:A}}static from(t){let e=new r;return e.data=t.data,e.loaded=t.loaded,e.path=t.path,e}};Ri.exports={TYPE_LOSSY:D.TYPE_LOSSY,TYPE_LOSSLESS:D.TYPE_LOSSLESS,TYPE_EXTENDED:D.TYPE_EXTENDED,encodeResults:rr,hints:ja,presets:Xa,Image:Vn}});X();X();var Ua=(()=>{var r=import.meta.url;return(function(e={}){var e=typeof e<\"u\"?e:{},n,o;e.ready=new Promise(function(s,u){n=s,o=u});let l=globalThis.ServiceWorkerGlobalScope!==void 0&&typeof self<\"u\"&&globalThis.caches&&globalThis.caches.default!==void 0,_=typeof process==\"object\"&&process.release&&process.release.name===\"node\";(l||_)&&(globalThis.ImageData||(globalThis.ImageData=class{constructor(u,c,p){this.data=u,this.width=c,this.height=p}}),import.meta.url===void 0&&(import.meta.url=\"https://localhost\"),typeof self<\"u\"&&self.location===void 0&&(self.location={href:\"\"}));var A=Object.assign({},e),g=[],F=\"./this.program\",b=(s,u)=>{throw u},L=typeof globalThis==\"object\",S=typeof importScripts==\"function\",B=typeof process==\"object\"&&typeof process.versions==\"object\"&&typeof process.versions.node==\"string\",W=\"\";function Z(s){return e.locateFile?e.locateFile(s,W):W+s}var Se,me,de,Ve;(L||S)&&(S?W=self.location.href:typeof document<\"u\"&&document.currentScript&&(W=document.currentScript.src),r&&(W=r),W.indexOf(\"blob:\")!==0?W=W.substr(0,W.replace(/[?#].*/,\"\").lastIndexOf(\"/\")+1):W=\"\",Se=s=>{var u=new XMLHttpRequest;return u.open(\"GET\",s,!1),u.send(null),u.responseText},S&&(de=s=>{var u=new XMLHttpRequest;return u.open(\"GET\",s,!1),u.responseType=\"arraybuffer\",u.send(null),new Uint8Array(u.response)}),me=(s,u,c)=>{var p=new XMLHttpRequest;p.open(\"GET\",s,!0),p.responseType=\"arraybuffer\",p.onload=()=>{if(p.status==200||p.status==0&&p.response){u(p.response);return}c()},p.onerror=c,p.send(null)},Ve=s=>document.title=s);var it=e.print||console.log.bind(console),pe=e.printErr||console.warn.bind(console);Object.assign(e,A),A=null,e.arguments&&(g=e.arguments),e.thisProgram&&(F=e.thisProgram),e.quit&&(b=e.quit);var le;e.wasmBinary&&(le=e.wasmBinary);var G=e.noExitRuntime||!0;typeof WebAssembly!=\"object\"&&ot(\"no native wasm support detected\");var Re,ve=!1,at;function qe(s,u,c){for(var p=u+c,w=\"\";!(u>=p);){var E=s[u++];if(!E)return w;if(!(E&128)){w+=String.fromCharCode(E);continue}var I=s[u++]&63;if((E&224)==192){w+=String.fromCharCode((E&31)<<6|I);continue}var x=s[u++]&63;if((E&240)==224?E=(E&15)<<12|I<<6|x:E=(E&7)<<18|I<<12|x<<6|s[u++]&63,E<65536)w+=String.fromCharCode(E);else{var R=E-65536;w+=String.fromCharCode(55296|R>>10,56320|R&1023)}}return w}function wt(s,u){return s?qe(se,s,u):\"\"}function oe(s,u,c,p){if(!(p>0))return 0;for(var w=c,E=c+p-1,I=0;I<s.length;++I){var x=s.charCodeAt(I);if(x>=55296&&x<=57343){var R=s.charCodeAt(++I);x=65536+((x&1023)<<10)|R&1023}if(x<=127){if(c>=E)break;u[c++]=x}else if(x<=2047){if(c+1>=E)break;u[c++]=192|x>>6,u[c++]=128|x&63}else if(x<=65535){if(c+2>=E)break;u[c++]=224|x>>12,u[c++]=128|x>>6&63,u[c++]=128|x&63}else{if(c+3>=E)break;u[c++]=240|x>>18,u[c++]=128|x>>12&63,u[c++]=128|x>>6&63,u[c++]=128|x&63}}return u[c]=0,c-w}function Sr(s,u,c){return oe(s,se,u,c)}function nr(s){for(var u=0,c=0;c<s.length;++c){var p=s.charCodeAt(c);p<=127?u++:p<=2047?u+=2:p>=55296&&p<=57343?(u+=4,++c):u+=3}return u}var ke,se,Be,yt,ee,Q,$t,ir;function Ot(){var s=Re.buffer;e.HEAP8=ke=new Int8Array(s),e.HEAP16=Be=new Int16Array(s),e.HEAP32=ee=new Int32Array(s),e.HEAPU8=se=new Uint8Array(s),e.HEAPU16=yt=new Uint16Array(s),e.HEAPU32=Q=new Uint32Array(s),e.HEAPF32=$t=new Float32Array(s),e.HEAPF64=ir=new Float64Array(s)}var ar,or=[],sr=[],ur=[],Rr=!1;function kr(){if(e.preRun)for(typeof e.preRun==\"function\"&&(e.preRun=[e.preRun]);e.preRun.length;)mt(e.preRun.shift());Wt(or)}function Br(){Rr=!0,Wt(sr)}function Dt(){if(e.postRun)for(typeof e.postRun==\"function\"&&(e.postRun=[e.postRun]);e.postRun.length;)Ge(e.postRun.shift());Wt(ur)}function mt(s){or.unshift(s)}function ue(s){sr.unshift(s)}function Ge(s){ur.unshift(s)}var _e=0,xe=null,fe=null;function fr(s){_e++,e.monitorRunDependencies&&e.monitorRunDependencies(_e)}function lr(s){if(_e--,e.monitorRunDependencies&&e.monitorRunDependencies(_e),_e==0&&(xe!==null&&(clearInterval(xe),xe=null),fe)){var u=fe;fe=null,u()}}function ot(s){e.onAbort&&e.onAbort(s),s=\"Aborted(\"+s+\")\",pe(s),ve=!0,at=1,s+=\". Build with -sASSERTIONS for more info.\";var u=new WebAssembly.RuntimeError(s);throw o(u),u}var jn=\"data:application/octet-stream;base64,\";function Mt(s){return s.startsWith(jn)}var Ue;e.locateFile?(Ue=\"webp_enc.wasm\",Mt(Ue)||(Ue=Z(Ue))):Ue=new URL(\"webp_enc.wasm\",import.meta.url).href;function Nt(s){try{if(s==Ue&&le)return new Uint8Array(le);if(de)return de(s);throw\"both async and sync fetching of the wasm failed\"}catch(u){ot(u)}}function hr(s){return!le&&(L||S)&&typeof fetch==\"function\"?fetch(s,{credentials:\"same-origin\"}).then(function(u){if(!u.ok)throw\"failed to load wasm binary file at '\"+s+\"'\";return u.arrayBuffer()}).catch(function(){return Nt(s)}):Promise.resolve().then(function(){return Nt(s)})}function cr(s,u,c){return hr(s).then(function(p){return WebAssembly.instantiate(p,u)}).then(function(p){return p}).then(c,function(p){pe(\"failed to asynchronously prepare wasm: \"+p),ot(p)})}function Ur(s,u,c,p){return!s&&typeof WebAssembly.instantiateStreaming==\"function\"&&!Mt(u)&&typeof fetch==\"function\"?fetch(u,{credentials:\"same-origin\"}).then(function(w){var E=WebAssembly.instantiateStreaming(w,c);return E.then(p,function(I){return pe(\"wasm streaming compile failed: \"+I),pe(\"falling back to ArrayBuffer instantiation\"),cr(u,c,p)})}):cr(u,c,p)}function Lr(){var s={a:gn};function u(p,w){var E=p.exports;return e.asm=E,Re=e.asm.x,Ot(),ar=e.asm.D,ue(e.asm.y),lr(\"wasm-instantiate\"),E}fr(\"wasm-instantiate\");function c(p){u(p.instance)}if(e.instantiateWasm)try{return e.instantiateWasm(s,u)}catch(p){pe(\"Module.instantiateWasm callback failed with error: \"+p),o(p)}return Ur(le,Ue,s,c).catch(o),{}}function Wt(s){for(;s.length>0;)s.shift()(e)}function $r(s){this.excPtr=s,this.ptr=s-24,this.set_type=function(u){Q[this.ptr+4>>2]=u},this.get_type=function(){return Q[this.ptr+4>>2]},this.set_destructor=function(u){Q[this.ptr+8>>2]=u},this.get_destructor=function(){return Q[this.ptr+8>>2]},this.set_refcount=function(u){ee[this.ptr>>2]=u},this.set_caught=function(u){u=u?1:0,ke[this.ptr+12>>0]=u},this.get_caught=function(){return ke[this.ptr+12>>0]!=0},this.set_rethrown=function(u){u=u?1:0,ke[this.ptr+13>>0]=u},this.get_rethrown=function(){return ke[this.ptr+13>>0]!=0},this.init=function(u,c){this.set_adjusted_ptr(0),this.set_type(u),this.set_destructor(c),this.set_refcount(0),this.set_caught(!1),this.set_rethrown(!1)},this.add_ref=function(){var u=ee[this.ptr>>2];ee[this.ptr>>2]=u+1},this.release_ref=function(){var u=ee[this.ptr>>2];return ee[this.ptr>>2]=u-1,u===1},this.set_adjusted_ptr=function(u){Q[this.ptr+16>>2]=u},this.get_adjusted_ptr=function(){return Q[this.ptr+16>>2]},this.get_exception_ptr=function(){var u=Kt(this.get_type());if(u)return Q[this.excPtr>>2];var c=this.get_adjusted_ptr();return c!==0?c:this.excPtr}}var Or=0,Dr=0;function Mr(s,u,c){var p=new $r(s);throw p.init(u,c),Or=s,Dr++,s}var vt={};function Le(s){for(;s.length;){var u=s.pop(),c=s.pop();c(u)}}function Qe(s){return this.fromWireType(ee[s>>2])}var Ee={},He={},_t={},Je=48,Nr=57;function dr(s){if(s===void 0)return\"_unknown\";s=s.replace(/[^a-zA-Z0-9_]/g,\"$\");var u=s.charCodeAt(0);return u>=Je&&u<=Nr?\"_\"+s:s}function Vt(s,u){return s=dr(s),{[s]:function(){return u.apply(this,arguments)}}[s]}function te(s,u){var c=Vt(u,function(p){this.name=u,this.message=p;var w=new Error(p).stack;w!==void 0&&(this.stack=this.toString()+`\n`+w.replace(/^Error(:[^\\n]*)?\\n/,\"\"))});return c.prototype=Object.create(s.prototype),c.prototype.constructor=c,c.prototype.toString=function(){return this.message===void 0?this.name:this.name+\": \"+this.message},c}var Ht=void 0;function pr(s){throw new Ht(s)}function gr(s,u,c){s.forEach(function(x){_t[x]=u});function p(x){var R=c(x);R.length!==s.length&&pr(\"Mismatched type converter count\");for(var U=0;U<s.length;++U)j(s[U],R[U])}var w=new Array(u.length),E=[],I=0;u.forEach((x,R)=>{He.hasOwnProperty(x)?w[R]=He[x]:(E.push(x),Ee.hasOwnProperty(x)||(Ee[x]=[]),Ee[x].push(()=>{w[R]=He[x],++I,I===E.length&&p(w)}))}),E.length===0&&p(w)}function Yt(s){var u=vt[s];delete vt[s];var c=u.rawConstructor,p=u.rawDestructor,w=u.fields,E=w.map(I=>I.getterReturnType).concat(w.map(I=>I.setterArgumentType));gr([s],E,I=>{var x={};return w.forEach((R,U)=>{var H=R.fieldName,N=I[U],q=R.getter,he=R.getterContext,Pe=I[U+w.length],je=R.setter,ge=R.setterContext;x[H]={read:dt=>N.fromWireType(q(he,dt)),write:(dt,Zt)=>{var xt=[];je(ge,dt,Pe.toWireType(xt,Zt)),Le(xt)}}}),[{name:u.name,fromWireType:function(R){var U={};for(var H in x)U[H]=x[H].read(R);return p(R),U},toWireType:function(R,U){for(var H in x)if(!(H in U))throw new TypeError('Missing field:  \"'+H+'\"');var N=c();for(H in x)x[H].write(N,U[H]);return R!==null&&R.push(p,N),N},argPackAdvance:8,readValueFromPointer:Qe,destructorFunction:p}]})}function Et(s,u,c,p,w){}function Ye(s){switch(s){case 1:return 0;case 2:return 1;case 4:return 2;case 8:return 3;default:throw new TypeError(\"Unknown type size: \"+s)}}function Wr(){for(var s=new Array(256),u=0;u<256;++u)s[u]=String.fromCharCode(u);wr=s}var wr=void 0;function J(s){for(var u=\"\",c=s;se[c];)u+=wr[se[c++]];return u}var yr=void 0;function ie(s){throw new yr(s)}function j(s,u,c={}){if(!(\"argPackAdvance\"in u))throw new TypeError(\"registerType registeredInstance requires argPackAdvance\");var p=u.name;if(s||ie('type \"'+p+'\" must have a positive integer typeid pointer'),He.hasOwnProperty(s)){if(c.ignoreDuplicateRegistrations)return;ie(\"Cannot register type '\"+p+\"' twice\")}if(He[s]=u,delete _t[s],Ee.hasOwnProperty(s)){var w=Ee[s];delete Ee[s],w.forEach(E=>E())}}function Ke(s,u,c,p,w){var E=Ye(c);u=J(u),j(s,{name:u,fromWireType:function(I){return!!I},toWireType:function(I,x){return x?p:w},argPackAdvance:8,readValueFromPointer:function(I){var x;if(c===1)x=ke;else if(c===2)x=Be;else if(c===4)x=ee;else throw new TypeError(\"Unknown boolean type size: \"+u);return this.fromWireType(x[I>>E])},destructorFunction:null})}var $e=[],ae=[{},{value:void 0},{value:null},{value:!0},{value:!1}];function mr(s){s>4&&--ae[s].refcount===0&&(ae[s]=void 0,$e.push(s))}function Vr(){for(var s=0,u=5;u<ae.length;++u)ae[u]!==void 0&&++s;return s}function jt(){for(var s=5;s<ae.length;++s)if(ae[s]!==void 0)return ae[s];return null}function Xt(){e.count_emval_handles=Vr,e.get_first_emval=jt}var Oe={toValue:s=>(s||ie(\"Cannot use deleted val. handle = \"+s),ae[s].value),toHandle:s=>{switch(s){case void 0:return 1;case null:return 2;case!0:return 3;case!1:return 4;default:{var u=$e.length?$e.pop():ae.length;return ae[u]={refcount:1,value:s},u}}}};function Ze(s,u){u=J(u),j(s,{name:u,fromWireType:function(c){var p=Oe.toValue(c);return mr(c),p},toWireType:function(c,p){return Oe.toHandle(p)},argPackAdvance:8,readValueFromPointer:Qe,destructorFunction:null})}function V(s,u,c){if(s[u].overloadTable===void 0){var p=s[u];s[u]=function(){return s[u].overloadTable.hasOwnProperty(arguments.length)||ie(\"Function '\"+c+\"' called with an invalid number of arguments (\"+arguments.length+\") - expects one of (\"+s[u].overloadTable+\")!\"),s[u].overloadTable[arguments.length].apply(this,arguments)},s[u].overloadTable=[],s[u].overloadTable[p.argCount]=p}}function zt(s,u,c){e.hasOwnProperty(s)?((c===void 0||e[s].overloadTable!==void 0&&e[s].overloadTable[c]!==void 0)&&ie(\"Cannot register public name '\"+s+\"' twice\"),V(e,s,s),e.hasOwnProperty(c)&&ie(\"Cannot register multiple overloads of a function with the same number of arguments (\"+c+\")!\"),e[s].overloadTable[c]=u):(e[s]=u,c!==void 0&&(e[s].numArguments=c))}function bt(s,u,c){switch(u){case 0:return function(p){var w=c?ke:se;return this.fromWireType(w[p])};case 1:return function(p){var w=c?Be:yt;return this.fromWireType(w[p>>1])};case 2:return function(p){var w=c?ee:Q;return this.fromWireType(w[p>>2])};default:throw new TypeError(\"Unknown integer type: \"+s)}}function st(s,u,c,p){var w=Ye(c);u=J(u);function E(){}E.values={},j(s,{name:u,constructor:E,fromWireType:function(I){return this.constructor.values[I]},toWireType:function(I,x){return x.value},argPackAdvance:8,readValueFromPointer:bt(u,w,p),destructorFunction:null}),zt(u,E)}function be(s){var u=Cr(s),c=J(u);return Ce(u),c}function vr(s,u){var c=He[s];return c===void 0&&ie(u+\" has unknown type \"+be(s)),c}function Hr(s,u,c){var p=vr(s,\"enum\");u=J(u);var w=p.constructor,E=Object.create(p.constructor.prototype,{value:{value:c},constructor:{value:Vt(p.name+\"_\"+u,function(){})}});w.values[c]=E,w[u]=E}function Yr(s,u){switch(u){case 2:return function(c){return this.fromWireType($t[c>>2])};case 3:return function(c){return this.fromWireType(ir[c>>3])};default:throw new TypeError(\"Unknown float type: \"+s)}}function qt(s,u,c){var p=Ye(c);u=J(u),j(s,{name:u,fromWireType:function(w){return w},toWireType:function(w,E){return E},argPackAdvance:8,readValueFromPointer:Yr(u,p),destructorFunction:null})}function Gt(s,u,c,p,w,E){var I=u.length;I<2&&ie(\"argTypes array size mismatch! Must at least get return value and 'this' types!\");for(var x=u[1]!==null&&c!==null,R=!1,U=1;U<u.length;++U)if(u[U]!==null&&u[U].destructorFunction===void 0){R=!0;break}var H=u[0].name!==\"void\",N=I-2,q=new Array(N),he=[],Pe=[];return function(){arguments.length!==N&&ie(\"function \"+s+\" called with \"+arguments.length+\" arguments, expected \"+N+\" args!\"),Pe.length=0;var je;he.length=x?2:1,he[0]=w,x&&(je=u[1].toWireType(Pe,this),he[1]=je);for(var ge=0;ge<N;++ge)q[ge]=u[ge+2].toWireType(Pe,arguments[ge]),he.push(q[ge]);var dt=p.apply(null,he);function Zt(xt){if(R)Le(Pe);else for(var et=x?1:2;et<u.length;et++){var mn=et===1?je:q[et-2];u[et].destructorFunction!==null&&u[et].destructorFunction(mn)}if(H)return u[0].fromWireType(xt)}return Zt(dt)}}function _r(s,u){for(var c=[],p=0;p<s;p++)c.push(Q[u+p*4>>2]);return c}function jr(s,u,c){e.hasOwnProperty(s)||pr(\"Replacing nonexistant public symbol\"),e[s].overloadTable!==void 0&&c!==void 0?e[s].overloadTable[c]=u:(e[s]=u,e[s].argCount=c)}function Er(s,u,c){var p=e[\"dynCall_\"+s];return c&&c.length?p.apply(null,[u].concat(c)):p.call(null,u)}var ut=[];function Qt(s){var u=ut[s];return u||(s>=ut.length&&(ut.length=s+1),ut[s]=u=ar.get(s)),u}function Xr(s,u,c){if(s.includes(\"j\"))return Er(s,u,c);var p=Qt(u).apply(null,c);return p}function zr(s,u){var c=[];return function(){return c.length=0,Object.assign(c,arguments),Xr(s,u,c)}}function Fe(s,u){s=J(s);function c(){return s.includes(\"j\")?zr(s,u):Qt(u)}var p=c();return typeof p!=\"function\"&&ie(\"unknown function pointer with signature \"+s+\": \"+u),p}var Ct=void 0;function ft(s,u){var c=[],p={};function w(E){if(!p[E]&&!He[E]){if(_t[E]){_t[E].forEach(w);return}c.push(E),p[E]=!0}}throw u.forEach(w),new Ct(s+\": \"+c.map(be).join([\", \"]))}function qr(s,u,c,p,w,E,I){var x=_r(u,c);s=J(s),w=Fe(p,w),zt(s,function(){ft(\"Cannot call \"+s+\" due to unbound types\",x)},u-1),gr([],x,function(R){var U=[R[0],null].concat(R.slice(1));return jr(s,Gt(s,U,null,w,E,I),u-1),[]})}function Gr(s,u,c){switch(u){case 0:return c?function(w){return ke[w]}:function(w){return se[w]};case 1:return c?function(w){return Be[w>>1]}:function(w){return yt[w>>1]};case 2:return c?function(w){return ee[w>>2]}:function(w){return Q[w>>2]};default:throw new TypeError(\"Unknown integer type: \"+s)}}function lt(s,u,c,p,w){u=J(u),w===-1&&(w=4294967295);var E=Ye(c),I=N=>N;if(p===0){var x=32-8*c;I=N=>N<<x>>>x}var R=u.includes(\"unsigned\"),U=(N,q)=>{},H;R?H=function(N,q){return U(q,this.name),q>>>0}:H=function(N,q){return U(q,this.name),q},j(s,{name:u,fromWireType:I,toWireType:H,argPackAdvance:8,readValueFromPointer:Gr(u,E,p!==0),destructorFunction:null})}function Qr(s,u,c){var p=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array],w=p[u];function E(I){I=I>>2;var x=Q,R=x[I],U=x[I+1];return new w(x.buffer,U,R)}c=J(c),j(s,{name:c,fromWireType:E,argPackAdvance:8,readValueFromPointer:E},{ignoreDuplicateRegistrations:!0})}function Jr(s,u){u=J(u);var c=u===\"std::string\";j(s,{name:u,fromWireType:function(p){var w=Q[p>>2],E=p+4,I;if(c)for(var x=E,R=0;R<=w;++R){var U=E+R;if(R==w||se[U]==0){var H=U-x,N=wt(x,H);I===void 0?I=N:(I+=\"\\0\",I+=N),x=U+1}}else{for(var q=new Array(w),R=0;R<w;++R)q[R]=String.fromCharCode(se[E+R]);I=q.join(\"\")}return Ce(p),I},toWireType:function(p,w){w instanceof ArrayBuffer&&(w=new Uint8Array(w));var E,I=typeof w==\"string\";I||w instanceof Uint8Array||w instanceof Uint8ClampedArray||w instanceof Int8Array||ie(\"Cannot pass non-string to std::string\"),c&&I?E=nr(w):E=w.length;var x=Me(4+E+1),R=x+4;if(Q[x>>2]=E,c&&I)Sr(w,R,E+1);else if(I)for(var U=0;U<E;++U){var H=w.charCodeAt(U);H>255&&(Ce(R),ie(\"String has UTF-16 code units that do not fit in 8 bits\")),se[R+U]=H}else for(var U=0;U<E;++U)se[R+U]=w[U];return p!==null&&p.push(Ce,x),x},argPackAdvance:8,readValueFromPointer:Qe,destructorFunction:function(p){Ce(p)}})}function Pt(s,u){for(var c=\"\",p=0;!(p>=u/2);++p){var w=Be[s+p*2>>1];if(w==0)break;c+=String.fromCharCode(w)}return c}function Kr(s,u,c){if(c===void 0&&(c=2147483647),c<2)return 0;c-=2;for(var p=u,w=c<s.length*2?c/2:s.length,E=0;E<w;++E){var I=s.charCodeAt(E);Be[u>>1]=I,u+=2}return Be[u>>1]=0,u-p}function ht(s){return s.length*2}function Zr(s,u){for(var c=0,p=\"\";!(c>=u/4);){var w=ee[s+c*4>>2];if(w==0)break;if(++c,w>=65536){var E=w-65536;p+=String.fromCharCode(55296|E>>10,56320|E&1023)}else p+=String.fromCharCode(w)}return p}function en(s,u,c){if(c===void 0&&(c=2147483647),c<4)return 0;for(var p=u,w=p+c-4,E=0;E<s.length;++E){var I=s.charCodeAt(E);if(I>=55296&&I<=57343){var x=s.charCodeAt(++E);I=65536+((I&1023)<<10)|x&1023}if(ee[u>>2]=I,u+=4,u+4>w)break}return ee[u>>2]=0,u-p}function tn(s){for(var u=0,c=0;c<s.length;++c){var p=s.charCodeAt(c);p>=55296&&p<=57343&&++c,u+=4}return u}function rn(s,u,c){c=J(c);var p,w,E,I,x;u===2?(p=Pt,w=Kr,I=ht,E=()=>yt,x=1):u===4&&(p=Zr,w=en,I=tn,E=()=>Q,x=2),j(s,{name:c,fromWireType:function(R){for(var U=Q[R>>2],H=E(),N,q=R+4,he=0;he<=U;++he){var Pe=R+4+he*u;if(he==U||H[Pe>>x]==0){var je=Pe-q,ge=p(q,je);N===void 0?N=ge:(N+=\"\\0\",N+=ge),q=Pe+u}}return Ce(R),N},toWireType:function(R,U){typeof U!=\"string\"&&ie(\"Cannot pass non-string to C++ string type \"+c);var H=I(U),N=Me(4+H+u);return Q[N>>2]=H>>x,w(U,N+4,H+u),R!==null&&R.push(Ce,N),N},argPackAdvance:8,readValueFromPointer:Qe,destructorFunction:function(R){Ce(R)}})}function nn(s,u,c,p,w,E){vt[s]={name:J(u),rawConstructor:Fe(c,p),rawDestructor:Fe(w,E),fields:[]}}function De(s,u,c,p,w,E,I,x,R,U){vt[s].fields.push({fieldName:J(u),getterReturnType:c,getter:Fe(p,w),getterContext:E,setterArgumentType:I,setter:Fe(x,R),setterContext:U})}function br(s,u){u=J(u),j(s,{isVoid:!0,name:u,argPackAdvance:0,fromWireType:function(){},toWireType:function(c,p){}})}var an={};function on(s){var u=an[s];return u===void 0?J(s):u}function At(){if(typeof globalThis==\"object\")return globalThis;function s(u){u.$$$embind_global$$$=u;var c=typeof $$$embind_global$$$==\"object\"&&u.$$$embind_global$$$==u;return c||delete u.$$$embind_global$$$,c}if(typeof $$$embind_global$$$==\"object\"||(typeof global==\"object\"&&s(global)?$$$embind_global$$$=global:typeof self==\"object\"&&s(self)&&($$$embind_global$$$=self),typeof $$$embind_global$$$==\"object\"))return $$$embind_global$$$;throw Error(\"unable to get global object.\")}function sn(s){return s===0?Oe.toHandle(At()):(s=on(s),Oe.toHandle(At()[s]))}function un(s){s>4&&(ae[s].refcount+=1)}function fn(s){var u=new Array(s+1);return function(c,p,w){u[0]=c;for(var E=0;E<s;++E){var I=vr(Q[p+E*4>>2],\"parameter \"+E);u[E+1]=I.readValueFromPointer(w),w+=I.argPackAdvance}var x=new(c.bind.apply(c,u));return Oe.toHandle(x)}}var ct={};function ln(s,u,c,p){s=Oe.toValue(s);var w=ct[u];return w||(w=fn(u),ct[u]=w),w(s,c,p)}function hn(){ot(\"\")}function cn(s,u,c){se.copyWithin(s,u,u+c)}function dn(){return 2147483648}function Ie(s){var u=Re.buffer;try{return Re.grow(s-u.byteLength+65535>>>16),Ot(),1}catch{}}function pn(s){var u=se.length;s=s>>>0;var c=dn();if(s>c)return!1;let p=(R,U)=>R+(U-R%U)%U;for(var w=1;w<=4;w*=2){var E=u*(1+.2/w);E=Math.min(E,s+100663296);var I=Math.min(c,p(Math.max(s,E),65536)),x=Ie(I);if(x)return!0}return!1}Ht=e.InternalError=te(Error,\"InternalError\"),Wr(),yr=e.BindingError=te(Error,\"BindingError\"),Xt(),Ct=e.UnboundTypeError=te(Error,\"UnboundTypeError\");var gn={k:Mr,m:Yt,o:Et,t:Ke,s:Ze,q:st,d:Hr,h:qt,f:qr,c:lt,b:Qr,i:Jr,e:rn,n:nn,a:De,u:br,j:mr,w:sn,l:un,v:ln,g:hn,r:cn,p:pn},Xn=Lr(),wn=function(){return(wn=e.asm.y).apply(null,arguments)},Me=function(){return(Me=e.asm.z).apply(null,arguments)},Ce=function(){return(Ce=e.asm.A).apply(null,arguments)},Cr=e.___getTypeName=function(){return(Cr=e.___getTypeName=e.asm.B).apply(null,arguments)},Jt=e.__embind_initialize_bindings=function(){return(Jt=e.__embind_initialize_bindings=e.asm.C).apply(null,arguments)},yn=function(){return(yn=e.asm.__errno_location).apply(null,arguments)},Kt=function(){return(Kt=e.asm.E).apply(null,arguments)},Tt;fe=function s(){Tt||Pr(),Tt||(fe=s)};function Pr(){if(_e>0||(kr(),_e>0))return;function s(){Tt||(Tt=!0,e.calledRun=!0,!ve&&(Br(),n(e),e.onRuntimeInitialized&&e.onRuntimeInitialized(),Dt()))}e.setStatus?(e.setStatus(\"Running...\"),setTimeout(function(){setTimeout(function(){e.setStatus(\"\")},1),s()},1)):s()}if(e.preInit)for(typeof e.preInit==\"function\"&&(e.preInit=[e.preInit]);e.preInit.length>0;)e.preInit.pop()();return Pr(),e.ready})})(),Ei=Ua;X();var bi={quality:75,target_size:0,target_PSNR:0,method:4,sns_strength:50,filter_strength:60,filter_sharpness:0,filter_type:1,partitions:0,segments:4,pass:1,show_compressed:0,preprocessing:0,autofilter:0,partition_limit:0,alpha_compression:1,alpha_filtering:1,alpha_quality:100,lossless:0,exact:0,image_hint:0,emulate_jpeg_size:0,thread_level:0,low_memory:0,near_lossless:100,use_delta_palette:0,use_sharp_yuv:0};var Yn=Cn(ki()),Bi=Cn(Un()),Hn;self.onmessage=async({data:{bytes:r,wasm:t}})=>{let e;try{Hn||(Hn=Ei({wasmBinary:t,locateFile:()=>\"https://local.invalid/split-encoder.wasm\"}));let n=await Hn,o=String.fromCharCode(...r.slice(0,4))===\"RIFF\"?\"image/webp\":r[0]===71?\"image/gif\":r[0]===137?\"image/png\":\"image/jpeg\";e=new ImageDecoder({data:r,type:o}),await e.tracks.ready;let f=e.tracks.selectedTrack,l=Array.from({length:9},()=>[]),_,A,g;for(let L=0;L<f.frameCount;L++){let{image:S}=await e.decode({frameIndex:L});try{_||(g=Math.ceil(Math.max(S.displayWidth,S.displayHeight)/3),_=new OffscreenCanvas(g,g),A=_.getContext(\"2d\",{willReadFrequently:!0}));let B=g*3,W=B/Math.max(S.displayWidth,S.displayHeight),Z=S.displayWidth*W,Se=S.displayHeight*W;for(let me=0;me<9;me++){A.clearRect(0,0,g,g),A.drawImage(S,(B-Z)/2-me%3*g,(B-Se)/2-Math.floor(me/3)*g,Z,Se);let de=n.encode(A.getImageData(0,0,g,g).data,g,g,{...bi,lossless:1,quality:75,method:0,exact:1});if(!de)throw Error(\"\\uBD84\\uD560 \\uC774\\uBBF8\\uC9C0 \\uC778\\uCF54\\uB529\\uC5D0 \\uC2E4\\uD328\\uD588\\uC2B5\\uB2C8\\uB2E4.\");l[me].push({buffer:Bi.Buffer.from(de),delay:Math.max(1,Math.round((S.duration??1e5)/1e3)),blend:!1,dispose:!1})}}finally{S.close()}}let F=Number.isFinite(f.repetitionCount)?f.repetitionCount+1:0,b=[];for(let L of l){let S=L.length===1?L[0].buffer:await Yn.Image.save(null,{width:g,height:g,loops:F,frames:await Promise.all(L.map(B=>Yn.Image.generateFrame(B)))});b.push(new Uint8Array(S).buffer)}self.postMessage({tiles:b},b)}catch(n){self.postMessage({error:n.message||String(n)})}finally{e?.close()}};\n";
// END GENERATED SPLIT WORKER

// Pinned libwebp WASM tools. No native executable or model runtime is required.
const WebPCache = {
  generation: 0, work: Promise.resolve(), assets: new Map(), downloads: new Set(),
  specs: {
    split: {source: SPLIT_WORKER_SOURCE,
      wasmURL: "https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/codec/enc/webp_enc.wasm",
      hashes: [null, "b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7"]},
    gif: {name: "gif2webp", version: "1.0.8", hashes: ["2cdc53ad32a68c4a99e7bb44fbf7b0a8a35fa0a2f4ba2f099345d9c02cffb3ed", "ae49d60df26fac796041ee0956873d7a33d05ffab3fbb123dfb7106654f1f748"]},
    img: {name: "img2webp", version: "1.0.0", hashes: ["dc9e869dc195aebdf55a4866ee788e7ba6fe69b4e7fb144c275a756e9d9cf7bb", "109f43681b260e9fe30aa909533b19a4438abc73a8e3da4837df5eadf0d1ac86"]},
  },
  async runtime(kind, generation) {
    if (this.assets.has(kind)) return this.assets.get(kind);
    const task = (async () => {
      const spec = this.specs[kind], result = [];
      for (const [index, extension] of ["js", "wasm"].entries()) {
        if (index === 0 && spec.source) {result.push(new TextEncoder().encode(spec.source)); continue;}
        const hash = spec.hashes[index], digest = bytes => require("crypto").createHash("sha256").update(bytes).digest("hex");
        const target = require("path").join(BdApi.Plugins.folder, "discord-dccon-cache", "webp-codecs", hash);
        let bytes;
        try {bytes = await imageFS("readFile", target, null);} catch { /* Download the pinned codec once. */ }
        if (!bytes || typeof bytes === "string" || digest(bytes) !== hash) {
          if (generation !== this.generation) throw Error("WebP 변환 중단됨");
          const controller = new AbortController(); this.downloads.add(controller);
          try {
            const response = await BdApi.Net.fetch(spec.wasmURL || `https://cdn.jsdelivr.net/npm/@libwebp-wasm/${spec.name}@${spec.version}/es/${spec.name}.${extension}`,
              {responseType: "arraybuffer", signal: controller.signal});
            if (response.ok === false || response.status >= 400) throw Error("WebP 변환기 다운로드 실패");
            bytes = new Uint8Array(await response.arrayBuffer());
            if (digest(bytes) !== hash) throw Error("WebP 변환기 무결성 확인 실패");
            if (generation !== this.generation) throw Error("WebP 변환 중단됨");
            await imageFS("mkdir", require("path").dirname(target), {recursive: true});
            await imageFS("writeFile", target + ".tmp", bytes);
            await imageFS("rename", target + ".tmp", target);
          } finally {this.downloads.delete(controller);}
        }
        result.push(new Uint8Array(bytes));
      }
      return {source: new TextDecoder().decode(result[0]), wasm: result[1]};
    })();
    this.assets.set(kind, task);
    try {return await task;} catch (error) {if (this.assets.get(kind) === task) this.assets.delete(kind); throw error;}
  },
  workerMain() {
    const tools = new Map();
    self.onmessage = async ({data: {bytes, kind, runtime, frames, loopCount = 0, compositeGif = false}}) => {
      try {
        if (!tools.has(kind)) {
          const url = URL.createObjectURL(new Blob([runtime.source], {type: "text/javascript"}));
          try {tools.set(kind, {lib: await import(url), wasm: runtime.wasm});}
          finally {URL.revokeObjectURL(url);}
        }
        const {lib, wasm} = tools.get(kind);
        // Fresh instances reclaim CLI argv allocations and GIF decoder state between images.
        const wasmURL = URL.createObjectURL(new Blob([wasm], {type: "application/wasm"}));
        // This codec build has no wasmBinary hook. Serve its WASM fetch from
        // memory inside this dedicated worker; Discord CSP can block blob fetches.
        const fetch = self.fetch;
        self.fetch = (input, options) => input === wasmURL
          ? Promise.resolve(new Response(wasm, {headers: {"Content-Type": "application/wasm"}}))
          : fetch(input, options);
        let module;
        try {module = await (kind === "gif" ? lib.Gif2Webp : lib.Img2Webp)({locateFile: () => wasmURL});}
        finally {self.fetch = fetch; URL.revokeObjectURL(wasmURL);}
        if (compositeGif) {
          // Chromium accepts out-of-bounds GIF rectangles and composites them on the logical screen.
          const decoder = new ImageDecoder({data: bytes, type: "image/gif"});
          try {
            await decoder.tracks.ready;
            const track = decoder.tracks.selectedTrack;
            loopCount = Number.isFinite(track.repetitionCount) ? track.repetitionCount + 1 : 0;
            frames = [];
            for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
              const {image} = await decoder.decode({frameIndex});
              try {
                const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
                canvas.getContext("2d").drawImage(image, 0, 0);
                const png = await canvas.convertToBlob({type: "image/png"});
                frames.push({bytes: new Uint8Array(await png.arrayBuffer()),
                  duration: Math.max(1, Math.round((image.duration ?? 100000) / 1000))});
              } finally {image.close();}
            }
          } finally {decoder.close();}
        }
        module.FS.writeFile("/input", new Uint8Array(bytes));
        const args = frames ? ["-loop", String(loopCount), "-lossless", "-m", "4", ...frames.flatMap((frame, index) => {
          const name = `/frame${index}.png`; module.FS.writeFile(name, frame.bytes);
          return ["-d", String(frame.duration), name];
        }), "-o", "/output.webp"] : kind === "gif" ? ["-quiet", "-m", "4", "/input", "-o", "/output.webp"]
          : ["-lossless", "-m", "4", "/input", "-o", "/output.webp"];
        const parsed = (kind === "gif" ? lib.parseGif2WebpArgs : lib.parseImg2WebpArgs)(module, args);
        if (module._main(...parsed) !== 0) throw Object.assign(Error("이미지를 WebP로 변환하지 못했습니다."),
          {gifFrameError: kind === "gif"});
        const output = module.FS.readFile("/output.webp");
        self.postMessage({bytes: output.buffer}, [output.buffer]);
      } catch (error) {self.postMessage({error: error.message || String(error), gifFrameError: error.gifFrameError === true});}
    };
  },
  convert(bytes, frames, loopCount = 0) {
    if (isWebP(bytes)) return Promise.resolve(bytes);
    const generation = this.generation;
    const task = this.work.then(async () => {
      const encode = async (kind, compositeGif = false) => {
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
        const worker = this.worker;
        return new Promise((resolve, reject) => {
          this.reject = reject;
          worker.onmessage = ({data}) => {
            this.reject = null;
            if (data.error) return reject(Object.assign(Error(data.error), {gifFrameError: data.gifFrameError === true}));
            const converted = new Uint8Array(data.bytes);
            if (!isWebP(converted)) return reject(Error("WebP 변환 결과가 올바르지 않습니다."));
            this.workerKinds.add(kind);
            resolve(converted);
          };
          worker.onerror = () => {this.stop(); reject(Error("WebP 변환기 실행 실패"));};
          worker.postMessage({bytes, kind, frames, loopCount, compositeGif,
            runtime: this.workerKinds.has(kind) ? undefined : runtime});
        });
      };
      const kind = String.fromCharCode(...bytes.slice(0, 4)) === "GIF8" ? "gif" : "img";
      try {return await encode(kind);}
      catch (error) {
        if (!error.gifFrameError || kind !== "gif") throw error;
        return encode("img", true);
      }
    });
    this.work = task.catch(() => {});
    return task;
  },
  split(bytes) {
    const generation = this.generation;
    const task = this.work.then(async () => {
      if (generation !== this.generation) throw Error("이미지 분할이 중단되었습니다.");
      const runtime = await this.runtime("split", generation);
      if (generation !== this.generation) throw Error("이미지 분할이 중단되었습니다.");
      const first = !this.splitWorker;
      if (first) {
        const url = URL.createObjectURL(new Blob([runtime.source], {type: "text/javascript"}));
        try {this.splitWorker = new Worker(url, {type: "module"});} finally {URL.revokeObjectURL(url);}
      }
      const worker = this.splitWorker;
      return new Promise((resolve, reject) => {
        this.reject = reject;
        worker.onmessage = ({data}) => {
          this.reject = null;
          if (data.error) {worker.terminate(); this.splitWorker = null; reject(Error(data.error));}
          else resolve(data.tiles);
        };
        worker.onerror = () => {this.stop(); reject(Error("분할 인코더 실행 실패"));};
        worker.postMessage({bytes, wasm: first ? runtime.wasm : undefined}, [bytes.buffer]);
      });
    });
    this.work = task.catch(() => {});
    return task;
  },
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
const imageRequests = new Map();
async function getDCConImage(con) {
  const key = con.path + ":" + con.ext;
  if (imageRequests.has(key)) return imageRequests.get(key);
  const request = (async () => {
    if (con.path.startsWith("personal:")) {
      const target = personalFile(con);
      const bytes = await imageFS("readFile", target, null);
      if (typeof bytes === "string") throw Error("개별 콘 파일을 읽지 못했습니다.");
      return webpFile(bytes);
    }
    let fs, cachePath;
    try {
      if (typeof require === "function" && BdApi.Plugins?.folder) {
        // BetterDiscord's fs polyfill exposes callbacks, not fs.promises.
        const filesystem = require("fs");
        fs = Object.fromEntries(["readFile", "mkdir", "writeFile", "rename"].map(method => [method,
          (...args) => new Promise((resolve, reject) => filesystem[method](...args,
            (error, result) => error ? reject(error) : resolve(result))),
        ]));
        const directory = require("path").join(BdApi.Plugins.folder, "discord-dccon-cache");
        cachePath = require("path").join(directory, require("crypto").createHash("sha256").update(key).digest("hex"));
        const cached = await fs.readFile(cachePath, null);
        // BetterDiscord defaults to UTF-8, unlike Node. Never construct an image from text.
        if (typeof cached === "string") throw Object.assign(new Error("Cache returned text"), {code: "CACHE_NOT_BINARY"});
        if (cached.length) return webpFile(cached);
      }
    } catch { /* Missing or unreadable cache: fetch the original. */ }
    const response = await BdApi.Net.fetch(DCConBaseURL + con.path, {
      responseType: "arraybuffer", headers: { Referer: "https://dcimg5.dcinside.com" },
    });
    if (response.ok === false || response.status >= 400) throw new Error("디시콘 다운로드에 실패했습니다.");
    const contentType = response.headers?.get?.("content-type");
    if (contentType && /text\/html|application\/json/i.test(contentType)) throw new Error("이미지가 아닌 응답을 받았습니다.");
    const original = new Uint8Array(await response.arrayBuffer());
    if (!original.length) throw new Error("디시콘 이미지가 비어 있습니다.");
    const bytes = await WebPCache.convert(original);
    if (fs && cachePath) {
      try {
        await fs.mkdir(require("path").dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath + ".tmp", bytes);
        await fs.rename(cachePath + ".tmp", cachePath);
      } catch (error) {
        BdApi.Logger.error("discord-dccon", "Image cache write failed", error);
      }
    }
    return webpFile(bytes);
  })();
  imageRequests.set(key, request);
  try { return await request; } finally { imageRequests.delete(key); }
}

let cacheGeneration = 0;
let cacheWork = Promise.resolve();
function warmCache(cons) {
  if (typeof require !== "function" || !BdApi.Plugins?.folder) return;
  const generation = cacheGeneration;
  cacheWork = cacheWork.then(async () => {
    for (const con of cons) {
      if (generation !== cacheGeneration) return;
      try { await getDCConImage(con); } catch (error) { BdApi.Logger.error("discord-dccon", "Cache preload failed", error); }
    }
  });
}

let lastMessageNonce = 0n;
let lastSendAttempt = null;
const queuedCons = new Map();
const channelTasks = new Map();
const sendingChannels = new Set();
function activeQueue(channelId) { return queuedCons.get(channelId) ?? []; }
function updateQueue(channelId, entries) {
  queuedCons.set(channelId, entries);
  PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
}
function removeBuffered(channelId, entry) {
  if (sendingChannels.has(channelId)) return;
  updateQueue(channelId, entry ? activeQueue(channelId).filter(item => item !== entry) : []);
}

function markSend(attempt, phase, details = {}) {
  Object.assign(attempt, details, { phase, updatedAt: new Date().toISOString() });
}

function sendErrorDetails(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || "오류 설명 없음").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 400),
    status: error?.status ?? error?.statusCode ?? null,
    code: error?.body?.code ?? error?.code ?? null,
  };
}

function isDiscordRest(value) {
  return value !== null && typeof value === "object" &&
    ["post", "get", "put", "del"].every(key => typeof value[key] === "function");
}

function responseShape(response) {
  const body = response?.body;
  const header = response?.headers?.get?.("content-type") ?? response?.headers?.["content-type"];
  const keys = value => value && typeof value === "object" ? Object.keys(value).slice(0, 30) : [];
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

async function sendImagesDirectly(files, channelId, attempt) {
  markSend(attempt, "모듈 조회");
  const CloudUpload = BdApi.Webpack.getModule(value => typeof value === "function" &&
    typeof value.prototype?.trackUploadFinished === "function" && typeof value.prototype?.upload === "function",
    { searchExports: true });
  const rest = BdApi.Webpack.getModule(isDiscordRest, { searchExports: true });
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
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        // Listener cleanup must not prevent a completed upload from settling.
        try {
          const remove = upload.off ?? upload.removeListener;
          remove?.call(upload, "complete", complete);
          remove?.call(upload, "error", fail);
        } catch (error) { attempt.cleanupError = sendErrorDetails(error); }
      };
      const complete = () => { cleanup(); markSend(attempt, "Discord 업로드 완료", { hasUploadedFilename: Boolean(upload.uploadedFilename) }); resolve(); };
      const fail = error => {
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
      try { Promise.resolve(upload.upload()).catch(fail); } catch (error) { fail(error); }
    });
    if (!upload.uploadedFilename) throw new Error("업로드 결과에 파일 경로가 없습니다.");
    attachments.push({ id: String(index), filename: upload.filename || file.name, uploaded_filename: upload.uploadedFilename });
  }
  await postDCCon(rest, channelId, attempt, attachments);
}

async function postDCCon(rest, channelId, attempt, attachments) {
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
  markSend(attempt, "메시지 생성 응답", {
    responseShape: responseShape(response),
    httpStatus: response?.status ?? null,
    apiCode: response?.body?.code ?? null,
    hasMessageId: Boolean(response?.body?.id),
  });
  if (response?.ok === false || response?.status >= 400) {
    throw new Error(`메시지 전송 실패 (HTTP ${response.status ?? "오류"}).`);
  }
  if (!response?.body?.id) throw new Error("전송 성공을 확인할 수 없습니다. 채널과 진단 결과를 확인해 주세요. 자동 재전송하지 않습니다.");
}

let bufferGeneration = 0;

async function splitImageIntoNine(file, checkActive) {
  checkActive();
  const tiles = await WebPCache.split(new Uint8Array(await file.arrayBuffer()));
  checkActive();
  return tiles.map((bytes, index) => {
    const tile = webpFile(new Uint8Array(bytes));
    return new File([tile], `dccon-${index + 1}.${tile.name.split(".").pop()}`, {type: tile.type});
  });
}

// 디시콘 메시지 전송 함수
const sendDCConMessage = (con, { keepOpen = false, channelId = currentChannelId, splitNine = false } = {}) => {
  const startedAt = new Date().toISOString();
  const generation = bufferGeneration;
  if (sendingChannels.has(channelId)) return Promise.resolve(false);
  const sending = !keepOpen;
  if (sending) sendingChannels.add(channelId);
  PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
  const attempt = { startedAt, outcome: "진행 중", keepOpen, phase: "작업 대기",
    mode: keepOpen ? "버퍼 누적" : "즉시 전송" };
  const task = (channelTasks.get(channelId) ?? Promise.resolve()).then(async () => {
    lastSendAttempt = attempt;
    try {
      if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
      markSend(attempt, "채널 확인", { hasChannel: Boolean(channelId) });
      if (!channelId) throw new Error("현재 채널을 찾을 수 없습니다.");
      if (splitNine && (con || keepOpen || activeQueue(channelId).length !== 1))
        throw Error("이미지를 정확히 1개 모았을 때만 9개로 나눠 보낼 수 있습니다.");
      if (!con && !activeQueue(channelId).length) return false;
      if (keepOpen && activeQueue(channelId).length >= 9)
        throw new Error("최대 9개까지 모을 수 있습니다. 일반 클릭으로 마지막 콘과 함께 보내세요.");
      markSend(attempt, "캐시 / 이미지 준비");
      const image = con ? await getDCConImage(con) : null;
      attempt.imageBytes = image?.size ?? 0;
      if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
      markSend(attempt, "전송 준비");
      let sentCons = [con];
      if (keepOpen) {
        markSend(attempt, "버퍼 추가");
        updateQueue(channelId, [...activeQueue(channelId), {file: image, con}]);
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
        await sendImagesDirectly(files, channelId, attempt);
        if (generation === bufferGeneration) updateQueue(channelId, []);
        sentCons = [...queued.map(entry => entry.con), ...(con ? [con] : [])];
        markSend(attempt, "완료", { outcome: "전송 성공 확인", sentCount: files.length });
      }
      if (sending) {
        let recent = loadData("recent", []);
        for (const item of sentCons) recent = [item, ...recent.filter(entry => entry.path !== item.path)].slice(0, 20);
        saveData("recent", recent);
        PluginEvents.dispatch({ type: "DCCON_RECENT_UPDATE" });
      }
      if (sending) PluginEvents.dispatch({ type: "DCCON_CLOSE", channelId });
      return true;
    } catch (error) {
      attempt.outcome = "실패";
      attempt.error = sendErrorDetails(error);
      attempt.updatedAt = new Date().toISOString();
      BdApi.Logger.error("discord-dccon", "Failed to send discord-dccon:", error);
      BdApi.UI.showToast("디시콘 전송 실패 (" + attempt.phase + "): " + error.message, { type: "error", timeout: 10000 });
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

class BufferTray extends BdApi.React.Component {
  constructor(props) {
    super(props);
    this.refresh = () => this.forceUpdate();
  }
  componentDidMount() { PluginEvents.subscribe("DCCON_BUFFER_UPDATE", this.refresh); }
  componentWillUnmount() { PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refresh); }
  render() {
    const h = BdApi.React.createElement;
    const channelId = this.props.channelId;
    const entries = activeQueue(channelId);
    const busy = sendingChannels.has(channelId);
    if (!entries.length && !busy) return null;
    return h("section", { className: "dccon-buffer", "aria-label": "전송 대기 디시콘" },
      h("div", { className: "dccon-buffer-heading" },
        h("span", {role: "status"}, busy ? "전송 중…" : "모아둔 콘 " + entries.length + "/9"),
        h("div", {className: "dccon-buffer-actions"},
          h("button", {type: "button", disabled: busy, onClick: () => removeBuffered(channelId)}, "전체 비우기"),
          h("button", {type: "button", className: "dccon-buffer-send", disabled: busy || !entries.length,
            onClick: () => sendDCConMessage(null, {channelId})}, "전송"))),
      h("div", {className: "dccon-buffer-preview"},
        h("div", {className: "dccon-buffer-items", "data-count": entries.length}, entries.map((entry, index) => h("button", {
        key: index, type: "button", disabled: busy, title: entry.con.title + " 제거",
        "aria-label": entry.con.title + " 제거", onClick: () => removeBuffered(channelId, entry),
      }, h("div", {className: "dccon-buffer-media"}, h(BufferImage, {file: entry.file, title: entry.con.title})),
        h("span", {className: "dccon-buffer-order", "aria-hidden": true}, index + 1),
        h("span", {className: "dccon-buffer-remove", "aria-hidden": true}, "×"))))),
      h("button", {type: "button", className: "dccon-buffer-split", disabled: busy || entries.length !== 1,
        title: "이미지 1개를 3×3으로 나눠 전송합니다. 애니메이션은 유지됩니다.",
        onClick: () => sendDCConMessage(null, {channelId, splitNine: true})}, "9개로 쪼개서 보내기"),
      h("p", {className: "dccon-buffer-hint"}, "예상 배치 · 기기마다 크기는 달라질 수 있어요. 일반 클릭은 콘을 하나 더 추가해 전송합니다."));
  }
}
class BufferImage extends BdApi.React.Component {
  constructor(props) { super(props); this.state = {url: null}; }
  componentDidMount() { this.setState({url: URL.createObjectURL(this.props.file)}); }
  componentDidUpdate(previous) {
    if (previous.file !== this.props.file) {
      URL.revokeObjectURL(this.state.url);
      this.setState({url: URL.createObjectURL(this.props.file)});
    }
  }
  componentWillUnmount() { if (this.state.url) URL.revokeObjectURL(this.state.url); }
  render() { return this.state.url && BdApi.React.createElement("img", {src: this.state.url, alt: this.props.title, className: this.props.className}); }
}

class PersonalImage extends BdApi.React.Component {
  constructor(props) { super(props); this.state = {file: null}; }
  componentDidMount() {
    getDCConImage(this.props.con).then(file => {
      if (!this.disposed) this.setState({file});
    }).catch(() => { if (!this.disposed) this.props.onError?.(); });
  }
  componentWillUnmount() { this.disposed = true; }
  render() { return this.state.file && BdApi.React.createElement(BufferImage, {file: this.state.file, title: this.props.con.title, className: this.props.className}); }
}

class PersonalConManager extends BdApi.React.Component {
  constructor(props) {
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
  async work(action) {
    if (this.working) return;
    this.working = true;
    this.controller = new AbortController();
    this.setState({busy: true, message: ""});
    try { await action(this.controller.signal); }
    catch (error) { if (!this.disposed) this.setState({message: error.message}); }
    finally { this.working = false; if (!this.disposed) this.setState({busy: false}); }
  }
  open() {
    this.setState({open: true, input: "", title: "", prepared: null});
    return this.work(async signal => {
      let text;
      try {
        try { text = await require("electron").clipboard.readText(); }
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
    const h = BdApi.React.createElement, s = this.state;
    return h("div", {className: "dccon-personal"},
      h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.open()}, "콘 추가"),
      s.open && h("form", {className: "dccon-personal-form", onSubmit: event => {event.preventDefault(); this.add();}},
        h("label", null, "이미지 링크", h("input", {value: s.input, disabled: s.busy, placeholder: "디시콘 · 아카콘 이미지 URL", onChange: e => this.setState({input: e.target.value, prepared: null})})),
        h("label", null, "이름 (선택)", h("input", {value: s.title, disabled: s.busy, maxLength: 100, onChange: e => this.setState({title: e.target.value})})),
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

class PackThumbnail extends BdApi.React.Component {
  constructor(props) {
    super(props);
    this.state = { index: 0 };
  }

  render() {
    const { pack, className } = this.props;
    if (pack.info.package_idx === PERSONAL_PACK) {
      const con = pack.detail[0];
      return con ? BdApi.React.createElement(PersonalImage, {key: con.path, con, className}) : null;
    }
    const paths = [...new Set([pack.info.main_img_path, pack.detail[0]?.path, pack.info.list_img_path].filter(Boolean))];
    if (!paths[this.state.index]) {
      return BdApi.React.createElement("span", { className, "aria-hidden": true }, pack.info.title.slice(0, 1));
    }
    const next = () => this.setState(state => ({ index: state.index + 1 }));
    return BdApi.React.createElement("img", {
      className, alt: "", src: DCConProxyURL + paths[this.state.index], loading: "lazy",
      onError: next,
      onLoad: event => { if (event.currentTarget.naturalWidth <= 1 || event.currentTarget.naturalHeight <= 1) next(); },
    });
  }
}

// 카테고리 컴포넌트
class DCConCategory extends BdApi.React.Component {
  constructor(props) {
    super(props);
    this.state = {
      expanded: !loadData("collapsedPacks", {})[String(props.dccon.info.package_idx)],
    };
  }

  render() {
    const { dccon } = this.props;
    const strings = getLocaleStrings();

    return BdApi.React.createElement(
      "div",
      { className: "dccon-category" },
      BdApi.React.createElement(
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
        BdApi.React.createElement(PackThumbnail, {
          pack: dccon,
          className: "dccon-category-icon",
        }),
        BdApi.React.createElement(
          "div",
          { className: "dccon-category-name" },
          dccon.info.title
        ),
        BdApi.React.createElement(
          "div",
          { className: "dccon-category-toggle" },
          BdApi.React.createElement(
            "svg",
            {
              width: "24",
              height: "24",
              viewBox: "0 0 24 24",
            },
            BdApi.React.createElement("path", {
              fill: "currentColor",
              d: this.state.expanded
                ? "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"
                : "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
            })
          )
        )
      ),
      this.state.expanded &&
        BdApi.React.createElement(
          "div",
          { className: "dccon-items" },
          dccon.detail.map((con) =>
            BdApi.React.createElement(DCConItem, {
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
class DCConItem extends BdApi.React.Component {
  constructor(props) {
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

  async attach(event) {
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
    const h = BdApi.React.createElement;
    const { con } = this.props;
    return h("div", { className: "dccon-tile" },
      h("button", { type: "button", title: con.title + " · Shift+클릭: 이미지 모아두기",
        "aria-label": con.title, className: "dccon-item", disabled: this.state.busy || this.state.error,
        onClick: event => this.attach(event),
      }, this.state.error ? h("span", { className: "dccon-item-error" }, "이미지 로드 실패")
        : con.path.startsWith("personal:") ? h(PersonalImage, {con, onError: () => this.setState({error: true})})
        : h("img", { src: DCConProxyURL + con.path, alt: con.title, loading: "lazy", onError: () => this.setState({ error: true }) }),
        this.state.busy && h("span", { className: "dccon-loading", role: "status" }, "처리 중…")
      ),
      h("button", { type: "button", className: "dccon-favorite", "aria-label": this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가",
        title: this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가", "aria-pressed": this.state.favorite, onClick: () => this.toggleFavorite(),
      }, this.state.favorite ? "★" : "☆")
    );
  }
}

// 디시콘 패널 컴포넌트 업데이트
class DCConPanel extends BdApi.React.Component {
  constructor(props) {
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

  changeSearch(text) {
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
      } catch (error) {
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
    const h = BdApi.React.createElement;
    const packs = this.filterDccons();
    const query = this.state.textFilter.trim().toLowerCase();
    const isFavorites = this.state.selected === "favorites";
    const semantic = Embedding.enabled() && Boolean(query);
    const semanticResults = (this.state.semanticResults || []).filter(({con}) => {
      if (this.state.selected === "all") return true;
      if (["favorites", "recent"].includes(this.state.selected)) return loadData(this.state.selected, []).some(item => item.path === con.path);
      return String(con.packageIdx) === this.state.selected;
    }).slice(0, 60);
    const recent = loadData(isFavorites ? "favorites" : "recent", []).filter(con => !query || con.title.toLowerCase().includes(query));
    const select = id => {
      this.setState({ selected: id });
      this.content?.scrollTo?.({ top: 0 });
    };
    const navButton = (id, label, child) => h("button", {
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
            autoFocus: true, value: this.state.textFilter,
            onChange: e => this.changeSearch(e.target.value),
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
        h("div", { className: "dccon-browser-content", ref: element => { this.content = element; } },
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
      h("div", { className: "dccon-footer" }, "클릭: 누적 콘과 함께 전송 · Shift+클릭: 모아두기 (최대 9개)")
    );
  }
}

// #region Settings
// 데이터 저장/로드 유틸리티 함수들
function loadData(key, defaultData) {
  defaultData = structuredClone(defaultData);

  // BetterDiscord can return the cached object. Never share it with React state.
  const data = structuredClone(BdApi.Data.load("discord-dccon", key));
  if (data == null) return defaultData;

  // 기본값 처리
  for (const k in defaultData) {
    if (data[k] == null && defaultData[k] != null) {
      data[k] = defaultData[k];
    }
  }

  return data;
}

function saveData(key, data) {
  BdApi.Data.save("discord-dccon", key, data);
  if (["dccons", "personalCons"].includes(key) && Embedding.enabled()) void Embedding.index();
}

function uniquePacks(packs) {
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
const getDCConSearchResult = (query) => {
  return new Promise((resolve, reject) => {
    BdApi.Net.fetch(
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
            const idx = el.href.split("#")[1];
            const thumbId = el.children[0].src.split("=")[1];
            const name = el.children[1].innerText;
            const seller = el.children[2].innerText;

            return { idx, thumbId, name, seller };
          }
        );

        resolve(results);
      })
      .catch((err) => reject(err));
  });
};

// 버튼 컴포넌트
const Button = (props) => {
  return BdApi.React.createElement(
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
class DCConCard extends BdApi.React.Component {
  constructor(props) {
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

    return BdApi.React.createElement(
      "div",
      {
        className: "dccon-card",
      },
      BdApi.React.createElement("img", {
        src: `${DCConProxyURL}${item.thumbId}`,
        style: { borderRadius: "8px" },
      }),
      BdApi.React.createElement(
        "div",
        { className: "dccon-card-content" },
        BdApi.React.createElement("h3", {}, item.name),
        BdApi.React.createElement("span", {}, item.seller),
        BdApi.React.createElement(Button, {
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
              BdApi.UI.showToast("디시콘이 추가되었습니다.", {
                type: "success",
              });
            } catch (err) {
              BdApi.Logger.error("discord-dccon", "디시콘 추가 실패:", err);
              BdApi.UI.showToast("디시콘 추가에 실패했습니다.", {
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
class SavedDCConCard extends BdApi.React.Component {
  render() {
    const { dccon } = this.props;
    const strings = getLocaleStrings();

    return BdApi.React.createElement(
      "div",
      {
        className: "dccon-card",
      },
      BdApi.React.createElement(PackThumbnail, {
        pack: dccon,
        style: { borderRadius: "8px" },
      }),
      BdApi.React.createElement(
        "div",
        { className: "dccon-card-content" },
        BdApi.React.createElement("h3", {}, dccon.info.title),
        BdApi.React.createElement(
          "span",
          {},
          `${dccon.detail.length}개의 디시콘`
        ),
        BdApi.React.createElement("div", {className: "dccon-pack-actions"},
        BdApi.React.createElement("div", {className: "dccon-pack-order", role: "group", "aria-label": dccon.info.title + " 순서 조절"},
          ...[[-1, "위로", this.props.isFirst], [1, "아래로", this.props.isLast]].map(([direction, label, disabled]) =>
            BdApi.React.createElement("button", {key: direction, type: "button", disabled,
              "aria-label": dccon.info.title + " " + label, onClick: () => this.props.onMove(direction)}, label))),
        BdApi.React.createElement(Button, {
          text: strings.settings.remove,
          color: "dccon-item-error",
          onClick: () => {
            const dccons = loadPacks();
            const newDccons = dccons.filter(
              (d) => String(d.info.package_idx) !== String(dccon.info.package_idx)
            );
            saveData("dccons", newDccons);
            this.props.onRemove(dccon.info.package_idx);
            BdApi.UI.showToast("디시콘이 제거되었습니다.", { type: "success" });
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
  const { Webpack } = BdApi;
  const report = {};
  const check = (name, inspect) => {
    try { report[name] = inspect(); }
    catch (error) { report[name] = `Lookup failed: ${error.message}`; }
  };
  check("CloudUpload", () => Boolean(Webpack.getModule(
    value => typeof value === "function" &&
      typeof value.prototype?.trackUploadFinished === "function" &&
      typeof value.prototype?.upload === "function",
    { searchExports: true }
  )));
  check("REST post/get/put/del", () => Boolean(Webpack.getModule(
    isDiscordRest,
    { searchExports: true }
  )));
  check("MessageActions.sendMessage", () => Boolean(Webpack.getByKeys("sendMessage")));
  for (const name of ["DraftStore", "UploadAttachmentStore", "PendingReplyStore", "SelectedChannelStore"]) {
    check(name, () => Boolean(Webpack.getStore?.(name)));
  }
  report.lastSendAttempt = lastSendAttempt ? structuredClone(lastSendAttempt) : "아직 전송 시도 없음";
  return report;
}

const EMBEDDING_SPEC = "q8-image560-video6x280-v2";
function readEmbeddingVectors(saved) {
  if (!["q8-560-gif3-browser-v1", EMBEDDING_SPEC].includes(saved?.spec) || !saved.vectors) return {};
  return Object.fromEntries(Object.entries(saved.vectors).filter(([key, vector]) =>
    (saved.spec === EMBEDDING_SPEC || !key.endsWith(":gif")) && Array.isArray(vector) &&
    vector.length === 768 && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < 0.001));
}

// Runs in a browser Worker: no Node, native addons, or local PoC server required.
async function embeddingWorker() {
  let model, processor, RawImage, RawVideo, RawVideoFrame, requestId = 0, work = Promise.resolve();
  const downloads = new Map();
  const nativeFetch = self.fetch.bind(self);
  self.fetch = (url, options) => String(url).startsWith("blob:") ? nativeFetch(url, options) : new Promise((resolve, reject) => {
    const id = ++requestId;
    downloads.set(id, {resolve, reject});
    self.postMessage({download: id, url: String(url).replace("/resolve/main/", "/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/")});
  });
  const normalize = vector => {
    const norm = Math.hypot(...vector);
    if (vector.length !== 768 || !Number.isFinite(norm) || !norm) throw Error("유효하지 않은 임베딩 결과");
    return Array.from(vector, value => value / norm);
  };
  const embed = async (text, images, video = null) => {
    const inputs = await processor(text, images, null, video);
    let output;
    try { output = await model(inputs); return normalize(output.sentence_embedding.data); }
    finally {
      for (const tensor of Object.values(inputs)) tensor?.dispose?.();
      for (const tensor of Object.values(output || {})) tensor?.dispose?.();
    }
  };
  const decode = async (bytes, type) => {
    const images = [], frames = [];
    let video = null;
    const add = async source => {
      const canvas = new OffscreenCanvas(source.displayWidth || source.width, source.displayHeight || source.height);
      const ctx = canvas.getContext("2d", {willReadFrequently: true});
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8ClampedArray(canvas.width * canvas.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) {rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];}
      images.push(new RawImage(rgb, canvas.width, canvas.height, 3));
    };
    if (type === "image/gif" || type === "image/webp") {
      if (typeof ImageDecoder === "undefined") throw Error("이 환경은 GIF 프레임 디코딩을 지원하지 않습니다.");
      const decoder = new ImageDecoder({data: bytes, type});
      try {
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack.frameCount, durations = [];
        for (let i = 0; i < count; i++) {
          const {image} = await decoder.decode({frameIndex: i});
          durations.push(Math.max(1, image.duration || 100000)); image.close();
        }
        const total = durations.reduce((a, b) => a + b, 0), selected = new Set();
        for (let i = 0; i < Math.min(6, count); i++) {
          if (count <= 6) {selected.add(i); continue;}
          const target = total * (i + 0.5) / 6;
          let elapsed = 0;
          selected.add(durations.findIndex(duration => (elapsed += duration) > target));
        }
        for (const frameIndex of selected) {
          const {image} = await decoder.decode({frameIndex});
          try {
            await add(image);
            frames.push(new RawVideoFrame(images.at(-1), durations.slice(0, frameIndex).reduce((a, b) => a + b, 0) / 1000000));
          } finally {image.close();}
        }
        if (count > 1) video = new RawVideo(frames, total / 1000000);
      } finally {decoder.close();}
    } else {
      const bitmap = await createImageBitmap(new Blob([bytes], {type}));
      try {await add(bitmap);} finally {bitmap.close();}
    }
    return {images: video ? null : images, video};
  };
  self.onmessage = ({data}) => {
    if (data.download) {
      const task = downloads.get(data.download); downloads.delete(data.download);
      if (data.error) task.reject(Error(data.error));
      else task.resolve(new Response(data.bytes, {status: 200, headers: {"Content-Length": String(data.bytes.byteLength)}}));
      return;
    }
    work = work.then(async () => {
      try {
        let result;
        if (data.action === "init") {
          const lib = await import(data.library);
          RawImage = lib.RawImage; RawVideo = lib.RawVideo; RawVideoFrame = lib.RawVideoFrame;
          lib.env.allowLocalModels = false; lib.env.useBrowserCache = false; lib.env.useWasmCache = false;
          lib.env.backends.onnx.wasm.numThreads = 1;
          lib.env.backends.onnx.wasm.wasmBinary = data.wasm;
          lib.env.backends.onnx.wasm.wasmPaths = {mjs: data.factory};
          const options = {revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0"};
          const name = "onnx-community/embeddinggemma-2-ONNX";
          processor = await lib.AutoProcessor.from_pretrained(name, options);
          processor.image_processor.max_soft_tokens = 560;
          processor.video_processor.frame_processor.max_soft_tokens = 280;
          processor.video_processor.max_frames = 6;
          const config = await lib.AutoConfig.from_pretrained(name, options); config.audio_config = null;
          model = await lib.AutoModel.from_pretrained(name, {...options, config, device: "webgpu", dtype: "q8"});
          result = {device: "webgpu"};
        } else if (data.action === "image") {
          const decoded = await decode(data.bytes, data.type);
          result = await embed(null, decoded.images, decoded.video);
        }
        else if (data.action === "query") result = await embed("task: search result | query: " + data.text);
        self.postMessage({id: data.id, result});
      } catch (error) {self.postMessage({id: data.id, error: String(error.message || error)});}
    });
  };
}

const Embedding = {
  worker: null, generation: 0, sequence: 0, pending: new Map(), vectors: {}, dirtyVectors: 0, urls: [],
  assetRequests: new Map(), downloads: new Set(), searchSequence: 0, searchWork: Promise.resolve(),
  status: {phase: "꺼짐", completed: 0, total: 0, errors: 0},
  enabled() {return loadData("embeddingEnabled", false) === true;},
  key(con) {return con.path + ":" + con.ext;},
  update(changes) {
    Object.assign(this.status, changes);
    PluginEvents.dispatch({type: "DCCON_EMBEDDING_UPDATE"});
  },
  files() {
    const fs = require("fs");
    return Object.fromEntries(["readFile", "writeFile", "mkdir", "rename"].map(method => [method,
      (...args) => new Promise((resolve, reject) => fs[method](...args, (error, value) => error ? reject(error) : resolve(value))),
    ]));
  },
  directory() {return require("path").join(BdApi.Plugins.folder, "discord-dccon-cache", "embedding-gemma2");},
  async download(url, generation) {
    // BetterDiscord's automatic redirect handler cannot resolve relative Location headers.
    for (let redirects = 0; redirects <= 8; redirects++) {
      if (generation !== this.generation) throw Error("임베딩 중단됨");
      const controller = new AbortController();
      this.downloads.add(controller);
      let response;
      try {response = await BdApi.Net.fetch(url, {responseType: "arraybuffer", redirect: "manual", signal: controller.signal});}
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
    if (this.assetRequests.has(key)) return this.assetRequests.get(key);
    const request = this.readAsset(url, generation, expectedHash);
    this.assetRequests.set(key, request);
    try {return await request;} finally {this.assetRequests.delete(key);}
  },
  async readAsset(url, generation, expectedHash) {
    const fs = this.files(), hash = bytes => require("crypto").createHash("sha256").update(bytes).digest("hex");
    const file = require("path").join(this.directory(), hash(url));
    let bytes;
    try {bytes = await fs.readFile(file, null);} catch { /* Download on cache miss. */ }
    if (!bytes || typeof bytes === "string" || (expectedHash && hash(bytes) !== expectedHash)) {
      if (generation !== this.generation) throw Error("임베딩 중단됨");
      this.update({phase: "모델 다운로드", file: url.split("/").pop()});
      const response = await this.download(url, generation);
      if (response.status >= 400 || response.ok === false) throw Error(`모델 다운로드 실패 (${response.status}): ${url.split("/").pop()}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (expectedHash && hash(bytes) !== expectedHash) throw Error("임베딩 런타임 무결성 확인 실패");
      if (generation !== this.generation) throw Error("임베딩 중단됨");
      await fs.writeFile(file + ".tmp-" + generation, bytes);
      await fs.rename(file + ".tmp-" + generation, file);
    }
    return new Uint8Array(bytes).buffer;
  },
  call(action, args = {}) {
    const worker = this.worker;
    if (!worker) return Promise.reject(Error("임베딩 모델이 준비되지 않았습니다."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, {resolve, reject});
      try {
        const transfer = [args.bytes, args.wasm].filter(value => value instanceof ArrayBuffer);
        worker.postMessage({id, action, ...args}, transfer);
      } catch (error) {this.pending.delete(id); reject(error);}
    });
  },
  stop() {
    clearTimeout(this.startTimer); this.startTimer = null; this.starting = false;
    this.generation++; this.searchSequence++;
    for (const controller of this.downloads) controller.abort();
    this.downloads.clear();
    this.vectors = {};
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
    clearTimeout(this.startTimer);
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
        const saved = JSON.parse(await this.files().readFile(require("path").join(this.directory(), "vectors-v1.json"), "utf8"));
        if (generation !== this.generation) return;
        this.vectors = readEmbeddingVectors(saved);
      } catch { /* First index or interrupted write: rebuild missing entries. */ }
      const runtime = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";
      const library = await this.asset("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js", generation,
        "8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743");
      const factory = await this.asset(runtime + "ort-wasm-simd-threaded.asyncify.mjs", generation,
        "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611");
      const wasm = await this.asset(runtime + "ort-wasm-simd-threaded.asyncify.wasm", generation,
        "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082");
      if (generation !== this.generation) return;
      const blob = code => {const url = URL.createObjectURL(new Blob([code], {type: "text/javascript"})); this.urls.push(url); return url;};
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
          } catch (error) {if (generation === this.generation) worker.postMessage({download: data.download, error: String(error.message)});}
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
    } catch (error) {
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
    const active = new Set(items.map(con => this.key(con)));
    for (const key of Object.keys(this.vectors)) if (!active.has(key)) {delete this.vectors[key]; this.dirtyVectors++;}
    this.update({phase: "이미지 색인", total: items.length, completed: 0, errors: 0, error: "", file: ""});
    const checkpoint = async () => {
      if (!this.dirtyVectors || generation !== this.generation) return;
      const file = require("path").join(this.directory(), "vectors-v1.json"), fs = this.files();
      await fs.writeFile(file + ".tmp-" + generation, JSON.stringify({spec: EMBEDDING_SPEC, vectors: this.vectors}));
      if (generation !== this.generation) return;
      await fs.rename(file + ".tmp-" + generation, file);
      if (generation === this.generation) this.dirtyVectors = 0;
    };
    try {
      for (const [i, con] of items.entries()) {
        if (generation !== this.generation) return;
        try {
          const key = this.key(con);
          if (!this.vectors[key]) {
            const file = await getDCConImage(con);
            if (generation !== this.generation) return;
            const bytes = await file.arrayBuffer();
            if (generation !== this.generation) return;
            const vector = await this.call("image", {bytes, type: file.type});
            if (generation !== this.generation) return;
            this.vectors[key] = vector; this.dirtyVectors++;
          }
        } catch (error) {
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
    } catch (error) {
      if (generation === this.generation) {
        try {await checkpoint();} catch (saveError) {BdApi.Logger.error("discord-dccon", "Embedding checkpoint failed", saveError);}
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
    const vector = await request;
    if (sequence !== this.searchSequence || generation !== this.generation) throw Error("검색이 취소되었습니다.");
    const results = pickerPacks().flatMap(pack => pack.detail.map(con => ({...con, packageIdx: pack.info.package_idx})))
      .filter(con => this.vectors[this.key(con)])
      .map(con => ({con, score: this.vectors[this.key(con)].reduce((sum, value, i) => sum + value * vector[i], 0)}));
    const unique = new Map();
    for (const item of results.sort((a, b) => b.score - a.score)) if (!unique.has(this.key(item.con))) unique.set(this.key(item.con), item);
    return [...unique.values()];
  },
};

class EmbeddingEnvironmentPanel extends BdApi.React.Component {
  constructor(props) { super(props); this.state = {}; this.refresh = () => this.setState({revision: (this.state.revision || 0) + 1}); }
  componentDidMount() { PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
  componentWillUnmount() { PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
  render() {
    const h = BdApi.React.createElement;
    return h("section", {className: "dccon-embedding-environment"},
      h("h3", null, "디시콘 임베딩"),
      h("label", null, h("input", {type: "checkbox", checked: Embedding.enabled(), onChange: e => Embedding.toggle(e.target.checked)}), " 의미 기반 검색 활성화"),
      h("p", null, "활성화하면 EmbeddingGemma 2 모델(약 550 MB)을 다운로드하고 WebGPU로 이미지를 임베딩 합니다."),
      Embedding.enabled() && h("div", {className: "dccon-embedding-progress"},
        h("p", {role: "status"}, `${Embedding.status.phase} ${Embedding.status.file || ""} · ${Embedding.status.completed}/${Embedding.status.total} · 실패 ${Embedding.status.errors}`),
        h("progress", {"aria-label": "디시콘 색인 진행률", max: Math.max(1, Embedding.status.total), value: ["이미지 색인", "준비 완료", "완료 · 일부 실패", "오류", "꺼짐"].includes(Embedding.status.phase) ? Embedding.status.completed : undefined}),
        Embedding.status.error && h("p", {role: "alert"}, Embedding.status.error),
        ["오류", "꺼짐", "완료 · 일부 실패"].includes(Embedding.status.phase) && h(Button, {text: "다시 시도", onClick: () => Embedding.start()})),
      h("p", null, "모델과 벡터는 discord-dccon-cache/embedding-gemma2에 보관됩니다. 비활성화 하면 작업 중단합니다."));
  }
}

// 설정 패널 컴포넌트
class DCConSettingsPanel extends BdApi.React.Component {
  constructor(props) {
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
    } catch (err) {
      BdApi.Logger.error("discord-dccon", "디시콘 검색 실패:", err);
      BdApi.UI.showToast("디시콘 검색에 실패했습니다.", { type: "error" });
    }

    this.setState({ isSearching: false });
  }

  handleTabChange(tab) {
    this.setState({ activeTab: tab });
  }

  renderSearch() {
    const strings = getLocaleStrings();

    return BdApi.React.createElement(
      "div",
      { className: "dccon-search-container" },
      BdApi.React.createElement(
        "div",
        { className: "dccon-search-bar" },
        BdApi.React.createElement("input", {
          type: "text",
          placeholder: strings.settings.searchDccon,
          value: this.state.searchQuery,
          onChange: (e) => this.setState({ searchQuery: e.target.value }),
          onKeyDown: (e) => {
            if (e.key === "Enter") this.handleSearch();
          },
        }),
        BdApi.React.createElement(Button, {
          text: this.state.isSearching ? "검색 중…" : "검색",
          disabled:
            this.state.isSearching || this.state.searchQuery.trim() === "",
          onClick: this.handleSearch,
          style: { marginLeft: "8px" },
        })
      ),
      BdApi.React.createElement(
        "div",
        { className: "dccon-search-results" },
        this.state.searchResults.length > 0
          ? this.state.searchResults.map((result) =>
              BdApi.React.createElement(DCConCard, {
                key: result.idx,
                item: result,
                savedDccons: this.state.savedDccons,
                onAdd: () => {
                  this.setState({ savedDccons: loadPacks() });
                },
              })
            )
          : this.state.searchQuery !== "" && !this.state.isSearching
          ? BdApi.React.createElement(
              "div",
              { className: "dccon-empty-state" },
              strings.settings.noResults
            )
          : null
      )
    );
  }

  renderDiagnostics() {
    const h = BdApi.React.createElement;
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
        this.setState({ diagnosticReport: JSON.stringify({ pluginVersion: "3.5.1", generatedAt: new Date().toISOString(), ...report }, null, 2),
          copyStatus: "" });
      } }),
      this.state.diagnosticReport && h("div", null,
        h("textarea", { className: "dccon-diagnostic-report", "aria-label": "진단 결과", readOnly: true,
          value: this.state.diagnosticReport, ref: element => { this.reportInput = element; }, onFocus: event => event.target.select(),
        }),
        h(Button, { text: "제보용 정보 복사", onClick: async () => {
          this.reportInput?.focus();
          this.reportInput?.select();
          try {
            await navigator.clipboard.writeText(this.state.diagnosticReport);
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

    return BdApi.React.createElement(
      "div",
      { className: "dccon-saved-container" },
      this.state.savedDccons.length > 0
        ? this.state.savedDccons.map((dccon, index) =>
            BdApi.React.createElement(SavedDCConCard, {
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
        : BdApi.React.createElement(
            "div",
            { className: "dccon-empty-state" },
            "추가된 디시콘이 없습니다. '디시콘샵' 탭에서 디시콘을 추가해보세요."
          )
    );
  }

  render() {
    const h = BdApi.React.createElement;
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
module.exports = class DCCon {
  constructor(meta) {
    this.meta = meta;
    this.strings = getLocaleStrings();
  }

  getSettingsPanel() {
    return BdApi.React.createElement(DCConSettingsPanel, {section: "settings"});
  }

  start() {


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


    BdApi.DOM.addStyle(this.meta.name, this.css);

    // 언어 변경 리스너 추가
    this.localeListener = () => {this.strings = getLocaleStrings();};
    LocaleStore.addChangeListener(this.localeListener);
  }

  stop() {
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
    BdApi.DOM.removeStyle(this.meta.name);
  }

  get css() {
    return `
.dccon-popover, .dccon-settings-panel {
  --dc-text: var(--text-default, var(--text-normal, #dbdee1));
  --dc-muted: var(--text-muted, #949ba4);
  --dc-bg: var(--background-base-low, var(--background-secondary, #2b2d31));
  --dc-inset: var(--background-base-lowest, var(--background-tertiary, #1e1f22));
  --dc-hover: var(--background-modifier-hover, #ffffff12);
  --dc-selected: var(--background-modifier-selected, #ffffff20);
  --dc-accent: var(--blurple-50, #5865f2);
  font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
  font-size: 14px; line-height: 1.4; color: var(--dc-text); background: var(--dc-bg);
}
.theme-light .dccon-popover, .theme-light .dccon-settings-panel { --dc-text: var(--text-default, var(--text-normal, #313338)); --dc-muted: var(--text-muted, #5c5e66); --dc-bg: var(--background-base-low, var(--background-secondary, #f2f3f5)); --dc-inset: var(--background-base-lowest, var(--background-tertiary, #e3e5e8)); --dc-hover: var(--background-modifier-hover, #0000000a); --dc-selected: var(--background-modifier-selected, #00000014); }
.dccon-popover *, .dccon-settings-panel * { box-sizing: border-box; }
.dccon-popover button, .dccon-settings-panel button, .dccon-popover input, .dccon-settings-panel input { font: inherit; color: var(--dc-text); }
.dccon-popover button, .dccon-settings-panel button { border: 0; cursor: pointer; }
.dccon-popover button:disabled, .dccon-settings-panel button:disabled { opacity: .5; cursor: default; }
.dccon-popover button:focus-visible, .dccon-settings-panel button:focus-visible { outline: 2px solid var(--dc-accent); outline-offset: -2px; }
.dccon-trigger { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 8px; border: 0; border-radius: 12px; background: transparent; cursor: pointer; color: var(--interactive-normal, #b5bac1); }
.dccon-trigger:hover, .dccon-trigger:focus-visible, .dccon-trigger[aria-expanded="true"] { color: var(--interactive-active, #fff); background: var(--background-modifier-hover, #ffffff12); }
.dccon-buttonContainer { margin-left: 8px; }
.dccon-overlay { position: fixed; inset: 0; z-index: 10000; }
.dccon-popover { position: fixed; width: min(520px, calc(100vw - 16px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border-subtle, #80808033); border-radius: 8px; box-shadow: 0 8px 32px #0006; }
.dccon-popover-expanded { display: grid; grid-template-columns: minmax(0, calc((100% + 2px) / 3)) minmax(0, 1fr); }
.dccon-popover-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
.dccon-popover-expanded > .dccon-buffer { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-top: 0; border-right: 1px solid #80808033; padding: 12px; }
.dccon-popover-expanded .dccon-buffer-heading { flex-wrap: wrap; gap: 8px; }
.dccon-popover-expanded .dccon-buffer-preview { flex: 1; min-height: 0; max-height: none; display: flex; align-items: center; }
.dccon-popover-toolbar { display: flex; gap: 8px; padding: 12px 12px 4px; }
.dccon-popover-toolbar button { padding: 7px 12px; background: transparent; border-radius: 6px; font-weight: 600; color: var(--dc-muted); }
.dccon-popover-toolbar button:hover { background: var(--dc-hover); color: var(--dc-text); }
.dccon-popover-toolbar button[aria-pressed="true"] { background: var(--dc-selected); color: var(--dc-text); }
.dccon-popover-toolbar button:last-child { margin-left: auto; font-size: 20px; padding: 2px 10px; }
.dccon-popover-body { flex: 1; min-height: 0; overflow: auto; }
.dccon-pickerContainer { height: 100%; display: flex; flex-direction: column; }
.dccon-header { padding: 12px; }
.dccon-search-field { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--dc-inset); border-radius: 6px; border: 2px solid transparent; }
.dccon-search-field:focus-within { border-color: var(--dc-accent); }
.dccon-search-input { min-width: 0; flex: 1; width: 100%; border: 0; outline: 0; background: transparent; }
.dccon-search-input::placeholder, .dccon-search-bar input::placeholder { color: var(--dc-muted); opacity: 1; }
.dccon-search-field button { background: transparent; font-size: 20px; }
.dccon-browser { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--border-subtle, #80808033); }
.dccon-rail { flex: 0 0 auto; width: max-content; min-width: 60px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 6px; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; background: var(--dc-inset); }
.dccon-rail-button { position: relative; width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 10px; background: transparent; font-size: 26px !important; }
.dccon-rail-button img { width: 32px; height: 32px; border-radius: 6px; object-fit: contain; }
.dccon-rail-button:hover { background: var(--dc-hover); }
.dccon-rail-button[aria-pressed="true"] { background: var(--dc-selected); }
.dccon-rail-button[aria-pressed="true"]::before { content: ""; position: absolute; left: -6px; width: 3px; height: 26px; border-radius: 0 3px 3px 0; background: var(--dc-text); }
.dccon-rail-divider { width: 28px; min-height: 1px; background: #80808033; margin: 3px 0; }
.dccon-browser-content { flex: 1; min-width: 0; overflow-y: auto; padding: 8px; }
.dccon-browser-content, .dccon-rail, .dccon-popover-body { scrollbar-width: thin; scrollbar-color: var(--dc-muted) transparent; }
.dccon-category { margin-bottom: 12px; }
.dccon-category-header, .dccon-section-title { display: flex; align-items: center; width: 100%; padding: 6px 4px; background: transparent; color: var(--dc-text); font-size: 14px; font-weight: 600; text-align: left; cursor: pointer; }
.dccon-category-header:hover { background: var(--dc-hover); border-radius: 4px; }
.dccon-category-icon { width: 20px; height: 20px; border-radius: 4px; margin-right: 8px; }
.dccon-category-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dccon-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 6px; padding: 6px 0; }
.dccon-tile { position: relative; min-width: 0; }
.dccon-popover .dccon-favorite { position: absolute; top: 3px; right: 3px; width: 26px; height: 26px; padding: 0; border-radius: 5px; background: var(--dc-inset); color: var(--dc-text); opacity: 0; }
.dccon-tile:hover .dccon-favorite, .dccon-tile:focus-within .dccon-favorite, .dccon-favorite[aria-pressed="true"] { opacity: 1; }
.dccon-popover .dccon-favorite[aria-pressed="true"] { color: var(--text-warning, #f0b232); }
.dccon-loading { position: absolute; bottom: 4px; left: 4px; right: 4px; padding: 3px; border-radius: 4px; background: var(--dc-inset); font-size: 11px; }
.dccon-item { display: flex; align-items: center; justify-content: center; padding: 4px; width: 100%; aspect-ratio: 1; min-width: 0; overflow: hidden; border-radius: 8px; background: transparent; }
.dccon-item:hover { background: var(--dc-hover); }
.dccon-item img { max-width: 100%; max-height: 100%; object-fit: contain; }
.dccon-item-error { color: var(--text-danger, #f47b82); font-size: 12px; }
.dccon-buffer { flex-shrink: 0; padding: 8px 12px; border-top: 1px solid #80808033; color: var(--dc-text); }
.dccon-buffer-heading { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.dccon-buffer button { color: inherit; background: transparent; border: 0; cursor: pointer; }
.dccon-buffer button:disabled { opacity: .5; cursor: wait; }
.dccon-buffer-actions { display: flex; align-items: center; gap: 8px; }
.dccon-buffer .dccon-buffer-split { flex-shrink: 0; margin-top: 8px; padding: 8px; border: 1px solid #80808066; border-radius: 5px; }
.dccon-buffer .dccon-buffer-split:disabled { cursor: default; }
.dccon-buffer .dccon-buffer-send { padding: 5px 12px; border-radius: 5px; background: var(--dc-accent, #5865f2); color: white; }
.dccon-buffer-preview { max-height: 190px; overflow-y: auto; margin-top: 6px; }
.dccon-buffer-items { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 3px; width: min(100%, 210px); margin: auto; }
.dccon-buffer-items button { position: relative; grid-column: span 2; aspect-ratio: 1; min-width: 0; min-height: 0; padding: 0; overflow: hidden; border-radius: 4px; background: #80808022; }
/* Square-con layouts observed in Discord. Six tracks allow either two or three tiles per row.
   Ratios describe the visible crop, not the inner image's aspect ratio. */
/* 1: single square. */
.dccon-buffer-items[data-count="1"] { width: min(100%, 100px); }
.dccon-buffer-items[data-count="1"] button { grid-column: span 6; }
/* 2: two squares side by side. */
.dccon-buffer-items[data-count="2"] button { grid-column: span 3; }
/* 3: large left tile, two stacked right tiles. */
.dccon-buffer-items[data-count="3"] { grid-template-columns: 2fr 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); aspect-ratio: 11 / 7; }
.dccon-buffer-items[data-count="3"] button { grid-column: auto; aspect-ratio: auto; }
.dccon-buffer-items[data-count="3"] button:first-child { grid-row: span 2; }
/* 4: two rows of two wide crops. */
.dccon-buffer-items[data-count="4"] button { grid-column: span 3; aspect-ratio: 273 / 173; }
/* 5: two squares above three squares. */
.dccon-buffer-items[data-count="5"] button:nth-child(-n+2) { grid-column: span 3; }
/* 6: two rows of three squares (the default tracks and tile span). */
/* 7: wide top crop above two rows of three squares. */
.dccon-buffer-items[data-count="7"] { width: min(100%, 156px); }
.dccon-buffer-items[data-count="7"] button:first-child { grid-column: span 6; aspect-ratio: 55 / 28; }
/* 8: two squares above two rows of three squares. */
.dccon-buffer-items[data-count="8"] { width: min(100%, 156px); }
.dccon-buffer-items[data-count="8"] button:nth-child(-n+2) { grid-column: span 3; }
/* 9: three rows of three squares. */
.dccon-buffer-items[data-count="9"] { width: min(100%, 180px); }
.dccon-buffer-media { position: absolute; inset: 0; overflow: hidden; }
/* Discord centers the cover crop in the 3-item layout and the wide 7-item tile. */
.dccon-buffer-media img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center; }
/* The 4-item grid instead clips a width-sized image from the bottom (273 x 173 at 550px). */
.dccon-buffer-items[data-count="4"] .dccon-buffer-media img { height: auto; min-height: 100%; object-position: top; }
.dccon-buffer-items span { position: absolute; top: 2px; padding: 1px 4px; border-radius: 3px; background: #000a; color: white; font-size: 11px; line-height: 16px; }
.dccon-buffer-order { left: 2px; }
.dccon-buffer-remove { right: 2px; }
.dccon-buffer-items button:focus-visible { outline: 2px solid var(--dc-accent, #5865f2); outline-offset: -2px; }
.dccon-buffer-hint { margin: 5px 0 0; color: var(--dc-muted); font-size: 11px; line-height: 1.4; }
.dccon-footer { padding: 8px 12px; color: var(--dc-muted); font-size: 11px; border-top: 1px solid #80808033; }
.dccon-empty-state { padding: 32px 16px; text-align: center; color: var(--dc-muted); grid-column: 1 / -1; }
.dccon-empty-state button { display: block; margin: 16px auto 0; border-radius: 4px; padding: 8px 12px; background: var(--dc-accent); color: #fff; }
.dccon-settings-panel { padding: 12px; }
.dccon-personal-form { display: grid; gap: 10px; margin-top: 12px; }
.dccon-personal-form label { display: grid; gap: 6px; }
.dccon-personal-form input { width: 100%; min-width: 0; padding: 8px; border: 1px solid #80808033; border-radius: 4px; background: var(--dc-inset); }
.dccon-personal-actions { display: flex; gap: 8px; }
.dccon-personal p { margin: 12px 0; color: var(--dc-muted); }
.dccon-personal .dccon-card { align-items: center; margin-top: 8px; }
.dccon-personal-preview { width: 72px; height: 72px; flex-shrink: 0; }
.dccon-personal-preview img { width: 100%; height: 100%; object-fit: contain; }
.dccon-user-settings { overflow-y: auto; }
.dccon-user-settings h3 { margin: 0 0 12px; font-size: 16px; color: var(--dc-text); }
.dccon-user-settings .dccon-diagnostics { border-top: 1px solid #80808033; margin-top: 20px; padding-top: 20px; }
.dccon-embedding-environment { border-top: 1px solid #80808033; margin-top: 20px; padding-top: 20px; }
.dccon-embedding-environment p { color: var(--dc-muted); font-size: 13px; line-height: 1.5; }
.dccon-embedding-environment label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dccon-embedding-environment input { width: 18px; height: 18px; accent-color: var(--dc-accent); }
.dccon-embedding-progress progress { width: 100%; height: 10px; accent-color: var(--dc-accent); }
.dccon-report-steps { padding-left: 20px; color: var(--dc-muted); line-height: 1.7; margin: 0 0 12px; }
.dccon-diagnostics p { color: var(--dc-muted); margin: 0 0 12px; }
.dccon-diagnostic-report { display: block; width: 100%; min-height: 240px; box-sizing: border-box; resize: vertical; margin: 12px 0; padding: 10px; background: var(--dc-inset); color: var(--dc-text); border: 1px solid #80808033; border-radius: 4px; font: 12px/1.5 monospace; user-select: text; }
.dccon-tab-menu { display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid #80808033; margin-bottom: 16px; }
.dccon-tab-item { padding: 8px 12px; cursor: pointer; color: var(--dc-muted); background: transparent; }
.dccon-tab-item.active { color: var(--dc-text); border-bottom: 2px solid var(--dc-accent); font-weight: 600; }
.dccon-search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.dccon-search-bar input { flex: 1; min-width: 0; padding: 8px 10px; background: var(--dc-inset); border: 1px solid #80808033; border-radius: 4px; }
.dccon-search-bar input:focus { outline: 2px solid var(--dc-accent); }
.dccon-settings-panel .dccon-button { padding: 7px 12px; background: var(--dc-accent); color: #fff; border-radius: 4px; }
.dccon-search-results, .dccon-saved-container { display: grid; gap: 8px; }
.dccon-card { display: flex; gap: 12px; padding: 12px; border-radius: 8px; background: var(--dc-inset); }
.dccon-card > img { width: 72px; height: 72px; object-fit: contain; }
.dccon-card-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dccon-card-content h3 { color: var(--dc-text); font-size: 14px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.dccon-card-content span { color: var(--dc-muted); font-size: 12px; }
.dccon-pack-actions { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 4px; }
.dccon-pack-order { display: flex; gap: 6px; }
.dccon-pack-order button { font: inherit; color: var(--dc-text); background: var(--dc-hover); border: 0; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
.dccon-pack-order button:hover:not(:disabled) { background: var(--dc-selected); }
.dccon-pack-order button:disabled { opacity: .35; cursor: default; }
`;
  }
};
