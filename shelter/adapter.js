function createAdapter(shelter, native, webpack) {
  const styles = new Map();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const store = shelter.plugin.store;
  const localeListeners = new Set();
  let localeObserver;
  const localeStore = {
    get locale() {return document.documentElement.lang || navigator.language || 'en';},
    initialize() {},
    addChangeListener(listener) {
      localeListeners.add(listener);
      if (!localeObserver) {
        localeObserver = new MutationObserver(() => {for (const notify of localeListeners) notify();});
        localeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
      }
    },
    removeChangeListener(listener) {
      localeListeners.delete(listener);
      if (!localeListeners.size) {localeObserver?.disconnect(); localeObserver = null;}
    },
  };
  const fs = Object.fromEntries(['readFile', 'writeFile', 'mkdir', 'rename', 'unlink'].map(method => [method, (...args) => {
    const callback = args.pop();
    native.file(method, args).then(value => callback(null, value), error => callback(error));
  }]));
  const requireNative = name => {
    if (name === 'electron') return {clipboard: {readText: () => native.readClipboardText()}};
    if (name === 'fs') return fs;
    if (name === 'path') return {join: (...parts) => parts.join('/'), dirname: value => value.slice(0, value.lastIndexOf('/'))};
    if (name === 'crypto') return {createHash: algorithm => {
      if (algorithm !== 'sha256') throw Error('Only SHA-256 is supported');
      const chunks = [];
      const hash = {update(value) {chunks.push(value); return hash;}, digest: encoding => native.hash(chunks, encoding)};
      return hash;
    }};
    throw Error(`Unsupported native module: ${name}`);
  };
  const requestScope = globalThis.crypto.randomUUID(), activeRequests = new Set();
  let requestId = 0, disposed = false;
  async function fetchNative(url, options = {}) {
    const id = `${requestScope}:${++requestId}`, {signal, ...rest} = options;
    if (disposed || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    activeRequests.add(id);
    const pending = native.fetch(id, url, rest);
    const abort = () => native.abort(id);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await pending;
      const bytes = new Uint8Array(response.bytes);
      return {status: response.status, ok: response.status >= 200 && response.status < 300,
        headers: new Headers(response.headers), arrayBuffer: async () => bytes.buffer,
        text: async () => new TextDecoder().decode(bytes)};
    } finally {activeRequests.delete(id); signal?.removeEventListener('abort', abort);}
  }
  const BdApi = {
    React: shelter.React,
    ReactDOM: {...shelter.ReactDOM, createRoot: (...args) => shelter.ReactDOMClient.createRoot(...args)},
    ReactUtils: {getInternalInstance: element => shelter.util.getFiber(element)},
    Webpack: {...webpack,
      getModule(filter, options) {
        // Generic get/post/put/del exports also match low-level HTTP clients.
        // shelter captures Discord's API-aware client during initialization.
        const rest = shelter.http?._raw;
        if (rest && filter(rest)) return rest;
        if (filter.toString().includes('trackUploadFinished')) {
          return webpack.getModuleBySource(filter, 'trackUploadFinished');
        }
        return webpack.getModule(filter, options);
      },
      getByKeys: (...keys) => {
        const signature = keys.join(',');
        if (signature === 'locale,initialize') return localeStore;
        // These generic CSS export names are ambiguous outside BdApi's finder.
        // The shared picker already provides complete fallback button styling.
        if (signature === 'icon,active,buttonWrapper' || signature === 'channelTextArea,buttonContainer,button') return {};
        return webpack.getByKeys(...keys);
      },
      getStore: name => shelter.flux.storesFlat[name]},
    Plugins: {folder: '/dccon', dataFolder: '/dccon', cacheFolder: '/cache'},
    Config: {
      open: () => native.config('open', [clone(store.dcconData || {})]),
      save: (key, value, before) => native.config('save', [key, value, before]),
    },
    Data: {
      load: (_, key) => clone(store.dcconData?.[key]),
    },
    Net: {fetch: fetchNative, ...(native.hostMod === 'vencord' ? {
      async resolveImage(source, signal) {
        const url = new URL(source);
        const direct = url.origin === 'https://dccon-proxy.minibox.workers.dev'
          ? 'https://dcimg5.dcinside.com/dccon.php?no=' + encodeURIComponent(url.searchParams.get('no') || '') : source;
        const response = await fetchNative(direct, {signal, headers: {Referer: 'https://dcimg5.dcinside.com'}});
        if (!response.ok) throw Error('디시콘 미리보기를 다운로드하지 못했습니다.');
        return new Blob([await response.arrayBuffer()], {type: response.headers.get('content-type') || 'image/gif'});
      },
    } : {})}, Logger: {error: (...args) => console.error('[discord-dccon shelter]', ...args)},
    UI: {showToast: (content, options = {}) => shelter.ui.showToast({title: 'discord-dccon', content,
      duration: options.timeout || 4000,
      color: shelter.ui.ToastColors[options.type === 'error' ? 'CRITICAL' : options.type === 'success' ? 'SUCCESS' : 'INFO']})},
    DOM: {
      addStyle(id, css) {BdApi.DOM.removeStyle(id); styles.set(id, shelter.ui.injectCss(css));},
      removeStyle(id) {styles.get(id)?.(); styles.delete(id);},
    },
  };
  return {BdApi, requireNative, dispose() {
    disposed = true;
    for (const id of activeRequests) native.abort(id);
    activeRequests.clear();
    localeObserver?.disconnect(); localeListeners.clear();
    for (const id of styles.keys()) BdApi.DOM.removeStyle(id);
  }};
}
if (typeof module !== 'undefined') module.exports = {createAdapter};
