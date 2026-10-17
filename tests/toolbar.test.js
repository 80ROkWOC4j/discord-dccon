const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const React = require('react');
const {createShelterPlatform} = require('../src/platform/shelter.ts');

for (const installation of ['BetterDiscord', 'shelter', 'BetterDiscord bundle', 'Shelter bundle']) test(`${installation}: shared toolbar follows composers and channels, opens picker, and cleans up on stop`, async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previous = {window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT, observer: global.MutationObserver};
  global.window = dom.window; global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver; global.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactDOM = require('react-dom');
  const {createRoot} = require('react-dom/client');
  const fibers = new WeakMap(), listeners = new Set();
  let channel = 'main';
  const store = {getChannelId: () => channel, addChangeListener: fn => listeners.add(fn), removeChangeListener: fn => listeners.delete(fn)};
  const locale = {locale: 'ko', initialize() {}, addChangeListener() {}, removeChangeListener() {}};
  const webpack = {getByKeys: (...keys) => keys[0] === 'locale' ? locale : {},
    getStore: name => name === 'SelectedChannelStore' ? store : undefined,
    getModule: () => {throw Error('Toolbar must not search for Discord components');}};
  const data = {dccons: [], recent: [], embeddingEnabled: false};
  const injectCss = css => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    return () => style.remove();
  };
  let removeCss;
  const nativeApi = {React, ReactDOM: {...ReactDOM, createRoot}, ReactUtils: {getInternalInstance: editor => fibers.get(editor)},
    Webpack: webpack, Plugins: {}, Data: {load: (_, key) => data[key], save: (_, key, value) => {data[key] = value;}},
    DOM: {addStyle: (_, css) => {removeCss = injectCss(css);}, removeStyle: () => removeCss?.()}};
  const shelter = {React, ReactDOM, ReactDOMClient: {createRoot}, util: {getFiber: editor => fibers.get(editor)},
    flux: {storesFlat: {SelectedChannelStore: store}}, http: {_raw: {get() {},post() {},put() {},del() {}}}, plugin: {store: {}, flushStore() {}},
    plugins: {installedPlugins: () => ({})}, ui: {injectCss, showToast: toast => assert.fail(toast.content)}};
  const native = {config: async (method, args) => {
    if (method === 'save') data[args[0]] = args[1];
    return {version: 2, settings: structuredClone(data)};
  }};
  const adapter = installation === 'shelter' ? createShelterPlatform(shelter, native, webpack) : null;
  const exported = {exports: {}};
  const context = {module: exported, require, BdApi: nativeApi, DCConPlatform: adapter?.platform, window, document, MutationObserver,
    structuredClone, queueMicrotask, setTimeout, clearTimeout, navigator: window.navigator, crypto: globalThis.crypto, console};
  let plugin;
  if (installation === 'BetterDiscord bundle') {
    vm.runInNewContext(require('../scripts/build.cjs').buildBetterDiscord(), context);
    plugin = new exported.exports({name: 'discord-dccon'});
  } else if (installation === 'Shelter bundle') {
    delete context.BdApi;
    Object.assign(context, {shelter, DCConNative: native, dcconWebpack: webpack});
    const source = require('../scripts/build.cjs').buildShelterPlugin('test');
    let lifecycle;
    plugin = {start() {lifecycle = vm.runInNewContext(source, context); return lifecycle.onLoad();}, stop() {lifecycle?.onUnload();}};
  } else {
    Object.assign(exported, {exports: require('./helpers/core.cjs').loadCore(context)});
    plugin = new exported.exports.Plugin({name: 'discord-dccon'});
  }
  const act = callback => React.act(async () => {callback(); await new Promise(resolve => setImmediate(resolve));});
  const addComposer = id => {
    const composer = document.createElement('div'); composer.className = 'channelTextArea_test';
    composer.innerHTML = '<div role="textbox" contenteditable="true"></div><div class="buttons_test"></div>';
    if (id) fibers.set(composer.firstChild, {return: {memoizedProps: {channel: {id}}}});
    document.body.append(composer); return composer;
  };
  let main, side;
  try {
    await act(() => plugin.start());
    assert.equal(document.querySelector('.dccon-trigger'), null);
    await act(() => {main = addComposer(); side = addComposer('sidebar');});
    assert.equal(document.querySelectorAll('.dccon-trigger').length, 2);
    await act(() => main.querySelector('.dccon-trigger').click());
    assert.ok(document.querySelector('.dccon-search-input'));
    if (exported.exports.getChannel) assert.equal(exported.exports.getChannel(), 'main');
    await act(() => {channel = 'next'; for (const listener of listeners) listener();});
    assert.equal(document.querySelector('.dccon-popover'), null);
    await act(() => main.querySelector('.dccon-trigger').click());
    if (exported.exports.getChannel) assert.equal(exported.exports.getChannel(), 'next');
    await act(() => side.querySelector('.dccon-trigger').click());
    if (exported.exports.getChannel) assert.equal(exported.exports.getChannel(), 'sidebar');
    assert.equal(document.querySelectorAll('.dccon-popover').length, 1);
    await act(() => side.querySelector('.dccon-toolbar-host').remove());
    assert.equal(side.querySelectorAll('.dccon-trigger').length, 1);
    assert.equal(document.querySelector('.dccon-popover'), null);
    await act(() => side.remove());
    assert.equal(document.querySelectorAll('.dccon-trigger').length, 1);
    await act(() => {main.append(document.createElement('span')); plugin.stop();});
    assert.equal(document.querySelector('.dccon-toolbar-host'), null);
    assert.equal(document.querySelector('.dccon-popover'), null);
    assert.equal(document.querySelector('style'), null);
    assert.equal(listeners.size, 0);
    await act(() => plugin.start());
    assert.equal(document.querySelectorAll('.dccon-trigger').length, 1);
  } finally {
    await act(() => plugin.stop()); adapter?.dispose(); dom.window.close();
    global.window = previous.window; global.document = previous.document;
    global.MutationObserver = previous.observer; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
