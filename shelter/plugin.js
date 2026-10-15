// This expression is evaluated by shelter with its per-plugin API in scope.
(() => {
  let plugin, adapter, timer, disposed = false;
  function stop() {
    disposed = true;
    clearTimeout(timer);
    try {plugin?.stop();} finally {adapter?.dispose();}
  }
  async function start() {
    if (disposed) return;
    if (typeof globalThis.BdApi !== 'undefined') {
      console.error('[discord-dccon shelter] BetterDiscord 중복 실행 감지. 기존 로더를 확인하세요.');
      return;
    }
    const checks = {
      Webpack: dcconWebpack.isReady?.() !== false,
      React: !!shelter.React?.createElement,
      ReactDOM: !!shelter.ReactDOM?.createPortal,
      ReactDOMClient: !!shelter.ReactDOMClient?.createRoot,
      DiscordHTTP: !!shelter.http?._raw && ['get', 'post', 'put', 'del'].every(key => typeof shelter.http._raw[key] === 'function'),
    };
    if (Object.values(checks).some(value => !value)) {
      // Channel modules may load only after login / opening a conversation.
      timer = setTimeout(start, 1000);
      return;
    }
    try {
      // This pinned shelter build returns a plain object when a plugin store is
      // first created (??= returns its RHS). Restart once to obtain its proxy.
      try {shelter.plugin.flushStore();}
      catch (error) {
        if (dcconWebpack.storageRetried || !error.message.includes('not a shelter storage proxy')) throw error;
        dcconWebpack.storageRetried = true;
        timer = setTimeout(() => {
          shelter.plugins.stopPlugin(shelter.plugin.id);
          shelter.plugins.startPlugin(shelter.plugin.id);
        }, 0);
        return;
      }
      adapter = createAdapter(shelter, DCConNative, dcconWebpack);
      const exported = {exports: {}};
      new Function('BdApi', 'require', 'module', dcconSource)(
        adapter.BdApi, adapter.requireNative, exported);
      plugin = new exported.exports({name: 'discord-dccon', version: dcconVersion});
      await plugin.start();
    } catch (error) {
      try {plugin?.stop();} finally {adapter?.dispose();}
      console.error('[discord-dccon shelter]', error);
      shelter.ui.showToast({title: 'discord-dccon 오류', content: error.message, duration: 15000});
    }
  }
  return {onLoad: start, onUnload: stop};
})()
