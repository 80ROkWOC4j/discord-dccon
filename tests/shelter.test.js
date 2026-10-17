const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {captureWebpack, findWebpackRequire} = require('../shelter/webpack');
const {createShelterPlatform} = require('../src/platform/shelter.ts');
const {createFiles, resolveFile, allowedDownload, hash, prepareDataRoot, channelOptions} = require('../shelter/native');

test('shelter module capture survives webpack push replacement and observes reassigned exports', () => {
  const target = {}, api = captureWebpack(target);
  const chunks = target.webpackChunkdiscord_app;
  chunks.push = chunk => {
    for (const factory of Object.values(chunk[1])) factory({exports: {}});
  };
  const object = {sendMessage() {}};
  chunks.push([[1], {1: module => {module.exports = {abc: object};}}]);
  assert.equal(api.getByKeys('sendMessage'), object);
  assert.equal(api.count(), 1);
});

test('webpack runtime can bind the previous push without recursive calls', () => {
  const target = {}, api = captureWebpack(target), chunks = target.webpackChunkdiscord_app;
  const previousPush = chunks.push.bind(chunks);
  chunks.push = chunk => {
    for (const factory of Object.values(chunk[1])) factory({exports: {}});
    return previousPush(chunk);
  };
  assert.doesNotThrow(() => chunks.push([[1], {1: module => {module.exports = {ready: true};}}]));
  assert.equal(api.getByKeys('ready').ready, true);
  assert.equal(chunks.length, 1);
});

test('Vencord lookup waits for its require and preserves factories and chunk push', () => {
  const chunks = [], originalPush = chunks.push;
  const target = {webpackChunkdiscord_app: chunks};
  let external;
  const webpack = captureWebpack(target, () => external);
  assert.equal(webpack.isReady(), false);
  assert.equal(webpack.getByKeys('ready'), undefined);
  const factories = {
    1: module => {module.exports = {ready: true};},
    2: module => {module.exports = {minified: class {trackUploadFinished() {} upload() {}}};},
    3: () => {throw Error('Unrelated factory must not execute');},
  };
  const uploadFactory = factories[2];
  external = id => {
    if (!external.c[id]) {
      const module = external.c[id] = {exports: {}};
      external.m[id](module, module.exports, external);
    }
    return external.c[id].exports;
  };
  external.m = factories; external.c = {};
  chunks.push([[1], factories]);
  assert.equal(webpack.isReady(), true);
  assert.equal(chunks.push, originalPush);
  assert.equal(factories[2], uploadFactory);
  assert.match(String(factories[2]), /trackUploadFinished/);
  external(1);
  assert.equal(webpack.getByKeys('ready').ready, true);
  assert.equal(typeof webpack.getModuleBySource(value => typeof value?.prototype?.trackUploadFinished === 'function', 'trackUploadFinished'), 'function');
  assert.equal(external.c[3], undefined);
});

test('upload lookup skips CSS and initializes only matching lazy factories', () => {
  const target = {}, webpack = captureWebpack(target), factories = {}, cache = {};
  target.webpackChunkdiscord_app.push = chunk => Object.assign(factories, chunk[1]);
  function load(id) {
    if (!cache[id]) {cache[id] = {exports: {}}; factories[id](cache[id], cache[id].exports, load);}
    return cache[id].exports;
  }
  target.webpackChunkdiscord_app.push([[1], {
    1: module => {module.exports = {addFiles: 'addFiles_css'};},
    2: module => {module.exports = {addFiles: (...args) => {const type = 'UPLOAD_ATTACHMENT_ADD_FILES'; return args;}};},
    3: module => {module.exports = {minified: class {trackUploadFinished() {} upload() {}}};},
    4: () => {throw Error('Unrelated module must not execute');},
  }]);
  load(1);
  const shelter = {plugin: {store: {}, flushStore() {}}, flux: {storesFlat: {}}};
  const {platform} = createShelterPlatform(shelter, {initialData: {}}, webpack);
  const upload = platform.discord.uploadModule();
  assert.equal(typeof upload, 'function');
  assert.equal(cache[4], undefined);
});

test('upload lookup includes initial runtime factories outside chunk push', () => {
  const target = {}, webpack = captureWebpack(target), cache = {};
  function load(id) {
    if (!cache[id]) {cache[id] = {exports: {}}; load.m[id](cache[id], cache[id].exports, load);}
    return cache[id].exports;
  }
  load.m = {
    10: module => {module.exports = {z: class {trackUploadFinished() {} upload() {}}};},
    11: () => {throw Error('Unrelated initial factory must not execute');},
  };
  target.webpackChunkdiscord_app.push = chunk => Object.assign(load.m, chunk[1]);
  target.webpackChunkdiscord_app.push([[1], {1: module => {module.exports = {};}}]);
  load(1);
  const upload = webpack.getModuleBySource(value => typeof value?.prototype?.trackUploadFinished === 'function', 'trackUploadFinished');
  assert.equal(upload, load(10).z);
  assert.equal(cache[11], undefined);
});

test('shelter imports its legacy snapshot through common JSON and never updates IndexedDB settings', async () => {
  const store = {dcconData: {dccons: [{info: {title: 'original'}}]}};
  const shelter = {plugin: {store, flushStore() {}}, flux: {storesFlat: {}}};
  const calls = [];
  const native = {config: async (method, args) => {calls.push({method,args}); return {version:2,settings:args[0]};}};
  const {platform} = createShelterPlatform(shelter, native, {});
  const imported = await platform.config.open(), packs = imported.settings.dccons;
  packs[0].info.title = 'changed';
  assert.equal(platform.data.load('dccons')[0].info.title, 'original');
  await platform.config.save('dccons', packs, []);
  assert.equal(calls[1].method, 'save');
  assert.equal(store.dcconData.dccons[0].info.title, 'original');
});

test('image sends use shelter Discord REST, never an ambiguous HTTP export', async () => {
  const calls = [];
  const rest = {get() {}, put() {}, del() {}, async post(request) {
    assert.equal(this, rest);
    calls.push(request);
    return {ok: true, status: 200, body: {id: 'message-id'}};
  }};
  const wrong = {get() {}, put() {}, del() {}, post() {throw Error('Wrong HTTP client selected');}};
  class CloudUpload {
    constructor({file}) {this.filename = file.name; this.uploadedFilename = 'uploaded-file'; this.handlers = {};}
    trackUploadFinished() {}
    on(name, callback) {this.handlers[name] = callback;}
    off(name) {delete this.handlers[name];}
    upload() {this.handlers.complete();}
  }
  const webpack = {getByKeys: () => ({}), Filters: {byKeys: (...keys) => value => keys.every(key => value?.[key] !== undefined)},
    getModule: filter => [wrong, CloudUpload].find(value => filter(value)),
    getModuleBySource: filter => [wrong, CloudUpload].find(value => filter(value))};
  const shelter = {http: {_raw: rest}, React: {Component: class {}}, plugin: {store: {}, flushStore() {}}, flux: {storesFlat: {}}};
  const adapter = createShelterPlatform(shelter, {initialData: {}}, webpack);
  const api = require('./helpers/core.cjs').loadCore({ DCConPlatform: adapter.platform, structuredClone, setTimeout, clearTimeout,
  });
  const imageAttempt = {};
  await api.sendImagesDirectly([{name: 'dccon.png', size: 3}], 'channel-test', imageAttempt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/channels/channel-test/messages');
  assert.equal(calls[0].body.content, '');
  assert.equal(calls[0].body.attachments[0].uploaded_filename, 'uploaded-file');
  assert.equal(imageAttempt.hasMessageId, true);
});

test('adapter disposal aborts old downloads without reusing IDs after restart', async () => {
  const requests = [], aborted = [];
  const shelter = {plugin: {store: {}, flushStore() {}}, flux: {storesFlat: {}}};
  const native = {initialData: {}, abort: id => aborted.push(id), fetch: id => new Promise(resolve => requests.push({id, resolve}))};
  const first = createShelterPlatform(shelter, native, {});
  const oldRequest = first.platform.net.fetch('https://dcinside.com/old');
  first.dispose();
  const second = createShelterPlatform(shelter, native, {});
  const newRequest = second.platform.net.fetch('https://dcinside.com/new');
  assert.notEqual(requests[0].id, requests[1].id);
  assert.deepEqual(aborted, [requests[0].id]);
  await assert.rejects(first.platform.net.fetch('https://dcinside.com/stopped'), {name: 'AbortError'});
  for (const request of requests) request.resolve({status: 200, headers: [], bytes: []});
  await Promise.all([oldRequest, newRequest]);
  second.dispose();
  assert.equal(aborted.length, 1);
});

test('Stable and Canary share the same data directory and preserve existing files', async t => {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-dccon-path-test-'));
  t.after(() => fs.rm(appData, {recursive: true, force: true}));
  const current = prepareDataRoot(appData), canary = prepareDataRoot(appData, 'Canary');
  assert.equal(current, path.join(appData, 'discord-dccon'));
  assert.equal(canary, current);
  await fs.writeFile(path.join(current, 'saved'), 'data');
  assert.equal(prepareDataRoot(appData), current);
  assert.equal(await fs.readFile(path.join(current, 'saved'), 'utf8'), 'data');
  assert.equal(await fs.readFile(path.join(canary, 'saved'), 'utf8'), 'data');
});

test('native bridge confines writes and reuses legacy binary cache read-only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dccon-shelter-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const current = path.join(root, 'current'), legacy = path.join(root, 'legacy');
  await fs.mkdir(path.join(legacy, 'discord-dccon-cache'), {recursive: true});
  const bytes = Buffer.from([0, 255, 137, 80]);
  await fs.writeFile(path.join(legacy, 'discord-dccon-cache', 'image'), bytes);
  const file = createFiles(current, legacy);
  assert.deepEqual(await file('readFile', ['/dccon/discord-dccon-cache/image', null]), bytes);
  await file('mkdir', ['/dccon/discord-dccon-cache', {recursive: true}]);
  await file('writeFile', ['/dccon/discord-dccon-cache/image', Buffer.from([1])]);
  assert.deepEqual(await fs.readFile(path.join(legacy, 'discord-dccon-cache', 'image')), bytes);
  assert.throws(() => resolveFile(current, '/dccon/../../escape'));
  assert.throws(() => resolveFile(current, 'C:/escape'));
  assert.throws(() => allowedDownload('https://discord.com/api/v9/users/@me'));
  assert.throws(() => allowedDownload('https://dcinside.com.evil.test/'));
  assert.equal(allowedDownload('https://dcimg5.dcinside.com/image'), 'https://dcimg5.dcinside.com/image');
  assert.equal(allowedDownload('https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases'), 'https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases');
  assert.throws(() => allowedDownload('https://api.github.com.evil.test/'));
  assert.equal(hash(['abc'], 'hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('generated shelter and BetterDiscord entries parse', () => {
  const {buildBetterDiscord, buildShelterPlugin} = require('../scripts/build.cjs');
  assert.doesNotThrow(() => new vm.Script(buildBetterDiscord()));
  assert.doesNotThrow(() => new vm.Script(buildShelterPlugin('test')));
});

for (const legacyOrder of ['absent', 'before', 'after', 'disabled']) test(`plugin removes legacy registration and starts after first-store retry (legacy: ${legacyOrder})`, async () => {
  const {JSDOM} = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const timers = [], events = [];
  const installed = {'discord-dccon': {}, unrelated: {on: true}};
  const legacySettings = {dccons: [{info: {title: 'saved pack'}}]};
  const savedSettings = {'dccon-poc': legacySettings};
  const removed = [];
  let legacyRunning = false;
  if (legacyOrder !== 'absent') installed['dccon-poc'] = {on: legacyOrder !== 'disabled'};
  const startLegacy = () => {assert.ok(installed['dccon-poc']); legacyRunning = true;};
  let firstStore = true, lifecycle, started;
  const host = {React: {Component: class {}, createElement() {}}, ReactDOM: {createPortal() {}}, ReactDOMClient: {createRoot() {}},
    util: {getFiber() {}}, flux: {storesFlat: {}}, http: {_raw: {get() {}, post() {}, put() {}, del() {}}},
    plugin: {id: 'discord-dccon', store: {}, flushStore() {
      if (firstStore) {firstStore = false; throw Error('not a shelter storage proxy');}
    }},
    plugins: {installedPlugins: () => installed,
      removePlugin(id) {assert.equal(id, 'dccon-poc'); assert.equal(legacyRunning, legacyOrder !== 'disabled'); legacyRunning = false; removed.push(id); delete installed[id];},
      stopPlugin: () => lifecycle.onUnload(), startPlugin() {lifecycle = create(); started = lifecycle.onLoad();}},
    ui: {injectCss() {events.push('mount'); return () => events.push('unmount');}, showToast: message => assert.fail(message.content)}};
  const native = {config: async () => ({version: 2, settings: {dccons: [], recent: [], embeddingEnabled: false}})};
  const webpack = {getByKeys: () => ({}), isReady: () => true};
  const context = {module: {exports: {}}, document: dom.window.document, window: dom.window, navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver, crypto: globalThis.crypto, structuredClone, queueMicrotask, console,
    setTimeout: callback => {timers.push(callback); return timers.length;}, clearTimeout() {}};
  vm.runInNewContext(require('../scripts/build.cjs').buildEntry('shelter', {format: 'cjs'}), context);
  const create = () => context.module.exports.createShelterPlugin(host, native, webpack, 'test');
  try {
    if (legacyOrder === 'before') startLegacy();
    lifecycle = create(); const loading = lifecycle.onLoad();
    if (legacyOrder === 'after') startLegacy();
    await loading;
    assert.equal(timers.length, 1); timers.shift()(); await started;
    assert.deepEqual(events, ['mount']);
    assert.deepEqual(removed, legacyOrder === 'absent' ? [] : ['dccon-poc']);
    assert.equal(legacyRunning, false);
    assert.deepEqual(Object.keys(installed).sort(), ['discord-dccon', 'unrelated']);
    assert.equal(savedSettings['dccon-poc'], legacySettings);
    lifecycle.onUnload(); assert.deepEqual(events, ['mount', 'unmount']);
  } finally {dom.window.close();}
});

for (const platform of ['darwin', 'win32', 'linux']) for (const channel of ['Stable', 'Canary']) for (const alreadyReady of [false, true]) for (const hostMod of [undefined, 'vencord', 'shelter']) test(`injector connects ${channel} on ${platform} and restricts IPC and CSP (already ready: ${alreadyReady}, host: ${hostMod})`, async () => {
  const events = new Map(), handlers = new Map();
  const existingHeaders = () => {};
  let ready, onHeaders = existingHeaders;
  const electron = {app: {isReady: () => alreadyReady, getPath: () => os.tmpdir(), on: (_, fn) => {ready = fn;}}, ipcMain: {on: (key, fn) => events.set(key, fn), handle(key, fn) {handlers.set(key, fn);}},
    session: {defaultSession: {webRequest: {onHeadersReceived: fn => {onHeaders = fn;}}}},
    BrowserWindow: class {constructor(options) {this.options = options; this.webContents = {id: 7, once() {}};}}, net: {}};
  const cachedModule = {};
  Object.defineProperty(cachedModule, 'exports', {configurable: true, get: () => electron});
  const fakeFs = {readFileSync: file => file.endsWith('channel.json') ? JSON.stringify({channel, hostMod}) : 'throw Error("addon failed")'};
  function load(name) {
    if (name === 'electron') return electron;
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:process') return {platform};
    if (name === './shared-storage.cjs') return require('../src/storage/node.ts');
    if (name === './native') return {allowedDownload, channelOptions, prepareDataRoot: (base, selected) => {
      assert.equal(selected, channel);
      assert.equal(base, platform === 'linux' ? path.join(os.tmpdir(), '.config') : os.tmpdir());
      return path.join(base, 'discord-dccon');
    }};
    return require(name);
  }
  load.resolve = () => 'electron'; load.cache = {electron: cachedModule};
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../shelter/main.cjs'), 'utf8'),
    {require: load, __dirname: '/test/runtime', console, URL, AbortController});
  assert.notEqual(cachedModule.exports.BrowserWindow, electron.BrowserWindow);
  const win = new cachedModule.exports.BrowserWindow({title: 'Discord', webPreferences: {preload: '/discord/preload.js'}});
  assert.match(win.options.webPreferences.preload, /preload\.cjs$/);
  const event = {sender: {id: 7}};
  events.get('dccon:init')(event);
  assert.equal(event.returnValue.originalPreload, '/discord/preload.js');
  assert.equal(event.returnValue.initialData, undefined);
  assert.equal(event.returnValue.cacheRoot, path.join(event.returnValue.dataRoot, 'cache'));
  assert.equal(event.returnValue.hostMod, hostMod);
  const origin = channelOptions(channel).origin;
  assert.equal(event.returnValue.origin, origin);
  const frame = {url: origin + '/channels/@me'};
  assert.doesNotThrow(() => events.get('dccon:abort')({senderFrame: frame, sender: {id: 7, mainFrame: frame}}, 1));
  for (const url of ['https://canary.discord.com.evil.test', 'http://canary.discord.com', channelOptions(channel === 'Stable' ? 'Canary' : 'Stable').origin]) {
    const otherFrame = {url};
    assert.throws(() => events.get('dccon:abort')({senderFrame: otherFrame, sender: {mainFrame: otherFrame}}, 1), /Untrusted/);
  }
  assert.equal(events.has('dccon:status'), false);
  if (hostMod === 'shelter') {
    const wrapper = electron.ipcMain.handle;
    electron.ipcMain.handle('SHELTER_BUNDLE_FETCH', async event => {assert.equal(event, 'event'); return 'globalThis.hostLoaded = true;';});
    assert.notEqual(electron.ipcMain.handle, wrapper);
    const errors = [], context = {console: {error: (...args) => errors.push(args)}};
    vm.runInNewContext(await handlers.get('SHELTER_BUNDLE_FETCH')('event'), context);
    assert.equal(context.hostLoaded, true, 'Addon bootstrap failures must not prevent Shelter from loading');
    assert.equal(errors.length, 1);
  }
  if (hostMod) {
    assert.equal(onHeaders, existingHeaders, 'Host mod must retain its CSP handler');
    assert.equal(ready, undefined);
    return;
  }
  if (alreadyReady) assert.equal(ready, undefined);
  else { assert.equal(onHeaders, existingHeaders); ready(); }
  const responseHeaders = {'Content-Security-Policy': ["default-src 'self'; img-src 'self' https://*.discordapp.net; script-src 'self'; worker-src 'self'"]};
  onHeaders({resourceType: 'mainFrame', url: origin + '/channels/@me', responseHeaders}, result => {
    const csp = result.responseHeaders['Content-Security-Policy'][0];
    assert.match(csp, /https:\/\/dccon-proxy\.minibox\.workers\.dev/);
    assert.match(csp, /https:\/\/\*\.discordapp\.net/);
    assert.match(csp, /default-src 'self'/);
  });
  const untouched = {'Content-Security-Policy': ["default-src 'self'"]};
  onHeaders({resourceType: 'mainFrame', url: 'https://example.com', responseHeaders: untouched}, result => {
    assert.equal(result.responseHeaders['Content-Security-Policy'][0], "default-src 'self'");
  });
});

test('preload injects only the configured channel main frame and always loads original preload', async () => {
  const source = await fs.readFile(path.join(__dirname, '../shelter/preload.cjs'), 'utf8');
  for (const channel of ['Stable', 'Canary']) for (const allowed of [true, false]) for (const hostMod of [undefined, 'shelter']) {
    const origin = channelOptions(channel).origin, calls = [];
    let bridge, reads = 0;
    const electron = {ipcRenderer: {sendSync: () => ({origin, originalPreload: 'original', bundle: 'bundle', hostMod})},
      clipboard: {readText: () => {reads++; return 'clipboard-url';}},
      contextBridge: {exposeInMainWorld: (_, value) => {bridge = value; calls.push('bridge');}},
      webFrame: {executeJavaScript: () => {calls.push('injected'); return Promise.resolve();}}};
    vm.runInNewContext(source, {process: {isMainFrame: true}, location: {origin: allowed ? origin : 'https://example.com'},
      require(name) {
        if (name === 'electron') return electron;
        if (name === './native') return {createFiles() {}, hash() {}};
        assert.equal(name, 'original'); calls.push('original');
      }});
    assert.deepEqual(calls, allowed ? (hostMod === 'shelter' ? ['bridge', 'original'] : ['bridge', 'injected', 'original']) : ['original']);
    assert.equal(reads, 0);
    if (allowed) {
      const {platform} = createShelterPlatform({plugin: {store: {}, flushStore() {}}, flux: {storesFlat: {}}}, {...bridge, initialData: {}}, {});
      assert.equal(platform.readClipboardText(), 'clipboard-url');
      assert.equal(reads, 1);
    } else assert.equal(bridge, undefined);
  }
});

test('late shelter plugin obtains existing webpack without wrapping its factories', () => {
  const channelStore = {getChannelId() {}};
  const factories = {42: module => {module.exports = {minified: class {trackUploadFinished() {} upload() {}}};}};
  const originalFactory = factories[42];
  const requireModule = id => {
    if (!requireModule.c[id]) {
      const module = requireModule.c[id] = {exports: {}};
      factories[id](module, module.exports, requireModule);
    }
    return requireModule.c[id].exports;
  };
  requireModule.m = factories; requireModule.c = {1: {exports: {minified: channelStore}}};
  const chunks = [];
  const library = Object.assign(() => {}, {m: {}, c: {2: {exports: {unrelated: true}}}});
  chunks.push = chunk => {chunk[2](requireModule); chunk[2](library);};
  const push = chunks.push;
  const target = {webpackChunkdiscord_app: chunks, crypto: {randomUUID: () => 'test'}};
  assert.equal(findWebpackRequire(target, channelStore), requireModule);
  assert.equal(findWebpackRequire(target, {}), undefined);
  const webpack = captureWebpack(target, () => requireModule);
  const upload = webpack.getModuleBySource(value => typeof value?.prototype?.upload === 'function', 'trackUploadFinished');
  assert.equal(typeof upload, 'function');
  assert.equal(factories[42], originalFactory);
  assert.equal(chunks.push, push);
});

for (const hostMod of ['vencord', 'shelter']) test(`${hostMod} thumbnails use direct bytes and Blob URLs without CSP settings changes`, async () => {
  const calls = [];
  const native = {hostMod, fetch: async (id, url, options) => {
    calls.push({url,options});return {status:200,headers:[['content-type','image/gif']],bytes:new Uint8Array([71,73,70])};
  }};
  const adapter = createShelterPlatform({plugin:{store:{}},ReactDOM:{}},native,{});
  const blob = await adapter.platform.net.resolveImage('https://dccon-proxy.minibox.workers.dev/?no=abc123');
  assert.equal(calls[0].url,'https://dcimg5.dcinside.com/dccon.php?no=abc123');
  assert.equal(blob.type,'image/gif');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[71,73,70]);
  const controller=new AbortController();controller.abort();
  await assert.rejects(adapter.platform.net.resolveImage('https://dccon-proxy.minibox.workers.dev/?no=abc123',controller.signal),{name:'AbortError'});
  assert.equal(calls.length,1);
  adapter.dispose();
});

test('Blob thumbnails revoke old URLs, cancel stale downloads and retain native rendering on other hosts', async () => {
  const pending=[],revoked=[];
  const context={module:{exports:{}},AbortController,URL:{createObjectURL:value=>'blob:'+value,revokeObjectURL:value=>revoked.push(value)},
    platform:{react:{Component:class{constructor(props){this.props=props;}setState(value){Object.assign(this.state,value);}},createElement:(type,props)=>({type,props})},
      net:{resolveImage:(src,signal)=>new Promise(resolve=>pending.push({signal,resolve}))}}};
  context.platform.discord = {classes: {}};
  context.module.exports = require('./helpers/core.cjs').importCore(context).createMediaUI(context.platform, {}).DCConImage;
  const Image=context.module.exports,image=new Image({src:'first',loading:'lazy'});
  image.componentDidMount();pending[0].resolve('first');await Promise.resolve();
  assert.equal(image.render().props.src,'blob:first');assert.equal(image.render().props.loading,'eager');
  image.props={src:'second'};image.componentDidUpdate({src:'first'});
  assert.equal(pending[0].signal.aborted,true);assert.deepEqual(revoked,['blob:first']);
  image.componentWillUnmount();pending[1].resolve('second');await Promise.resolve();
  assert.equal(image.state.source,undefined);assert.equal(pending[1].signal.aborted,true);
  delete context.platform.net.resolveImage;
  const direct=new Image({src:'original',loading:'lazy'});direct.componentDidMount();
  assert.equal(direct.render().props.src,'original');assert.equal(direct.render().props.loading,'lazy');
});

test('Blob thumbnails wait for intersection and ignore stale visibility callbacks', async () => {
  const downloads=[], observers=[], revoked=[];
  const context={module:{exports:{}},AbortController,
    IntersectionObserver:class {
      constructor(callback,options){this.callback=callback;this.options=options;observers.push(this);}
      observe(target){this.target=target;}
      disconnect(){this.disconnected=true;}
      notify(isIntersecting){this.callback([{target:this.target,isIntersecting}]);}
    },
    URL:{createObjectURL:value=>'blob:'+value,revokeObjectURL:value=>revoked.push(value)},
    platform:{react:{Component:class{constructor(props){this.props=props;}setState(value){Object.assign(this.state,value);}},createElement:(type,props)=>({type,props})},
      net:{resolveImage:(src,signal)=>new Promise(resolve=>downloads.push({src,signal,resolve}))}},
  };
  context.platform.discord = {classes: {}};
  context.module.exports = require('./helpers/core.cjs').importCore(context).createMediaUI(context.platform, {}).DCConImage;
  const Image=context.module.exports, scrollRoot={};
  const images=Array.from({length:200},(_,i)=>{
    const image=new Image({src:'image-'+i,loading:'lazy'});
    image.render().props.ref?.({closest:()=>scrollRoot});image.componentDidMount();return image;
  });
  assert.equal(downloads.length,0,'Mounting offscreen thumbnails must not download them');
  assert.equal(observers.length,200);
  assert.equal(observers[0].options.root,scrollRoot);
  observers[0].notify(false);assert.equal(downloads.length,0);
  for(let i=0;i<8;i++)observers[i].notify(true);
  assert.equal(downloads.length,8,'Only visible thumbnails should download');
  observers[0].notify(true);assert.equal(downloads.length,8,'Repeated queued callbacks cannot duplicate requests');
  downloads[0].resolve('first');await Promise.resolve();
  assert.equal(images[0].render().props.src,'blob:first');
  images[0].props={src:'replacement',loading:'lazy'};images[0].componentDidUpdate({src:'image-0'});
  assert.equal(downloads[0].signal.aborted,true);assert.deepEqual(revoked,['blob:first']);
  assert.equal(images[0].state.source,undefined);
  observers[0].notify(true);assert.equal(downloads.length,8);
  observers.at(-1).notify(true);assert.equal(downloads[8].src,'replacement');
  images[1].componentWillUnmount();downloads[1].resolve('stale');await Promise.resolve();
  assert.equal(images[1].state.source,undefined);
  images[199].componentWillUnmount();observers[199].notify(true);
  assert.equal(downloads.length,9,'Unmounted offscreen image must not download');
  for(const image of images)image.componentWillUnmount();
});

test('managed Shelter plugin removes its registration after native bridge removal, retaining host-owned data', async () => {
  const removed = [], pending = [], store = {dcconData: {favorites: ['keep']}};
  const shelter = {plugin: {id: 'discord-dccon', store}, plugins: {removePlugin: id => removed.push(id)}};
  const source = require('../scripts/build.cjs').buildShelterPlugin('test');
  const lifecycle = vm.runInNewContext(source, {shelter, queueMicrotask: fn => pending.push(fn)});
  await lifecycle.onLoad();
  assert.deepEqual(removed, []);
  pending.shift()();
  assert.deepEqual(removed, ['discord-dccon']);
  assert.deepEqual(store.dcconData.favorites, ['keep']);
});
