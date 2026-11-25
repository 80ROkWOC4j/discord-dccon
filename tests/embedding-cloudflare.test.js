const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCloudflareEmbedding, prepareCloudflareImage, sampleCloudflareFrames} = require('../src/core/embedding-cloudflare.ts');

const credentials = {accountId: 'a'.repeat(32), apiToken: 'dummy-token'};
const vector = () => [3, 4, ...Array(766).fill(0)];
const ok = count => ({status: 200, ok: true, text: async () => JSON.stringify({success: true,
  result: {data: Array.from({length: count}, (_, index) => ({index, embedding: index % 2 ? [-3, ...vector().slice(1)] : vector()})).reverse()}})});
const signal = () => new AbortController().signal;
const image = [[{role: 'user', content: [{type: 'image_url', image_url: {url: 'data:image/jpeg;base64,AA'}}]}]];

test('Cloudflare request shape, ordering, normalization and invalid response', async () => {
  const requests = [];
  const api = createCloudflareEmbedding({fetch: async (url, options) => {requests.push({url, options}); return ok(requests.length === 1 ? 1 : 2);}});
  assert.deepEqual((await api.query(credentials, 'cat', signal())).slice(0, 2), [0.6, 0.8]);
  const vectors = await api.imageBatch(credentials, [image[0], image[0]]);
  assert.deepEqual(vectors.map(row => row[0]), [0.6, -0.6]);
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/@cf/google/embeddinggemma-2`);
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(requests[0].options.headers, {Authorization: 'Bearer dummy-token', 'Content-Type': 'application/json'});
  assert.equal(requests[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(requests[0].options.body), {input: ['task: search result | query: cat']});
  assert.deepEqual(JSON.parse(requests[1].options.body), {messages: [image[0], image[0]]});
  for (const data of [[], [{index: 0, embedding: [1]}], [{index: 1, embedding: vector()}],
    [{index: 0, embedding: Array(768).fill(0)}], [{index: 0, embedding: Array(768).fill('1')}],
    [{index: 0, embedding: [null, ...vector().slice(1)]}]]) {
    const bad = createCloudflareEmbedding({fetch: async () => ({status: 200, ok: true,
      text: async () => JSON.stringify({success: true, result: {data}})})});
    await assert.rejects(bad.query(credentials, 'bad', signal()), /유효하지 않은/);
  }
});

test('errors redact server and network secrets; authentication and rate limits are fatal', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const api = createCloudflareEmbedding({fetch: async () => ({status, ok: false, text: async () => JSON.stringify({errors: [{code: 8006, message: credentials.apiToken + credentials.accountId}]})})});
    await assert.rejects(api.query(credentials, 'x', signal()), error => {
      assert.equal(error.fatal, [401, 403, 429].includes(status));
      assert.ok(!error.message.includes(credentials.apiToken) && !error.message.includes(credentials.accountId));
      assert.match(error.message, new RegExp(String(status)));
      return true;
    });
  }
  for (const status of [0, 301, 307, 399]) {
    const redirect = createCloudflareEmbedding({fetch: async () => ({status, ok: false,
      text: async () => assert.fail('Redirect body should not be read')})});
    await assert.rejects(redirect.query(credentials, 'x', signal()), /리다이렉트가 차단/);
  }
  const api = createCloudflareEmbedding({fetch: async () => {throw Error(credentials.accountId + credentials.apiToken);}});
  await assert.rejects(api.query(credentials, 'x', signal()), error => !error.message.includes(credentials.accountId) && !error.message.includes(credentials.apiToken));
});

test('query LRU evicts least recently used and stop aborts and clears cache', async () => {
  let calls = 0, pendingSignal;
  const api = createCloudflareEmbedding({fetch: async (_, options) => {
    calls++;
    if (JSON.parse(options.body).input[0].endsWith('pending')) {
      pendingSignal = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true}));
    }
    return ok(1);
  }});
  for (let i = 0; i < 50; i++) await api.query(credentials, String(i), signal());
  await api.query(credentials, '0', signal());
  await api.query(credentials, '50', signal());
  await api.query(credentials, '0', signal());
  assert.equal(calls, 51);
  await api.query(credentials, '1', signal()); assert.equal(calls, 52);
  const pending = api.query(credentials, 'pending', signal());
  const rejected = assert.rejects(pending);
  api.stop(); await rejected; assert.equal(pendingSignal.aborted, true);
  await api.query(credentials, '0', signal()); assert.equal(calls, 54);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.query(credentials, '0', controller.signal), {name: 'AbortError'});
});

function canvasGlobals() {
  const old = {document: global.document, createImageBitmap: global.createImageBitmap, ImageDecoder: global.ImageDecoder};
  const canvases = [];
  global.document = {createElement: () => {const c = {getContext: () => ({fillRect() {}, drawImage() {}}), toDataURL: (type, quality) => {assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.86); return 'data:image/jpeg;base64,AA';}}; canvases.push(c); return c;}};
  return {canvases, restore() {for (const [key, value] of Object.entries(old)) value === undefined ? delete global[key] : global[key] = value;}};
}

test('image preparation samples animated frames, closes resources and falls back to bitmap', async () => {
  const env = canvasGlobals(); let closed = 0, decoderClosed = 0, bitmapClosed = 0; const decoded = [];
  try {
    global.ImageDecoder = class {constructor() {this.tracks = {ready: Promise.resolve(), selectedTrack: {frameCount: 8}};} async decode({frameIndex}) {decoded.push(frameIndex); return {image: {displayWidth: 512, displayHeight: 256, duration: 100, close() {closed++;}}};} close() {decoderClosed++;}};
    const file = {type: 'image/gif', arrayBuffer: async () => new ArrayBuffer(1)};
    const result = await prepareCloudflareImage(file, () => {});
    assert.equal(result[0].role, 'user'); assert.equal(result[0].content.length, 6);
    assert.deepEqual(decoded.slice(8), sampleCloudflareFrames(Array(8).fill(100)));
    assert.equal(closed, 14); assert.equal(decoderClosed, 1);
    assert.deepEqual([env.canvases[0].width, env.canvases[0].height], [256, 128]);
    global.ImageDecoder = class {constructor() {throw Error('unsupported');}};
    global.createImageBitmap = async () => ({width: 800, height: 400, close() {bitmapClosed++;}});
    const fallback = await prepareCloudflareImage(file, () => {});
    assert.equal(fallback[0].content.length, 1); assert.equal(bitmapClosed, 1);
    assert.deepEqual([env.canvases.at(-1).width, env.canvases.at(-1).height], [384, 192]);
    await prepareCloudflareImage({type: 'image/png'}, () => {}); assert.equal(bitmapClosed, 2);
  } finally {env.restore();}
});

function runtime(count, fetch) {
  const data = {embeddingEnabled: true, embeddingProvider: 'cloudflare', embeddingCloudflareCredentials: credentials,
    dccons: [{info: {package_idx: 1}, detail: Array.from({length: count}, (_, i) => ({path: String(i), ext: 'png'}))}]};
  const context = {module: {exports: {}}, structuredClone, setTimeout, clearTimeout, URL, AbortController, ArrayBuffer, require,
    document: {createElement: () => ({getContext: () => ({fillRect() {}, drawImage() {}}), toDataURL: () => 'data:image/jpeg;base64,AA'})},
    createImageBitmap: async () => ({width: 10, height: 10, close() {}}),
    BdApi: {Logger: {error() {}}, Net: {fetch}, Data: {load: (_, key) => data[key], save: (_, key, value) => {data[key] = value;}},
      React: {Component: class {}}, Webpack: {getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  require('./helpers/core.cjs').loadCore(context);
  const {Embedding: e, setImageLoader} = context.module.exports;
  const saved = []; let temporary;
  e.ready = true; e.vectorDirectory = () => '/test';
  e.files = () => ({readFile: async () => {throw Error('missing');}, mkdir: async () => {}, writeFile: async (_, text) => {temporary = JSON.parse(text);}, rename: async () => {saved.push(temporary);}});
  setImageLoader(async () => ({type: 'image/png'}));
  return {e, saved, setImageLoader};
}

test('cloud index batches four, retries failed batches individually, and checkpoints successes', async () => {
  const sizes = [];
  const {e, saved} = runtime(5, async (_, options) => {
    const count = JSON.parse(options.body).messages.length; sizes.push(count);
    if (sizes.length === 1) return {status: 400, ok: false, text: async () => JSON.stringify({errors: [{code: 8006}]})};
    if (sizes.length === 3) return {status: 500, ok: false, text: async () => '{}'};
    return ok(count);
  });
  await e.index();
  assert.deepEqual(sizes, [4, 1, 1, 1, 1, 1]);
  assert.equal(e.status.completed, 5); assert.equal(e.status.errors, 1);
  assert.equal(e.status.phase, '완료 · 일부 실패'); assert.equal(saved.length, 4);
  assert.ok(saved.every(item => item.spec === 'cf-embeddinggemma-2-v1'));
  assert.equal(e.dirtyVectors, 0);
});

test('outages do not split batches and stop after three consecutive failures, checkpointing successes', async () => {
  for (const failure of ['503', '400-5007', 'network', 'invalid']) {
    const sizes = [];
    const {e, saved} = runtime(24, async (_, options) => {
      const count = JSON.parse(options.body).messages.length; sizes.push(count);
      if (sizes.length === 1) return ok(count);
      if (failure === 'network') throw Error('network');
      if (failure === 'invalid') return {status: 200, ok: true, text: async () => '{}'};
      if (failure === '400-5007') return {status: 400, ok: false, text: async () => JSON.stringify({errors: [{code: 5007}]})};
      return {status: 503, ok: false, text: async () => '{}'};
    });
    await e.index();
    assert.deepEqual(sizes, [4, 4, 4, 4], failure);
    assert.equal(saved.length, 4); assert.equal(e.status.phase, '오류');
    assert.equal(e.status.errors, 12); assert.equal(e.ready, false);
    await e.index();
    assert.equal(sizes.length, 4, 'indexing stays halted until explicit restart');
  }
});

test('all failures are an error, but cached vectors count as partial success', async () => {
  for (const cached of [false, true]) {
    const {e} = runtime(2, async () => ({status: 500, ok: false, text: async () => '{}'}));
    if (cached) e.vectors['0:png'] = [1, ...Array(767).fill(0)];
    await e.index();
    assert.equal(e.status.phase, cached ? '완료 · 일부 실패' : '오류');
  }
  const {e, setImageLoader} = runtime(2, async () => {throw Error('unused');});
  setImageLoader(async () => ({type: 'image/png', arrayBuffer: async () => new ArrayBuffer(1)}));
  e.provider = () => 'local';
  e.call = async () => {throw Error('local inference failed');};
  e.files = () => ({readFile: async () => {throw Error('missing');}});
  await e.index();
  assert.equal(e.status.phase, '오류');
});

test('fatal cloud index error stops further calls and checkpoints previous batch', async () => {
  let calls = 0;
  const {e, saved} = runtime(8, async (_, options) => {
    calls++;
    return calls === 1 ? ok(JSON.parse(options.body).messages.length) : {status: 401, ok: false};
  });
  await e.index();
  assert.equal(calls, 2); assert.equal(saved.length, 4); assert.equal(e.ready, false);
  assert.equal(e.status.phase, '오류'); assert.match(e.status.error, /401/);
});

test('stopping cloud index aborts active request without persisting stale results', async () => {
  let started; const ready = new Promise(resolve => {started = resolve;}); let requestSignal;
  const {e, saved} = runtime(4, async (_, options) => {
    requestSignal = options.signal; started();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true}));
  });
  const indexing = e.index(); await ready; e.stop(); await indexing;
  assert.equal(requestSignal.aborted, true); assert.equal(saved.length, 0);
  assert.equal(e.status.phase, '꺼짐'); assert.equal(Object.keys(e.vectors).length, 0);
});
