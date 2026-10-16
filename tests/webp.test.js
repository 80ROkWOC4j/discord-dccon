const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('playwright');
const executablePath = [process.env.WEBP_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));

test('animated WebP keeps its extension while still WebP uses the GIF filename without changing bytes', async () => {
  const context = {module: {exports: {}}, File, BdApi: {React: {Component: class {}}, Webpack: {
    getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  context.module.exports = require('./helpers/core.cjs').loadCore(context).webpFile;
  for (const [chunk, flags, name] of [['VP8X', 2, 'dccon.webp'], ['VP8X', 18, 'dccon.webp'],
    ['VP8X', 16, 'dccon.gif'], ['VP8L', 2, 'dccon.gif'], ['VP8 ', 0, 'dccon.gif']]) {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8);
    bytes.write(chunk, 12); bytes.writeUInt32LE(10, 16); bytes[20] = flags;
    const file = context.module.exports(bytes);
    assert.equal(file.name, name);
    assert.equal(file.type, 'image/webp');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  }
});

test('real WASM codecs preserve still pixels, GIF playback, and survive repeated conversions in a Worker', {skip: !executablePath}, async t => {
  const context = {module: {exports: {}}, BdApi: {React: {Component: class {}}, Webpack: {
    getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  context.module.exports = require('./helpers/core.cjs').loadCore(context).WebPCache;
  const codec = context.module.exports;
  const assets = {};
  for (const [kind, {name, hashes}] of Object.entries(codec.specs).filter(([, spec]) => spec.name)) {
    const dir = path.join(__dirname, '../node_modules/@libwebp-wasm', name, 'es');
    const source = fs.readFileSync(path.join(dir, name + '.js'));
    const wasm = fs.readFileSync(path.join(dir, name + '.wasm'));
    for (const [i, bytes] of [source, wasm].entries())
      assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), hashes[i]);
    assets[kind] = {source: source.toString(), wasm: [...wasm]};
  }
  const browser = await chromium.launch({executablePath, headless: true});
  t.after(() => browser.close());
  const server = require('node:http').createServer((_, response) => {
    response.setHeader('Content-Security-Policy', "connect-src 'none'");
    response.end('<!doctype html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = await browser.newPage();
  page.on('console', message => {if (message.type() === 'error') t.diagnostic(message.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(async ({workerSource, assets}) => {
    const workerURL = URL.createObjectURL(new Blob([`(${workerSource})()`], {type: 'text/javascript'}));
    const worker = new Worker(workerURL, {type: 'module'});
    const convert = (bytes, kind, frames) => new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(Error(data.error)) : resolve(new Uint8Array(data.bytes));
      worker.onerror = e => reject(Error(e.message));
      worker.postMessage({bytes, kind, frames, runtime: {...assets[kind], wasm: new Uint8Array(assets[kind].wasm)}});
    });
    const decode = async (bytes, type) => {
      const decoder = new ImageDecoder({data: bytes, type});
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack, frames = [];
      for (let i = 0; i < track.frameCount; i++) {
        const {image} = await decoder.decode({frameIndex: i});
        const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        frames.push({duration: image.duration, width: canvas.width, height: canvas.height,
          pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data]});
        image.close();
      }
      const result = {frames, repetitionCount: track.repetitionCount}; decoder.close(); return result;
    };
    try {
      const canvas = new OffscreenCanvas(3, 2), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff0044'; ctx.fillRect(0, 0, 1, 2);
      ctx.fillStyle = 'rgba(0,128,255,0.5)'; ctx.fillRect(1, 0, 1, 2);
      const png = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({type: 'image/jpeg'})).arrayBuffer());
      // Two different 1x1 frames: 80/140ms, finite repetition, global palette.
      const gif = new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,255,0,0,0,0,255,
        33,255,11,...new TextEncoder().encode('NETSCAPE2.0'),3,1,3,0,0,
        33,249,4,4,8,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,
        33,249,4,4,14,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,76,1,0,59]);
      const output = [];
      const sequence = await convert(new Uint8Array(), 'img', [{bytes: png, duration: 80}, {bytes: jpeg, duration: 140}]);
      const stills = [await decode(png, 'image/png'), await decode(jpeg, 'image/jpeg')];
      const sequenceAfter = await decode(sequence, 'image/webp');
      output.push({before: {frames: stills.map((item, i) => ({...item.frames[0], duration: [80000, 140000][i]})),
        repetitionCount: Infinity}, after: sequenceAfter});
      for (const [bytes, type, kind] of [[png, 'image/png', 'img'], [gif, 'image/gif', 'gif'], [jpeg, 'image/jpeg', 'img'], [png, 'image/png', 'img'], [gif, 'image/gif', 'gif']]) {
        const started = performance.now(), webp = await convert(bytes, kind);
        output.push({before: await decode(bytes, type), after: await decode(webp, 'image/webp'),
          inputBytes: bytes.length, outputBytes: webp.length, ms: performance.now() - started});
      }
      return output;
    } finally {worker.terminate(); URL.revokeObjectURL(workerURL);}
  }, {workerSource: codec.workerMain.toString().replace(/^workerMain\(\)/, 'function()'), assets});
  for (const result of results) assert.deepEqual(result.after, result.before);
  t.diagnostic(JSON.stringify(results.map(({inputBytes, outputBytes, ms}) => ({inputBytes, outputBytes, ms}))));
});

test('codec downloads are pinned, cached offline, coalesced, and reject altered contents', async t => {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-codec-test-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  let fetches = 0, offline = false, corrupt = false;
  const context = {module: {exports: {}}, require, AbortController, TextDecoder,
    BdApi: {Plugins: {folder, cacheFolder: path.join(folder, "cache")}, React: {Component: class {}}, Net: {fetch: async url => {
      fetches++; if (offline) throw Error('offline');
      const name = url.split('/').pop();
      return {arrayBuffer: async () => corrupt ? Buffer.from('tampered') : fs.readFileSync(path.join(__dirname, '../node_modules/@libwebp-wasm/gif2webp/es', name))};
    }}, Webpack: {getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  context.module.exports = require('./helpers/core.cjs').loadCore(context).WebPCache;
  const codec = context.module.exports;
  await Promise.all([codec.runtime('gif', 0), codec.runtime('gif', 0)]);
  assert.equal(fetches, 2);
  codec.stop(); offline = true;
  await codec.runtime('gif', codec.generation);
  assert.equal(fetches, 2);
  codec.stop(); offline = false; corrupt = true;
  fs.writeFileSync(path.join(folder, 'cache/webp-codecs', codec.specs.gif.hashes[0]), 'tampered');
  await assert.rejects(codec.runtime('gif', codec.generation), /무결성/);
  corrupt = false;
  await codec.runtime('gif', codec.generation);
  assert.equal(fetches, 4);
});

test('GIF fallback only handles codec conversion errors and stays in the cancellable queue', async () => {
  const workers = [], requests = [];
  class Worker {
    constructor() {this.messages = []; workers.push(this);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated = true;}
  }
  const context = {module: {exports: {}}, Worker, URL, Blob, BdApi: {
    React: {Component: class {}}, Webpack: {getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  context.module.exports = require('./helpers/core.cjs').loadCore(context).WebPCache;
  const codec = context.module.exports, gif = new TextEncoder().encode('GIF89a');
  codec.runtime = async kind => {requests.push(kind); return {source: '', wasm: new Uint8Array()};};
  const first = codec.convert(gif);
  await new Promise(resolve => setImmediate(resolve));
  workers[0].onmessage({data: {error: 'conversion failed', gifFrameError: true}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['gif', 'img']);
  assert.equal(workers[0].messages[1].compositeGif, true);
  const queued = codec.convert(gif);
  const rejected = [assert.rejects(first, /중단/), assert.rejects(queued, /중단/)];
  codec.stop();
  await Promise.all(rejected);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 2);

  requests.length = 0;
  const failure = codec.convert(gif);
  const failed = assert.rejects(failure, /loading failed/);
  await new Promise(resolve => setImmediate(resolve));
  workers[1].onmessage({data: {error: 'loading failed'}});
  await failed;
  assert.deepEqual(requests, ['gif']);
  requests.length = 0;
  codec.runtime = async kind => {requests.push(kind); throw Error('download failed');};
  await assert.rejects(codec.convert(gif), /download failed/);
  assert.deepEqual(requests, ['gif']);
  codec.stop();
});

test('GIF fallback preserves composited pixels, disposal, timing and finite loops with real codecs', {skip: !executablePath}, async t => {
  const context = {module: {exports: {}}, BdApi: {React: {Component: class {}}, Webpack: {
    getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  require('./helpers/core.cjs').loadCore(context);
  const {WebPCache: codec, isWebP} = context.module.exports, assets = {};
  for (const [kind, {name}] of Object.entries(codec.specs).filter(([, spec]) => spec.name)) {
    const directory = path.join(__dirname, '../node_modules/@libwebp-wasm', name, 'es');
    assets[kind] = {source: fs.readFileSync(path.join(directory, name + '.js'), 'utf8'),
      wasm: [...fs.readFileSync(path.join(directory, name + '.wasm'))]};
  }
  const browser = await chromium.launch({executablePath, headless: true});
  t.after(() => browser.close());
  const server = require('node:http').createServer((_, response) => {
    response.setHeader('Content-Security-Policy', "connect-src 'none'; worker-src blob:");
    response.end('<!doctype html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({methods, isWebPSource, assets}) => {
    const isWebP = eval(`(${isWebPSource})`), codec = {generation: 0, work: Promise.resolve(), assets: new Map(), downloads: new Set()};
    for (const [name, source] of Object.entries(methods)) codec[name] = eval(`(${source.replace(/^\w+\(/, 'function(')})`);
    const requests = [];
    codec.runtime = async kind => {requests.push(kind); return {...assets[kind], wasm: new Uint8Array(assets[kind].wasm)};};
    // Three 3x3 frames stored in a 2x2 logical screen, with transparency and disposal 1/2/3.
    const gif = Uint8Array.from(atob('R0lGODlhAgACAIEAAAAAAP8AAAAAAAAAACH/C05FVFNDQVBFMi4wAwEDAAAh+QQFCAAAACwAAAAAAwADAAAICAADABhIcGBAACH5BAkOAAAALAAAAAACAAEAgQAAAAD/AAAAAAAAAAgFAAEECAgAIfkEDRQAAAAsAAAAAAMAAwCBAAAAAAD/AAAAAAAACAgAAQgMILBgQAA7'), c => c.charCodeAt(0));
    const decode = async (bytes, type) => {
      const decoder = new ImageDecoder({data: bytes, type});
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack, frames = [];
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const {image} = await decoder.decode({frameIndex});
          try {
            const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight), ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            frames.push({duration: image.duration, width: canvas.width, height: canvas.height,
              pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data]});
          } finally {image.close();}
        }
        return {frames, repetitionCount: track.repetitionCount};
      } finally {decoder.close();}
    };
    try {
      const converted = await codec.convert(gif);
      const before = await decode(gif, 'image/gif'), after = await decode(converted, 'image/webp');
      const normal = gif.slice(); normal[6] = normal[8] = 3;
      requests.length = 0;
      await codec.convert(normal);
      const normalRequests = requests.slice();
      // Reuse both codec runtimes after the first fallback and after a successful GIF conversion.
      const repeated = await decode(await codec.convert(gif), 'image/webp');
      return {before, after, repeated, normalRequests};
    } finally {codec.stop();}
  }, {methods: Object.fromEntries(['workerMain', 'convert', 'stop'].map(name => [name, codec[name].toString()])),
    isWebPSource: isWebP.toString(), assets});
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.repeated, result.before);
  assert.deepEqual(result.normalRequests, ['gif']);
  assert.equal(result.before.frames.length, 3);
  assert.deepEqual(result.before.frames.map(frame => frame.duration), [80000, 140000, 200000]);
});
