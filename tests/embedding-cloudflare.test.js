const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCloudflareEmbedding, prepareCloudflareImage, sampleCloudflareFrames,
  CLOUDFLARE_BATCH_ITEMS, CLOUDFLARE_BODY_LIMIT, CLOUDFLARE_CONCURRENCY} = require('../src/core/embedding-cloudflare.ts');

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

test('Cloudflare batch limits are explicit', () => {
  assert.equal(CLOUDFLARE_BATCH_ITEMS, 32);
  assert.equal(CLOUDFLARE_BODY_LIMIT, 6000000);
  assert.equal(CLOUDFLARE_CONCURRENCY, 4);
});

test('optional analytics uses authenticated GraphQL and validates its response', async () => {
  const creds = Object.freeze({...credentials}); let request;
  const groups = [{sum: {totalNeurons: 12.25}, count: 3}, {sum: {totalNeurons: 7.75}, count: 2}];
  let response = {data: {viewer: {accounts: [{aiInferenceAdaptiveGroups: groups}]}}, errors: null};
  const api = createCloudflareEmbedding({fetch: async (url, options) => {
    request = {url, options}; return {status: 200, ok: true, text: async () => JSON.stringify(response)};
  }});
  assert.deepEqual(await api.fetchUsage(creds), {neurons: 20, requests: 5});
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.redirect, 'manual');
  assert.equal(request.options.headers.Authorization, 'Bearer dummy-token');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.variables, {accountTag: creds.accountId, start: new Date().toISOString().slice(0, 10) + 'T00:00:00Z'});
  assert.match(body.query, /aiInferenceAdaptiveGroups\(limit: 10, filter: \{ datetime_geq: \$start \}\).*sum \{ totalNeurons \} count/);
  response = {data: {viewer: {accounts: [{aiInferenceAdaptiveGroups: []}]}}, errors: []};
  assert.deepEqual(await api.fetchUsage(creds), {neurons: 0, requests: 0});
  for (const value of [{}, {data: {}}, {data: {viewer: {accounts: []}}},
    {data: {viewer: {accounts: [{aiInferenceAdaptiveGroups: [{sum: {totalNeurons: '12'}, count: 3}]}]}}},
    {data: null, errors: [{message: creds.apiToken, extensions: {code: 'authz'}}]}]) {
    response = value; assert.equal(await api.fetchUsage(creds), null);
  }
  for (const status of [401, 403, 429, 500, 302]) {
    let read = false;
    const bad = createCloudflareEmbedding({fetch: async () => ({status, ok: false, text: async () => {read = true; return 'not json';}})});
    assert.equal(await bad.fetchUsage(creds), null);
    assert.equal(read, false);
  }
  const bad = createCloudflareEmbedding({fetch: async () => {throw Error('dummy-secret');}});
  assert.equal(await bad.fetchUsage(creds), null);
  assert.deepEqual(creds, credentials);
});

test('optional analytics is silent when configuration changed, aborted, or timed out', async t => {
  let calls = 0;
  const stale = createCloudflareEmbedding({fetch: async () => {calls++;}}, async () => {throw Error(credentials.apiToken);});
  assert.equal(await stale.fetchUsage(credentials), null);
  assert.equal(calls, 0);
  const use = createCloudflareEmbedding({fetch: async () => ({status: 200, ok: true, text: async () => 'not JSON'})});
  assert.equal(await use.fetchUsage(credentials), null);
  let active;
  const hung = createCloudflareEmbedding({fetch: async (_, options) => {
    active = options.signal;
    return new Promise(() => {});
  }});
  const controller = new AbortController();
  const aborted = hung.fetchUsage(credentials, controller.signal);
  controller.abort();
  assert.equal(await aborted, null);
  assert.equal(active.aborted, true);
  t.mock.timers.enable({apis: ['setTimeout']});
  const timedOut = hung.fetchUsage(credentials);
  t.mock.timers.tick(8_000);
  assert.equal(await timedOut, null);
  assert.equal(active.aborted, true);
});

function runtime(count, fetch) {
  const data = {embeddingEnabled: true, embeddingProvider: 'cloudflare', embeddingCloudflareCredentials: credentials,
    dccons: [{info: {package_idx: 1}, detail: Array.from({length: count}, (_, i) => ({path: String(i), ext: 'png'}))}]};
  const context = {module: {exports: {}}, structuredClone, setTimeout, clearTimeout, URL, AbortController, ArrayBuffer, require,
    document: {createElement: () => {let bitmap; return {getContext: () => ({fillRect() {}, drawImage(value) {bitmap = value;}}), toDataURL: () => `data:image/jpeg;base64,${bitmap?.id || 'AA'}`};}},
    createImageBitmap: async file => ({width: 10, height: 10, id: file.id, close() {}}),
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

test('splittable errors recursively bisect within one worker and isolate one bad item', async () => {
  for (const code of [8006, 5006]) {
    const sizes = []; let active = 0, peak = 0;
    const {e, saved, setImageLoader} = runtime(32, async (_, options) => {
      const messages = JSON.parse(options.body).messages;
      sizes.push(messages.length); peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return messages.some(item => item[0].content[0].image_url.url.endsWith(',bad'))
        ? {status: 400, ok: false, text: async () => JSON.stringify({errors: [{code}]})} : ok(messages.length);
    });
    let index = 0;
    setImageLoader(async () => ({type: 'image/png', id: index++ === 7 ? 'bad' : 'AA'}));
    await e.index();
    assert.deepEqual(sizes, [32, 16, 8, 4, 4, 2, 2, 1, 1, 8, 16]);
    assert.equal(peak, 1); assert.equal(e.status.completed, 32); assert.equal(e.status.errors, 1);
    assert.equal(e.status.phase, '완료 · 일부 실패'); assert.equal(saved.length, 31);
    assert.ok(saved.every(item => item.spec === 'cf-embeddinggemma-2-v1'));
    assert.equal(e.dirtyVectors, 0);
  }
});

test('recursive split uses the ceiling midpoint for odd-sized batches', async () => {
  const sizes = []; let index = 0;
  const {e, setImageLoader} = runtime(5, async (_, options) => {
    const messages = JSON.parse(options.body).messages; sizes.push(messages.length);
    return messages.some(item => item[0].content[0].image_url.url.endsWith(',bad'))
      ? {status: 400, ok: false, text: async () => JSON.stringify({errors: [{code: 8006}]})} : ok(messages.length);
  });
  setImageLoader(async () => ({type: 'image/png', id: index++ === 0 ? 'bad' : 'AA'}));
  await e.index();
  assert.deepEqual(sizes, [5, 3, 2, 1, 1, 1, 2]);
  assert.equal(e.status.errors, 1);
});

const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function waitFor(predicate) {
  for (let i = 0; i < 10000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'timed out waiting for asynchronous work');
}

test('four workers run while one next batch is prepared, then producer pauses', async () => {
  const pending = []; let prepared = 0, active = 0, peak = 0;
  const {e, setImageLoader} = runtime(192, async (_, options) => {
    const gate = deferred(); pending.push({gate, count: JSON.parse(options.body).messages.length});
    peak = Math.max(peak, ++active); await gate.promise; active--; return ok(32);
  });
  setImageLoader(async () => {prepared++; return {type: 'image/png'};});
  const indexing = e.index();
  try {
    await waitFor(() => pending.length === 4 && prepared >= 160);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepared, 160); assert.equal(peak, 4);
    assert.deepEqual(pending.map(item => item.count), [32, 32, 32, 32]);
    pending[0].gate.resolve(); await waitFor(() => pending.length === 5);
    await waitFor(() => prepared === 192);
  } finally {
    for (const item of pending) item.gate.resolve();
    // Resolve any batches launched as workers drain.
    for (let i = 0; i < 10000 && e.indexing; i++) {for (const item of pending) item.gate.resolve(); await new Promise(resolve => setImmediate(resolve));}
    if (e.indexing) e.stop();
    await indexing;
  }
  assert.equal(peak, 4); assert.equal(e.status.completed, 192);
});

test('outages do not split batches and stop after three consecutive failures, checkpointing successes', async () => {
  for (const failure of ['503', '400-5007', 'network', 'invalid']) {
    const pending = [];
    const {e, saved} = runtime(160, async (_, options) => {
      const gate = deferred(); pending.push({gate, count: JSON.parse(options.body).messages.length, signal: options.signal});
      const result = await gate.promise;
      if (result === 'network') throw Error('network');
      return result;
    });
    const indexing = e.index();
    try {
      await waitFor(() => pending.length === 4);
      pending[0].gate.resolve(ok(32)); await waitFor(() => saved.length === 32 && pending.length === 5);
      const result = failure === 'network' ? 'network' : failure === 'invalid' ? {status: 200, ok: true, text: async () => '{}'} :
        failure === '400-5007' ? {status: 400, ok: false, text: async () => JSON.stringify({errors: [{code: 5007}]})} : {status: 503, ok: false, text: async () => '{}'};
      for (let i = 1; i < 4; i++) {pending[i].gate.resolve(result); if (i < 3) await waitFor(() => e.status.errors >= i * 32);}
      await indexing;
      assert.deepEqual(pending.map(item => item.count), [32, 32, 32, 32, 32], failure);
      assert.equal(pending[4].signal.aborted, true);
      assert.equal(saved.length, 32); assert.equal(e.status.phase, '오류'); assert.equal(e.ready, false);
      await e.index(); assert.equal(pending.length, 5, 'indexing stays halted until explicit restart');
    } finally {e.stop(); for (const item of pending) item.gate.resolve('network'); await indexing;}
  }
});

test('a successful concurrent batch resets the outage counter', async () => {
  const fail = {status: 503, ok: false, text: async () => '{}'};
  const pending = [];
  const {e} = runtime(160, async () => {const gate = deferred(); pending.push(gate); return gate.promise;});
  const indexing = e.index();
  try {
    await waitFor(() => pending.length === 4);
    pending[0].resolve(fail); await waitFor(() => pending.length === 5);
    pending[1].resolve(fail); await waitFor(() => e.status.errors === 64);
    pending[2].resolve(ok(32)); await waitFor(() => e.status.completed === 96);
    pending[3].resolve(fail); pending[4].resolve(fail);
    await indexing;
    assert.equal(e.status.phase, '완료 · 일부 실패');
    assert.equal(e.status.errors, 128);
    assert.equal(e.status.completed, 160);
  } finally {e.stop(); for (const gate of pending) gate.resolve(fail); await indexing;}
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

test('fatal cloud errors abort peers and preserve completed checkpoints', async () => {
  for (const status of [401, 429]) {
    const pending = [];
    const {e, saved} = runtime(128, async (_, options) => {
      const gate = deferred(); pending.push({gate, signal: options.signal});
      return await Promise.race([gate.promise, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true}))]);
    });
    const indexing = e.index();
    try {
      await waitFor(() => pending.length === 4);
      pending[0].gate.resolve(ok(32)); await waitFor(() => saved.length === 32);
      pending[1].gate.resolve({status, ok: false}); await indexing;
      assert.equal(pending[2].signal.aborted, true); assert.equal(pending[3].signal.aborted, true);
      assert.equal(saved.length, 32); assert.equal(e.ready, false);
      assert.equal(e.status.phase, '오류'); assert.match(e.status.error, new RegExp(String(status)));
    } finally {e.stop(); for (const item of pending) item.gate.resolve(ok(32)); await indexing;}
  }
});

test('oversized individual image is skipped and remaining images continue', async () => {
  const sizes = []; let index = 0;
  const {e, setImageLoader} = runtime(2, async (_, options) => {sizes.push(Buffer.byteLength(options.body)); return ok(1);});
  setImageLoader(async () => ({type: 'image/png', id: index++ === 0 ? 'A'.repeat(6000001) : 'AA'}));
  await e.index();
  assert.equal(e.status.completed, 2); assert.equal(e.status.errors, 1);
  assert.equal(sizes.length, 1); assert.ok(sizes[0] <= 6000000);
});

test('batch payload size limits split large images before the item cap', async () => {
  const batches = [], data = 'A'.repeat(2_050_000);
  const {e, setImageLoader} = runtime(4, async (_, {body}) => {
    const size = Buffer.byteLength(body), count = JSON.parse(body).messages.length;
    batches.push({size, count}); return ok(count);
  });
  setImageLoader(async () => ({type: 'image/png', id: data}));
  await e.index();
  assert.deepEqual(batches.map(batch => batch.count), [2, 2]);
  assert.ok(batches.every(batch => batch.size <= CLOUDFLARE_BODY_LIMIT));
  assert.equal(e.status.phase, '준비 완료');
});

test('overlapping worker completions serialize delayed checkpoint writes', async () => {
  const {e} = runtime(128, async (_, options) => ok(JSON.parse(options.body).messages.length));
  let active = 0, peak = 0; const saved = [];
  e.files = () => ({readFile: async () => {throw Error('missing');}, mkdir: async () => {},
    writeFile: async (path, text) => {peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 1)); saved.push(JSON.parse(text).key); active--;},
    rename: async () => {}});
  await e.index();
  assert.equal(peak, 1); assert.equal(saved.length, 128); assert.equal(new Set(saved).size, 128);
  assert.equal(e.dirtyVectors, 0);
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
