const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('playwright');
const executablePath = [process.env.WEBP_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));

function codecContext(extra = {}) {
  const context = {module: {exports: {}}, require, URL, Blob, TextEncoder, TextDecoder, AbortController,
    BdApi: {React: {Component: class {}}, Webpack: {
      getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}, ...extra};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../discord-dccon.plugin.js'), 'utf8') +
    '\nmodule.exports=WebPCache;', context);
  return context;
}

test('split worker is reused, requests serialize, and stopping cancels active and queued work', async () => {
  const workers = [];
  class Worker {
    constructor() {this.messages = []; workers.push(this);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated = true;}
  }
  const codec = codecContext({Worker}).module.exports;
  codec.runtime = async () => ({source: '', wasm: new Uint8Array([1])});
  const first = codec.split(new Uint8Array([1])), second = codec.split(new Uint8Array([2]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  workers[0].onmessage({data: {tiles: ['first']}});
  assert.deepEqual(await first, ['first']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[1].wasm, undefined);
  const third = codec.split(new Uint8Array([3]));
  const rejects = [assert.rejects(second, /중단/), assert.rejects(third, /중단/)];
  codec.stop();
  await Promise.all(rejects);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 2);
});

test('split WASM is verified, cached offline, and rejects a corrupt replacement', async t => {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-split-test-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const context = codecContext(), codec = context.module.exports;
  context.BdApi.Plugins = {folder, cacheFolder: path.join(folder, "cache")};
  let fetches = 0, corrupt = false;
  context.BdApi.Net = {fetch: async () => {
    fetches++;
    return {arrayBuffer: async () => corrupt ? Buffer.from('bad') :
      fs.readFileSync(path.join(__dirname, '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm'))};
  }};
  const runtime = await codec.runtime('split', 0);
  assert.equal(runtime.source, codec.specs.split.source);
  codec.stop();
  await codec.runtime('split', codec.generation);
  assert.equal(fetches, 1);
  codec.stop(); corrupt = true;
  fs.writeFileSync(path.join(folder, 'cache/webp-codecs', codec.specs.split.hashes[1]), 'bad');
  await assert.rejects(codec.runtime('split', codec.generation), /무결성/);
});

test('real nine-way split preserves tile pixels, padding, animation timing and finite loops', {skip: !executablePath}, async t => {
  const context = {module: {exports: {}}, BdApi: {React: {Component: class {}}, Webpack: {
    getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../discord-dccon.plugin.js'), 'utf8') +
    '\nmodule.exports={WebPCache, splitImageIntoNine, isWebP, webpFile};', context);
  const api = context.module.exports, assets = {};
  for (const [kind, {name}] of Object.entries(api.WebPCache.specs).filter(([, spec]) => spec.name)) {
    const dir = path.join(__dirname, '../node_modules/@libwebp-wasm', name, 'es');
    assets[kind] = {source: fs.readFileSync(path.join(dir, name + '.js'), 'utf8'),
      wasm: [...fs.readFileSync(path.join(dir, name + '.wasm'))]};
  }
  const browser = await chromium.launch({executablePath, headless: true});
  t.after(() => browser.close());
  const server = require('node:http').createServer((_, response) => { response.setHeader('Content-Security-Policy', "connect-src 'none'; worker-src blob:"); response.end('<!doctype html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({workerSource, helpers, assets, splitSource, splitWasm}) => {
    const workerURL = URL.createObjectURL(new Blob([`(${workerSource})()`], {type: 'text/javascript'}));
    const worker = new Worker(workerURL, {type: 'module'});
    const convert = (bytes, frames, loopCount = 0) => new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(Error(data.error)) : resolve(new Uint8Array(data.bytes));
      worker.onerror = e => reject(Error(e.message));
      worker.postMessage({bytes, frames, loopCount, kind: 'img',
        runtime: {...assets.img, wasm: new Uint8Array(assets.img.wasm)}});
    });
    const splitURL = URL.createObjectURL(new Blob([splitSource], {type: 'text/javascript'}));
    const splitWorker = new Worker(splitURL, {type: 'module'});
    let initialized = false;
    const WebPCache = {convert, split: bytes => new Promise((resolve, reject) => {
      splitWorker.onmessage = ({data}) => data.error ? reject(Error(data.error)) : resolve(data.tiles);
      splitWorker.onerror = e => reject(Error(e.message));
      splitWorker.postMessage({bytes, wasm: initialized ? undefined : new Uint8Array(splitWasm)});
      initialized = true;
    })};
    const isWebP = eval('(' + helpers.isWebP + ')');
    const webpFile = eval('(' + helpers.webpFile + ')');
    const split = eval('(' + helpers.splitImageIntoNine + ')');
    const decode = async file => {
      const decoder = new ImageDecoder({data: new Uint8Array(await file.arrayBuffer()), type: file.type});
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack, frames = [];
        for (let i = 0; i < track.frameCount; i++) {
          const {image} = await decoder.decode({frameIndex: i});
          const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight), ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          frames.push({width: canvas.width, height: canvas.height,
            duration: image.duration,
            pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data]});
          image.close();
        }
        return {frames, repetitionCount: track.repetitionCount};
      } finally {decoder.close();}
    };
    try {
      const canvas = new OffscreenCanvas(6, 6), ctx = canvas.getContext('2d');
      const frames = [];
      for (let frame = 0; frame < 2; frame++) {
        for (let tile = 0; tile < 9; tile++) {
          ctx.fillStyle = `rgb(${20 * tile}, ${frame * 200}, 100)`;
          ctx.fillRect((tile % 3) * 2, Math.floor(tile / 3) * 2, 2, 2);
        }
        frames.push({bytes: new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer()),
          duration: [80, 140][frame]});
      }
      const still = await split(new File([frames[0].bytes], 'still.png', {type: 'image/png'}), () => {});
      const animatedFile = webpFile(await convert(new Uint8Array(), frames, 3));
      const before = await decode(animatedFile);
      const animated = await split(animatedFile, () => {});
      const wide = new OffscreenCanvas(6, 2), wideCtx = wide.getContext('2d');
      wideCtx.fillStyle = 'red'; wideCtx.fillRect(0, 0, 6, 2);
      const padded = await split(await wide.convertToBlob({type: 'image/png'}), () => {});
      let cancelled = false;
      try {await split(animatedFile, () => {throw Error('cancelled');});}
      catch (error) {cancelled = error.message === 'cancelled';}
      return {still: await Promise.all(still.map(decode)), before,
        animated: await Promise.all(animated.map(decode)), names: animated.map(file => file.name),
        padded: await Promise.all(padded.map(decode)), cancelled};
    } finally {worker.terminate(); splitWorker.terminate(); URL.revokeObjectURL(workerURL); URL.revokeObjectURL(splitURL);}
  }, {workerSource: api.WebPCache.workerMain.toString().replace(/^workerMain\(\)/, 'function()'),
    splitSource: api.WebPCache.specs.split.source,
    splitWasm: [...fs.readFileSync(path.join(__dirname, '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm'))],
    helpers: Object.fromEntries(['splitImageIntoNine', 'isWebP', 'webpFile'].map(key => [key, api[key].toString()])), assets});
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.names, Array.from({length: 9}, (_, i) => `dccon-${i + 1}.webp`));
  for (let i = 0; i < 9; i++) {
    const still = result.still[i].frames[0];
    assert.equal(still.width, 2); assert.equal(still.height, 2);
    assert.deepEqual(still.pixels, Array(4).fill([20 * i, 0, 100, 255]).flat());
    const animated = result.animated[i];
    assert.equal(animated.repetitionCount, result.before.repetitionCount);
    assert.equal(animated.frames.length, 2);
    for (let f = 0; f < 2; f++) {
      assert.equal(animated.frames[f].duration, result.before.frames[f].duration);
      assert.deepEqual(animated.frames[f].pixels, Array(4).fill([20 * i, f * 200, 100, 255]).flat());
    }
    const pixel = i >= 3 && i < 6 ? [255, 0, 0, 255] : [0, 0, 0, 0];
    assert.deepEqual(result.padded[i].frames[0].pixels, Array(4).fill(pixel).flat());
  }
});
