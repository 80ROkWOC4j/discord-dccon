const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {captureWebpack} = require('../shelter/webpack');
const {createAdapter} = require('../shelter/adapter');
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
  const {BdApi} = createAdapter(shelter, {initialData: {}}, webpack);
  const upload = BdApi.Webpack.getModule(value => typeof value === 'function' &&
    typeof value.prototype?.trackUploadFinished === 'function' && typeof value.prototype?.upload === 'function');
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
  const {BdApi} = createAdapter(shelter, native, {});
  const imported = await BdApi.Config.open(), packs = imported.settings.dccons;
  packs[0].info.title = 'changed';
  assert.equal(BdApi.Data.load('discord-dccon', 'dccons')[0].info.title, 'original');
  await BdApi.Config.save('dccons', packs, []);
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
  const adapter = createAdapter(shelter, {initialData: {}}, webpack);
  const module = {exports: {}};
  const source = await fs.readFile(path.join(__dirname, '../discord-dccon.plugin.js'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports={sendImagesDirectly};', {
    module, BdApi: adapter.BdApi, structuredClone, setTimeout, clearTimeout,
  });
  const imageAttempt = {};
  await module.exports.sendImagesDirectly([{name: 'dccon.png', size: 3}], 'channel-test', imageAttempt);
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
  const first = createAdapter(shelter, native, {});
  const oldRequest = first.BdApi.Net.fetch('https://dcinside.com/old');
  first.dispose();
  const second = createAdapter(shelter, native, {});
  const newRequest = second.BdApi.Net.fetch('https://dcinside.com/new');
  assert.notEqual(requests[0].id, requests[1].id);
  assert.deepEqual(aborted, [requests[0].id]);
  await assert.rejects(first.BdApi.Net.fetch('https://dcinside.com/stopped'), {name: 'AbortError'});
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
  assert.equal(hash(['abc'], 'hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('generated shelter bootstrap and DCCon source parse', async () => {
  const source = await fs.readFile(path.join(__dirname, '../discord-dccon.plugin.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source));
  const plugin = await fs.readFile(path.join(__dirname, '../shelter/plugin.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(plugin));
});

test('plugin starts after first-store retry without PoC status APIs and cleans up', async () => {
  const source = await fs.readFile(path.join(__dirname, '../shelter/plugin.js'), 'utf8');
  const timers = [], events = [];
  let firstStore = true, lifecycle;
  const context = vm.createContext({
    console, dcconVersion: '3.0.0', DCConNative: {},
    dcconWebpack: {getByKeys: () => ({})},
    setTimeout: callback => {timers.push(callback); return timers.length;}, clearTimeout() {},
    createAdapter: () => ({BdApi: {mount: () => events.push('mount'), unmount: () => events.push('unmount')}, requireNative() {}, dispose: () => events.push('dispose')}),
    dcconSource: 'module.exports=class {start(){BdApi.mount();} stop(){BdApi.unmount();}};',
    shelter: {React: {createElement() {}}, ReactDOM: {createPortal() {}}, ReactDOMClient: {createRoot() {}},
      http: {_raw: {get() {}, post() {}, put() {}, del() {}}},
      plugin: {id: 'discord-dccon', flushStore() {
        if (firstStore) {firstStore = false; throw Error('not a shelter storage proxy');}
      }},
      plugins: {stopPlugin: () => lifecycle.onUnload(), startPlugin() {lifecycle = vm.runInContext(source, context); lifecycle.onLoad();}},
      ui: {showToast: message => assert.fail(JSON.stringify(message))}},
  });
  lifecycle = vm.runInContext(source, context);
  lifecycle.onLoad();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.deepEqual(events, ['mount']);
  lifecycle.onUnload();
  assert.deepEqual(events, ['mount', 'unmount', 'dispose']);
  assert.equal(context.DCConShelterStatus, undefined);
});

for (const platform of ['win32', 'linux']) for (const channel of ['Stable', 'Canary']) test(`injector connects ${channel} on ${platform} and restricts IPC and CSP to its origin`, async () => {
  const events = new Map();
  let ready, onHeaders;
  const electron = {app: {getPath: () => os.tmpdir(), on: (_, fn) => {ready = fn;}}, ipcMain: {on: (key, fn) => events.set(key, fn), handle() {}},
    session: {defaultSession: {webRequest: {onHeadersReceived: fn => {onHeaders = fn;}}}},
    BrowserWindow: class {constructor(options) {this.options = options; this.webContents = {id: 7, once() {}};}}, net: {}};
  const cachedModule = {};
  Object.defineProperty(cachedModule, 'exports', {configurable: true, get: () => electron});
  const fakeFs = {readFileSync: file => file.endsWith('channel.json') ? JSON.stringify({channel}) : '{}'};
  function load(name) {
    if (name === 'electron') return electron;
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:process') return {platform};
    if (name === './shared-storage.cjs') return require('../scripts/shared-storage.cjs');
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
  const origin = channelOptions(channel).origin;
  assert.equal(event.returnValue.origin, origin);
  const frame = {url: origin + '/channels/@me'};
  assert.doesNotThrow(() => events.get('dccon:abort')({senderFrame: frame, sender: {id: 7, mainFrame: frame}}, 1));
  for (const url of ['https://canary.discord.com.evil.test', 'http://canary.discord.com', channelOptions(channel === 'Stable' ? 'Canary' : 'Stable').origin]) {
    const otherFrame = {url};
    assert.throws(() => events.get('dccon:abort')({senderFrame: otherFrame, sender: {mainFrame: otherFrame}}, 1), /Untrusted/);
  }
  assert.equal(events.has('dccon:status'), false);
  ready();
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
  for (const channel of ['Stable', 'Canary']) for (const allowed of [true, false]) {
    const origin = channelOptions(channel).origin, calls = [];
    let bridge, reads = 0;
    const electron = {ipcRenderer: {sendSync: () => ({origin, originalPreload: 'original', bundle: 'bundle'})},
      clipboard: {readText: () => {reads++; return 'clipboard-url';}},
      contextBridge: {exposeInMainWorld: (_, value) => {bridge = value; calls.push('bridge');}},
      webFrame: {executeJavaScript: () => {calls.push('injected'); return Promise.resolve();}}};
    vm.runInNewContext(source, {process: {isMainFrame: true}, location: {origin: allowed ? origin : 'https://example.com'},
      require(name) {
        if (name === 'electron') return electron;
        if (name === './native') return {createFiles() {}, hash() {}};
        assert.equal(name, 'original'); calls.push('original');
      }});
    assert.deepEqual(calls, allowed ? ['bridge', 'injected', 'original'] : ['original']);
    assert.equal(reads, 0);
    if (allowed) {
      const {requireNative} = createAdapter({plugin: {store: {}, flushStore() {}}, flux: {storesFlat: {}}}, {...bridge, initialData: {}}, {});
      assert.equal(requireNative('electron').clipboard.readText(), 'clipboard-url');
      assert.equal(reads, 1);
    } else assert.equal(bridge, undefined);
  }
});
