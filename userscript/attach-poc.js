const React = require('react');
const ReactDOM = require('react-dom');
const ReactDOMClient = require('react-dom/client');
const {version} = require('../package.json');
const {createAdapter} = require('../shelter/adapter');
const {createUserscriptNative} = require('./native');
const {createComposerBridge} = require('./composer');
const {createConfig} = require('./config');
const sharedStorage = require('../scripts/shared-storage.cjs'); // Bundled as text; only its pure merge policy is used.
const source = require('../discord-dccon.plugin.js'); // Bundled as text, shared with BD/shelter.

async function start({page, request, load}) {
  if (document.documentElement.dataset.dcconAttachPoc) return;
  document.documentElement.dataset.dcconAttachPoc = 'starting';
  const native = createUserscriptNative(request);
  const store = {dcconImported: true, dcconData: load('data', {dccons: load('packs', [])})};
  const channelId = () => location.pathname.match(/^\/channels\/[^/]+\/(\d+)$/)?.[1];
  const toasts = new Map();
  // Host services for the shared adapter. No shelter engine or Discord module lookup.
  const host = {
    React, ReactDOM, ReactDOMClient,
    util: {getFiber: () => null},
    flux: {storesFlat: {SelectedChannelStore: {
      getChannelId: channelId,
      addChangeListener: listener => window.addEventListener('popstate', listener),
      removeChangeListener: listener => window.removeEventListener('popstate', listener),
    }}},
    plugin: {store},
    ui: {
      ToastColors: {},
      injectCss(css) {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        return () => style.remove();
      },
      showToast({content, duration}) {
        const toast = document.createElement('div'); toast.textContent = content; toast.setAttribute('role', 'status');
        toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:10001;padding:12px;background:#222;color:#fff;border-radius:8px;max-width:80vw';
        document.body.append(toast);
        toasts.set(toast, setTimeout(() => {toast.remove(); toasts.delete(toast);}, duration || 4000));
      },
    },
  };
  const unavailable = () => undefined;
  const adapter = createAdapter(host, native, {getByKeys: unavailable, getModule: unavailable, getModuleBySource: unavailable});
  adapter.BdApi.Net.resolveImage = native.resolveImage;
  adapter.BdApi.Plugins.cacheFolder = '/dccon/cache';
  const shared = {exports:{}};
  new Function('require','module',sharedStorage)(adapter.requireNative,shared);
  const settings = createConfig(page.indexedDB,shared.exports.mergeSetting);
  // GM data is a one-time import. All later writes use atomic, per-setting merges.
  adapter.BdApi.Config = {open:()=>settings.config('open',[store.dcconData]),save:(...args)=>settings.config('save',args)};
  const composer = createComposerBridge(page,document);
  adapter.BdApi.Composer = composer;
  const exported = {exports: {}};
  new Function('BdApi', 'require', 'module', source)(adapter.BdApi, adapter.requireNative, exported);
  const plugin = new exported.exports({name: 'discord-dccon', version});
  await plugin.start();
  document.documentElement.dataset.dcconAttachPoc = 'started';
  window.addEventListener('pagehide', () => {
    plugin.stop(); adapter.dispose(); native.dispose(); settings.dispose(); composer.dispose();
    for (const [toast, timer] of toasts) {clearTimeout(timer); toast.remove();}
    toasts.clear(); delete document.documentElement.dataset.dcconAttachPoc;
  }, {once: true});
}
module.exports = {start};
