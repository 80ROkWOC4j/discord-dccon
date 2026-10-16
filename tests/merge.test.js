const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { chromium } = require("playwright");
const executablePath = [process.env.WEBP_TEST_BROWSER, chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
function api(extra = {}) {
  const context = { module: { exports: {} }, URL, Blob, File, BdApi: { React: { Component: class {
  } }, Webpack: { getByKeys: () => ({}), getModule: () => ({}), Filters: { byKeys: () => () => true } } }, ...extra };
  vm.runInNewContext(require('./helpers/core.cjs').coreSource() + "\nmodule.exports={WebPCache,animationTiming,mergeAnimationReason,mergeAnimatedImages,getMergedImage,BdApi,setMergeForTest: value => {mergeAnimatedImages = value;}};", context);
  return context.module.exports;
}

const mergedFixture = Buffer.from('UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAAJWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAABWUDhMDwAAAC8AAAAABxDR//4HIqL/AQA=', 'base64');
function mergedCache(t, {native = false, writeFails = false} = {}) {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-merged-cache-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const nativeFile = require('../shelter/native').createFiles(folder, undefined, path.join(folder, "cache"));
  const filesystem = Object.fromEntries(['readFile', 'mkdir', 'writeFile', 'rename', 'unlink'].map(method => [method, (...args) => {
    const callback = args.pop();
    if (writeFails && method === 'writeFile') return callback(Error('disk full'));
    // BetterDiscord defaults to UTF-8; binary cache reads must pass null explicitly.
    if (method === 'readFile' && args[1] === undefined) args[1] = 'utf8';
    if (native) nativeFile(method, args).then(value => callback(null, value), error => callback(error));
    else fs[method](...args, callback);
  }]));
  const load = () => {
    const h = api({require: name => name === 'fs' ? filesystem : native && name === 'path'
      ? {join: (...parts) => parts.join('/'), dirname: value => value.slice(0, value.lastIndexOf('/'))} : require(name)});
    h.BdApi.Plugins = {folder: native ? '/dccon' : folder, cacheFolder: native ? '/cache' : path.join(folder, 'cache')};
    h.errors = [];
    h.BdApi.Logger = {error: (...args) => h.errors.push(args)};
    return h;
  };
  const entry = value => ({con: {path: value, ext: 'gif'}, file: new File([value], 'source.webp', {type: 'image/webp'})});
  return {folder, load, entries: [entry('a'), entry('b'), entry('a')]};
}

test('merged cache coalesces requests, persists after reload, and keys include ordered duplicates and version', async t => {
  const {folder, load, entries} = mergedCache(t), first = load();
  let encodes = 0;
  first.setMergeForTest(async () => {encodes++; return new File([mergedFixture], 'dccon.webp', {type: 'image/webp'});});
  const pair = entries.slice(0, 2);
  const [a, b] = await Promise.all([first.getMergedImage(pair, () => {}), first.getMergedImage(pair, () => {})]);
  assert.equal(encodes, 1);
  assert.equal(a, b);
  const key = require('node:crypto').createHash('sha256').update(JSON.stringify({type: 'merged', version: 1,
    images: pair.map(({con}) => [con.path, con.ext])})).digest('hex');
  const target = path.join(folder, 'cache', 'merged', key);
  assert.deepEqual(fs.readFileSync(target), mergedFixture);
  assert.equal(a.type, 'image/webp');
  assert.equal(a.name, 'dccon.webp');
  await first.getMergedImage([...pair].reverse(), () => {});
  await first.getMergedImage([entries[0], entries[0]], () => {});
  await first.getMergedImage(entries, () => {});
  assert.equal(encodes, 4);
  assert.equal(fs.readdirSync(path.dirname(target)).length, 4);
  const reloaded = load();
  reloaded.setMergeForTest(async () => {throw Error('must not encode');});
  const cached = await reloaded.getMergedImage(pair, () => {});
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), mergedFixture);
  assert.deepEqual(reloaded.errors, []);
});

test('merged cache rejects unreadable data and failed composition is retried without saving', async t => {
  const {folder, load, entries} = mergedCache(t), h = load();
  let encodes = 0;
  h.setMergeForTest(async () => {encodes++; throw Error('conversion failed');});
  await assert.rejects(h.getMergedImage(entries, () => {}), /conversion failed/);
  await assert.rejects(h.getMergedImage(entries, () => {}), /conversion failed/);
  assert.equal(encodes, 2);
  assert.equal(fs.existsSync(path.join(folder, 'cache', 'merged')), false);
  h.setMergeForTest(async () => {encodes++; return new File([mergedFixture], 'dccon.webp', {type: 'image/webp'});});
  await h.getMergedImage(entries, () => {});
  const directory = path.join(folder, 'cache', 'merged'), target = path.join(directory, fs.readdirSync(directory)[0]);
  for (const invalid of [Buffer.alloc(0), Buffer.from('corrupt'), mergedFixture.subarray(0, 10), mergedFixture.subarray(0, 40)]) {
    fs.writeFileSync(target, invalid);
    await h.getMergedImage(entries, () => {});
    assert.deepEqual(fs.readFileSync(target), mergedFixture);
  }
  assert.equal(encodes, 7);
});

test('standalone filesystem persists merged images and write failures still return the generated file', async t => {
  const {load, entries} = mergedCache(t, {native: true}), h = load();
  h.setMergeForTest(async () => new File([mergedFixture], 'dccon.webp', {type: 'image/webp'}));
  await h.getMergedImage(entries, () => {});
  const reloaded = load();
  reloaded.setMergeForTest(async () => {throw Error('must not encode');});
  assert.deepEqual(Buffer.from(await (await reloaded.getMergedImage(entries, () => {})).arrayBuffer()), mergedFixture);
  const failing = mergedCache(t, {writeFails: true}), writer = failing.load();
  writer.setMergeForTest(async () => new File([mergedFixture], 'dccon.webp', {type: 'image/webp'}));
  const file = await writer.getMergedImage(failing.entries, () => {});
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), mergedFixture);
  assert.equal(writer.errors.length, 1);
});

test('cancelled merged requests cannot write a cache and a later request can retry', async t => {
  const {folder, load, entries} = mergedCache(t), h = load();
  let finish, active = true;
  h.setMergeForTest(() => new Promise(resolve => {finish = resolve;}));
  const request = h.getMergedImage(entries, () => {if (!active) throw Error('cancelled');});
  const rejected = assert.rejects(request, /cancelled/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  active = false;
  finish(new File([mergedFixture], 'dccon.webp', {type: 'image/webp'}));
  await rejected;
  assert.equal(fs.existsSync(path.join(folder, 'cache', 'merged')), false);
  active = true;
  h.setMergeForTest(async () => new File([mergedFixture], 'dccon.webp', {type: 'image/webp'}));
  await h.getMergedImage(entries, () => {});
  assert.equal(fs.readdirSync(path.join(folder, 'cache', 'merged')).length, 1);
});
test("merge eligibility requires 2-3 animations with identical duration and repetitions and caches metadata", async () => {
  const timings = { 1: [80, 120], 2: [50, 150], 3: [50, 100], 4: [200], 5: [80, 120] };
  let closed = 0, created = 0;
  class ImageDecoder2 {
    constructor({ data }) {
      this.id = data[0];
      created++;
      this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: timings[this.id].length, repetitionCount: this.id === 5 ? 2 : Infinity } };
    }
    async decode({ frameIndex }) {
      return { image: { duration: timings[this.id][frameIndex] * 1e3, close() {
      } } };
    }
    close() {
      closed++;
    }
  }
  const { mergeAnimationReason, mergeAnimatedImages, WebPCache } = api({ ImageDecoder: ImageDecoder2 });
  const files = [1, 2, 3, 4, 5].map((n) => new File([new Uint8Array([n])], "con.webp", { type: "image/webp" }));
  assert.equal(await mergeAnimationReason(files.slice(0, 2)), "");
  assert.equal(await mergeAnimationReason(files.slice(0, 2)), "");
  assert.equal(created, 2);
  assert.match(await mergeAnimationReason([files[0], files[2]]), /재생 길이/);
  assert.match(await mergeAnimationReason([files[0], files[3]]), /애니메이션 이미지/);
  assert.match(await mergeAnimationReason([files[0], files[4]]), /반복 횟수/);
  assert.match(await mergeAnimationReason([files[0]]), /2~3개/);
  assert.match(await mergeAnimationReason(files.slice(0, 4)), /2~3개/);
  let merges = 0;
  WebPCache.merge = async () => {
    merges++;
    throw Error("must not encode");
  };
  await assert.rejects(mergeAnimatedImages([files[0], files[2]], () => {
  }), /재생 길이/);
  await assert.rejects(mergeAnimatedImages(files.slice(0, 2), () => {
    throw Error("cancelled");
  }), /cancelled/);
  assert.equal(merges, 0);
  assert.equal(closed, created);
});
test("merge reuses the split worker and stopping cancels the combined image and queued operations", async () => {
  const workers = [];
  class Worker2 {
    constructor() {
      this.messages = [];
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
    }
    terminate() {
      this.terminated = true;
    }
  }
  const { WebPCache: codec } = api({ Worker: Worker2 });
  codec.runtime = async () => ({ source: "", wasm: new Uint8Array([1]) });
  const first = codec.merge([new Uint8Array([1]), new Uint8Array([2])]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers[0].messages[0].images.length, 2);
  const output = new ArrayBuffer(4);
  workers[0].onmessage({ data: { bytes: output } });
  assert.equal(await first, output);
  const second = codec.merge([new Uint8Array([1]), new Uint8Array([2])]);
  const queued = codec.split(new Uint8Array([3]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[1].wasm, void 0);
  const rejected = [assert.rejects(second, /중단/), assert.rejects(queued, /중단/)];
  codec.stop();
  await Promise.all(rejected);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 2);
});
test("real merge preserves 2-3 animation pixels, unequal frame schedules, original sizes, transparent padding and finite loops", { skip: !executablePath }, async (t) => {
  const { WebPCache: codec } = api();
  const assets = {};
  for (const [kind, { name }] of Object.entries(codec.specs).filter(([, spec]) => spec.name)) {
    const directory = path.join(__dirname, "../node_modules/@libwebp-wasm", name, "es");
    assets[kind] = { source: fs.readFileSync(path.join(directory, name + ".js"), "utf8"), wasm: [...fs.readFileSync(path.join(directory, name + ".wasm"))] };
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const server = require("node:http").createServer((_, r) => {
    r.setHeader("Content-Security-Policy", "connect-src 'none'; worker-src blob:");
    r.end("<!doctype html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ workerSource, mergeSource, wasm, assets: assets2 }) => {
    const codecWorker = new Worker(URL.createObjectURL(new Blob([`(${workerSource})()`], { type: "text/javascript" })), { type: "module" });
    const mergeWorker = new Worker(URL.createObjectURL(new Blob([mergeSource], { type: "text/javascript" })), { type: "module" });
    let initialized = false;
    const convert = (frames, loopCount) => new Promise((resolve, reject) => {
      codecWorker.onmessage = ({ data }) => data.error ? reject(Error(data.error)) : resolve(new Uint8Array(data.bytes));
      codecWorker.onerror = (e) => reject(Error(e.message));
      codecWorker.postMessage({ bytes: new Uint8Array(), kind: "img", frames, loopCount, runtime: { ...assets2.img, wasm: new Uint8Array(assets2.img.wasm) } });
    });
    const merge = (images) => new Promise((resolve, reject) => {
      mergeWorker.onmessage = ({ data }) => data.error ? reject(Error(data.error)) : resolve(new Uint8Array(data.bytes));
      mergeWorker.onerror = (e) => reject(Error(e.message));
      mergeWorker.postMessage({ images, wasm: initialized ? void 0 : new Uint8Array(wasm) });
      initialized = true;
    });
    const make = async (width, height, colors, durations, loops = 3) => {
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d"), frames = [];
      for (let i = 0; i < colors.length; i++) {
        ctx.fillStyle = colors[i];
        ctx.fillRect(0, 0, width, height);
        frames.push({ bytes: new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()), duration: durations[i] });
      }
      return convert(frames, loops);
    };
    const decode = async (bytes) => {
      const decoder = new ImageDecoder({ data: bytes, type: "image/webp" });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack, frames = [];
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const { image } = await decoder.decode({ frameIndex });
          try {
            const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight), ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            frames.push({ width: canvas.width, height: canvas.height, duration: image.duration, pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] });
          } finally {
            image.close();
          }
        }
        return { frames, repetitionCount: track.repetitionCount };
      } finally {
        decoder.close();
      }
    };
    try {
      const a = await make(2, 2, ["red", "blue"], [100, 100]), b = await make(1, 4, ["lime", "yellow"], [50, 150]), c = await make(2, 2, ["white", "black", "magenta"], [50, 50, 100]);
      const two = await decode(await merge([a, b])), three = await decode(await merge([a, b, c]));
      const failures = [];
      for (const images of [[a], [a, b, c, a], [a, await make(2, 2, ["red", "blue"], [100, 150])], [a, await make(2, 2, ["red", "blue"], [100, 100], 2)], [a, await make(2, 2, ["red"], [200])]]) {
        try {
          await merge(images);
          failures.push("accepted");
        } catch (error) {
          failures.push(error.message);
        }
      }
      const reused = await decode(await merge([a, b]));
      return { two, three, reused, failures };
    } finally {
      codecWorker.terminate();
      mergeWorker.terminate();
    }
  }, {
    workerSource: codec.workerMain.toString().replace(/^workerMain\(\)/, "function()"),
    mergeSource: codec.specs.split.source,
    wasm: [...fs.readFileSync(path.join(__dirname, "../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm"))],
    assets
  });
  const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], lime = [0, 255, 0, 255], yellow = [255, 255, 0, 255], transparent = [0, 0, 0, 0];
  const white = [255, 255, 255, 255], black = [0, 0, 0, 255], magenta = [255, 0, 255, 255];
  for (const [key, width] of [["two", 3], ["three", 5]]) {
    assert.equal(result[key].repetitionCount, 2);
    assert.deepEqual(result[key].frames.map((f) => f.duration), [5e4, 5e4, 1e5]);
    for (let i = 0; i < 3; i++) {
      const f = result[key].frames[i];
      assert.equal(f.width, width);
      assert.equal(f.height, 4);
      const a = i < 2 ? red : blue, b = i === 0 ? lime : yellow, c = [white, black, magenta][i];
      const expected = [];
      for (let y = 0; y < 4; y++) {
        const side = y === 1 || y === 2 ? a : transparent;
        expected.push(...side, ...side, ...b);
        if (width === 5) {
          const end = y === 1 || y === 2 ? c : transparent;
          expected.push(...end, ...end);
        }
      }
      assert.deepEqual(f.pixels, expected);
    }
  }
  assert.deepEqual(result.reused, result.two);
  assert.match(result.failures[0], /2~3개/);
  assert.match(result.failures[1], /2~3개/);
  assert.match(result.failures[2], /재생 길이/);
  assert.match(result.failures[3], /반복 횟수/);
  assert.match(result.failures[4], /애니메이션 이미지/);
});
