const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createFiles} = require('../shelter/native');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const url = 'https://dcimg5.dcinside.com/dccon.php?no=abcdef';

function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dccon-personal-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const data = {}, calls = [];
  const context = {module: {exports: {}}, require: name => name === 'electron' && options.nativeClipboard
    ? {clipboard: {readText: options.nativeClipboard}} : require(name), structuredClone, setTimeout, clearTimeout, File, Blob, URL, AbortController,
    convert: options.convert || (async bytes => bytes), document: options.document,
    navigator: {clipboard: {readText: options.clipboard || (async () => url)}},
    createImageBitmap: async () => ({close() {}}),
    BdApi: {
      Plugins: {folder: dir, cacheFolder: path.join(dir, "cache")},
      Data: {load: (_, key) => data[key], save: (_, key, value) => { data[key] = value; }},
      Net: {fetch: async (...args) => {calls.push(args); return options.fetch ? options.fetch(...args) : {status: 200, arrayBuffer: async () => png};}},
      Webpack: {getByKeys: () => ({}), getStore: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}},
      React: {Component: class {constructor(props) {this.props = props;} setState(next) {Object.assign(this.state, next);}}, createElement() {}},
    }};
  require('./helpers/core.cjs').loadCore(context);
  context.module.exports.WebPCache.convert = context.convert;
  return {...context.module.exports, data, calls, dir};
}

test('clipboard import previews before saving, persists bytes offline, rejects duplicates and removes references', async t => {
  const h = harness(t), manager = new h.PersonalConManager({});
  manager.componentDidMount();
  t.after(() => manager.componentWillUnmount());
  await manager.open();
  assert.ok(manager.state.prepared);
  assert.equal(h.data.personalCons, undefined);
  manager.state.title = '내 콘';
  await manager.add();
  const con = h.data.personalCons[0];
  assert.equal(con.title, '내 콘');
  assert.equal(h.pickerPacks()[0].detail.length, 1);
  assert.deepEqual(Buffer.from(await (await h.getDCConImage(con)).arrayBuffer()), png);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.storePersonalCon(await h.preparePersonalCon(url), ''), /이미 등록/);
  h.data.favorites = [con]; h.data.recent = [con];
  h.updateQueue('channel', [{con, file: await h.getDCConImage(con)}]);
  await h.removePersonalCon(con);
  assert.equal(h.data.personalCons.length, 0);
  assert.equal(h.data.favorites.length, 0);
  assert.equal(h.data.recent.length, 0);
  assert.equal(h.activeQueue('channel').length, 0);
  assert.equal(manager.state.items.length, 0);
  await assert.rejects(h.getDCConImage(con), {code: 'ENOENT'});
});

test('personal order persists, refreshes the picker and leaves references unchanged', async t => {
  const h = harness(t);
  const items = ['첫째', '둘째', '셋째'].map((title, index) => ({idx: String(index), path: 'personal:' + index, title, packageIdx: 'personal-cons'}));
  h.data.personalCons = items;
  h.data.favorites = [items[0]];
  h.data.recent = [items[1]];
  const manager = new h.PersonalConManager({});
  manager.componentDidMount();
  t.after(() => manager.componentWillUnmount());
  await h.movePersonalCon(items[2], -1);
  await h.movePersonalCon(items[0], 1);
  const titles = list => Array.from(list, con => con.title);
  assert.deepEqual(titles(h.personalCons()), ['셋째', '첫째', '둘째']);
  assert.deepEqual(titles(manager.state.items), ['셋째', '첫째', '둘째']);
  assert.deepEqual(titles(h.pickerPacks()[0].detail), ['셋째', '첫째', '둘째']);
  const saved = h.data.personalCons;
  await h.movePersonalCon(items[2], -1);
  await h.movePersonalCon(items[1], 1);
  await h.movePersonalCon({path: 'missing'}, 1);
  assert.equal(h.data.personalCons, saved);
  assert.deepEqual(h.data.favorites, [items[0]]);
  assert.deepEqual(h.data.recent, [items[1]]);
  assert.equal(h.calls.length, 0);
});

test('clipboard denial falls back to input; manual submission saves directly and repeated clicks coalesce', async t => {
  const h = harness(t, {clipboard: async () => {throw Error('denied');}});
  const manager = new h.PersonalConManager({});
  await manager.open();
  assert.equal(manager.state.open, true);
  assert.equal(manager.state.prepared, null);
  assert.equal(h.calls.length, 0);
  manager.state.input = 'https://ac.arca.live/test.jpg?expires=123&key=abc';
  await Promise.all([manager.add(), manager.add()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.data.personalCons.length, 1);
  assert.equal(manager.state.open, false);
});

test('native clipboard previews only after clicking add and needs confirmation before saving', async t => {
  let reads = 0, browserReads = 0;
  const h = harness(t, {nativeClipboard: () => {reads++; return url;},
    clipboard: async () => {browserReads++; throw Error('Browser clipboard denied');}});
  const manager = new h.PersonalConManager({});
  assert.equal(reads, 0);
  await manager.open();
  assert.equal(reads, 1);
  assert.equal(browserReads, 0);
  assert.ok(manager.state.prepared);
  assert.equal(h.data.personalCons, undefined);
  await manager.add();
  assert.equal(h.data.personalCons.length, 1);
});

test('invalid URLs, non-images, oversize images and unsafe redirects cannot be registered', async t => {
  const h = harness(t);
  for (const bad of ['file:///test', 'https://example.com/a.png', 'https://ac.arca.live.evil.test/a.png', 'http://ac.arca.live/a.png'])
    assert.throws(() => h.personalURL(bad));
  for (const response of [
    {status: 403},
    {status: 200, arrayBuffer: async () => Buffer.from('<html>expired</html>')},
    {status: 200, headers: {get: () => 11 * 1024 * 1024}},
    {status: 302, headers: {get: () => 'https://example.com/a.png'}},
  ]) {
    const broken = harness(t, {fetch: async () => response});
    await assert.rejects(broken.preparePersonalCon(url));
    assert.equal(broken.data.personalCons, undefined);
  }
});

test('closing import while downloading prevents saving', async t => {
  let finish;
  const h = harness(t, {fetch: () => new Promise(resolve => {finish = resolve;})});
  const manager = new h.PersonalConManager({});
  manager.state.input = url;
  const pending = manager.add();
  manager.componentWillUnmount();
  finish({status: 200, arrayBuffer: async () => png});
  await pending;
  assert.equal(h.data.personalCons, undefined);
});

test('saved personal images use converted bytes offline and the GIF upload filename', async t => {
  const converted = Buffer.from('RIFF0000WEBPconverted');
  let conversions = 0;
  const h = harness(t, {convert: async bytes => {
    assert.deepEqual(Buffer.from(bytes), png);
    conversions++;
    return converted;
  }});
  await h.storePersonalCon(await h.preparePersonalCon(url), '보관한 콘');
  const con = h.data.personalCons[0];
  const file = await h.getDCConImage(con);
  assert.equal(file.name, 'dccon.gif');
  assert.equal(file.type, 'image/webp');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), converted);
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'discord-dccon-library', con.path.slice(9))), converted);
  assert.equal(conversions, 1);
  assert.equal(h.calls.length, 1);
});

test('closing import during conversion leaves no saved image or entry', async t => {
  let finish, started;
  const converting = new Promise(resolve => {started = resolve;});
  const h = harness(t, {convert: () => new Promise(resolve => {finish = resolve; started();})});
  const manager = new h.PersonalConManager({});
  manager.state.input = url;
  const pending = manager.add();
  await converting;
  manager.componentWillUnmount();
  finish(png);
  await pending;
  assert.equal(h.data.personalCons, undefined);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, 'discord-dccon-library')), []);
});

test('standalone filesystem permits removal only of hashed personal images', async t => {
  const h = harness(t), file = createFiles(h.dir);
  const name = '/dccon/discord-dccon-library/' + 'a'.repeat(64);
  await file('mkdir', ['/dccon/discord-dccon-library', {recursive: true}]);
  await file('writeFile', [name, png]);
  await file('unlink', [name]);
  await assert.rejects(file('unlink', ['/dccon/config.json']), /Invalid personal/);
  await assert.rejects(file('unlink', ['/dccon/../outside']), /escapes/);
});

test('video import waits for a presented frame after loadeddata before copying pixels', async t => {
  const events = new Map();
  let frameReady, draws = 0, converted = false;
  const video = {
    duration: 1 / 30, videoWidth: 1, videoHeight: 1,
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: name => events.delete(name),
    requestVideoFrameCallback: callback => {frameReady = callback; return 1;},
    cancelVideoFrameCallback() {}, removeAttribute() {}, load() {},
    set src(value) {queueMicrotask(() => events.get('loadeddata')());},
  };
  const canvas = {getContext: () => ({drawImage() {draws++;}}), toBlob: callback => callback(new Blob([png]))};
  const h = harness(t, {document: {createElement: name => name === 'video' ? video : canvas},
    convert: async (bytes, frames) => {converted = true; assert.equal(frames.length, 1); return png;}});
  const pending = h.personalVideo(new Uint8Array([1]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(draws, 0);
  assert.equal(converted, false);
  frameReady();
  await pending;
  assert.equal(draws, 1);
  assert.equal(converted, true);
});

test('standalone can read imported BetterDiscord images without deleting the originals', async t => {
  const h = harness(t), legacy = path.join(h.dir, 'legacy');
  const hash = 'b'.repeat(64), name = '/dccon/discord-dccon-library/' + hash;
  fs.mkdirSync(path.join(legacy, 'discord-dccon-library'), {recursive: true});
  const original = path.join(legacy, 'discord-dccon-library', hash);
  fs.writeFileSync(original, png);
  const file = createFiles(path.join(h.dir, 'current'), legacy);
  assert.deepEqual(await file('readFile', [name, null]), png);
  await file('unlink', [name]);
  assert.deepEqual(fs.readFileSync(original), png);
});
