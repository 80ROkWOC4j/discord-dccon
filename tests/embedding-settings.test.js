const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {IDBFactory} = require('fake-indexeddb');
const {createConfig} = require('../src/storage/indexeddb.ts');
const {createConfigStore} = require('../src/storage/node.ts');
const {loadCore} = require('./helpers/core.cjs');

const key = 'embeddingCloudflareCredentials';
const credentials = {accountId: 'a'.repeat(32), apiToken: 'dummy-token-never-log'};
const legacy = {embeddingEnabled: true, embeddingProvider: 'cloudflare'};

function runtime(config, fetch, globals = {}) {
  const logs = [], toasts = [];
  return {...loadCore({module: {exports: {}}, structuredClone, AbortController, URL, require,
    clearTimeout() {}, setTimeout() {return 1;}, ...globals,
    BdApi: {Config: config, Logger: {error: (...args) => logs.push(args)}, UI: {showToast: (...args) => toasts.push(args)}, Net: {fetch},
      React: {createElement: (type, props, ...children) => ({type, props: props || {}, children}),
        Component: class {setState(changes) {Object.assign(this.state, changes);}}},
      Data: {load: () => undefined}, Webpack: {getByKeys: () => ({}), getModule: () => ({})}}}), logs, toasts};
}

const storedCredentials = snapshot => snapshot.settings[key];
for (const format of ['desktop config.json', 'userscript IndexedDB']) {
  test(`${format}: disabling or switching to local deletes stored credentials in the same save`, async t => {
    let adapter, read;
    if (format === 'desktop config.json') {
      const root = await fs.mkdtemp(path.resolve(__dirname, '../.cf-storage-test-'));
      t.after(() => fs.rm(root, {recursive: true, force: true}));
      const store = createConfigStore({root, vectorSpec: 'q4-image280-video6x140-v3'});
      adapter = {open: () => store.open(legacy), save: (...args) => store.save(...args)};
      read = async () => JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    } else {
      const db = createConfig(new IDBFactory()); t.after(() => db.dispose());
      adapter = {open: () => db.config('open', [legacy]), save: (...args) => db.config('save', args)};
      read = adapter.open;
    }
    const calls = [], applied = [];
    const h = runtime({open: adapter.open, async save(...args) {
      calls.push(args[0]);
      const result = await adapter.save(...args);
      applied.push(result);
      return result;
    }});
    const e = h.Embedding;
    await h.SharedConfig.open();
    await e.saveCloudflareCredentials({accountId: ' ' + credentials.accountId + ' ', apiToken: credentials.apiToken});
    assert.deepEqual(storedCredentials(await read()), credentials);
    e.toggle(false);
    assert.equal(h.loadData(key), undefined);
    await h.saveData('favorites', []);
    assert.deepEqual(calls.slice(-2), ['embeddingEnabled', 'favorites']);
    assert.equal(Object.hasOwn(applied.at(-2).settings, key), false);
    assert.equal(Object.hasOwn((await read()).settings, key), false);
    await adapter.save(key, credentials, undefined); // Another tab with stale UI must not restore them.
    assert.equal(Object.hasOwn((await read()).settings, key), false);
    e.toggle(true);
    await e.saveCloudflareCredentials(credentials);
    assert.deepEqual(storedCredentials(await read()), credentials);
    e.setProvider('local');
    assert.equal(h.loadData(key), undefined);
    await h.saveData('favorites', []);
    assert.deepEqual(calls.slice(-2), ['embeddingProvider', 'favorites']);
    assert.equal(Object.hasOwn(applied.at(-2).settings, key), false);
    assert.equal(Object.hasOwn((await read()).settings, key), false);
    e.setProvider('cloudflare');
    assert.equal(e.status.phase, 'API 키 설정 필요');
    await h.saveData('favorites', []);
    e.stop();
  });
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => find(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...find(tree.children, predicate)];
}
const textOf = node => typeof node === 'string' ? node : node?.children ? node.children.map(textOf).join(' ') : '';
const usageBlock = ui => find(ui.render(), node => node.props?.className === 'dccon-embedding-usage')[0];
const settle = () => new Promise(setImmediate);
const okResponse = {status: 200, ok: true, text: async () => JSON.stringify({success: true,
  result: {data: [{index: 0, embedding: [1, ...Array(767).fill(0)]}]}})};

test('embedding settings expose BYOK controls, mask the token, and keep keys out of diagnostics', {timeout: 3000}, async () => {
  const indexed = createConfig(new IDBFactory());
  const requests = [];
  let analyticsStarted;
  const h = runtime({open: () => indexed.config('open', [{}]), save: (...args) => indexed.config('save', args)},
    async (url, options) => {
      requests.push({url, options});
      if (String(url).includes('/graphql')) {
        analyticsStarted?.();
        return {status: 200, ok: true, text: async () => JSON.stringify({data: null, errors: [
          {message: credentials.apiToken, extensions: {code: 'authz'}},
        ]})};
      }
      return okResponse;
    });
  try {
    await h.SharedConfig.open();
    const ui = new h.EmbeddingEnvironmentPanel({}); ui.componentDidMount();
    const control = (type, props = {}) => find(ui.render(), node => node.type === type && Object.entries(props).every(([key, value]) => node.props[key] === value))[0];
    assert.equal(control('select').props.value, 'local');
    assert.deepEqual(find(ui.render(), node => node.type === 'option').map(textOf), ['로컬 (WebGPU)', 'Cloudflare Workers AI (BYOK)']);
    assert.equal(control('input'), undefined);
    control('select').props.onChange({currentTarget: {value: 'cloudflare'}});
    assert.equal(control('input', {type: 'password'}).props.disabled, true);
    control('button', {role: 'switch'}).props.onClick();
    assert.equal(control('input', {type: 'password'}).props.disabled, false);
    assert.match(textOf(ui.render()), /API 키 설정 필요/);
    assert.equal(control('progress'), undefined);
    await assert.rejects(h.Embedding.search('고양이'), /설정에서 Cloudflare API 키/);
    await ui.apply('test');
    assert.match(textOf(ui.render()), /32자리/);
    assert.equal(requests.length, 0);
    control('input', {type: 'text'}).props.onChange({currentTarget: {value: credentials.accountId + '/evil'}});
    control('input', {type: 'password'}).props.onChange({currentTarget: {value: credentials.apiToken}});
    await ui.apply('test');
    assert.equal(requests.length, 0);
    control('input', {type: 'text'}).props.onChange({currentTarget: {value: credentials.accountId}});
    await ui.apply('test');
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].options.body), {input: ['task: search result | query: 연결 테스트']});
    assert.match(textOf(ui.render()), /연결했습니다/);
    const afterSave = new Promise(resolve => {analyticsStarted = resolve;});
    await ui.apply('save');
    await afterSave; await settle();
    assert.equal(usageBlock(ui), undefined);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.logs.length, 0);
    assert.match(textOf(ui.render()), /저장했습니다/);
    assert.equal(control('input', {type: 'password'}).props.value, '');
    assert.equal(control('input', {type: 'text'}).props.value, '');
    assert.equal(control('button', {className: 'dccon-button'}).props.disabled, true);
    assert.equal(control('button', {className: 'dccon-embedding-test'}).props.disabled, false);
    assert.equal(h.Embedding.hasCloudflareCredentials(), true);
    const diagnostics = JSON.stringify(h.inspectInstantSend());
    assert.ok(!diagnostics.includes(credentials.accountId) && !diagnostics.includes(credentials.apiToken));
    const afterTest = new Promise(resolve => {analyticsStarted = resolve;});
    await ui.apply('test');
    await afterTest; await settle();
    assert.equal(usageBlock(ui), undefined);
    control('input', {type: 'password'}).props.onChange({currentTarget: {value: 'unsaved'}});
    control('button', {role: 'switch'}).props.onClick();
    assert.equal(control('input', {type: 'password'}).props.value, '');
    assert.equal(h.loadData(key), undefined);
    await h.saveData('favorites', []);
    ui.componentWillUnmount();
  } finally {h.Embedding.stop(); indexed.dispose();}
});

test('usage is silent until success, refreshes on demand and ready transitions, and rejects stale results', async () => {
  const h = runtime({open: async () => ({settings: {...legacy, [key]: credentials}})});
  await h.SharedConfig.open();
  const e = h.Embedding;
  let revision = 1;
  const requests = [];
  e.getCloudflareUsageRevision = () => revision;
  e.getCloudflareUsage = signal => new Promise(resolve => requests.push({signal, resolve}));
  const ui = new h.EmbeddingEnvironmentPanel({});
  const usage = () => usageBlock(ui);
  ui.componentDidMount();
  assert.equal(requests.length, 1);
  assert.equal(usage(), undefined);
  e.status.phase = '준비 완료'; ui.refresh(); ui.refresh();
  assert.equal(requests.length, 2);
  assert.ok(requests[0].signal.aborted, 'index completion supersedes a pending mount fetch');
  requests[0].resolve(null);
  requests[1].resolve({neurons: 12345, requests: 42}); await settle();
  assert.match(textOf(usage()), /오늘 무료 사용량 \(UTC\)/);
  const position = ui.render().children.map(child => child?.props?.className);
  assert.deepEqual(position.slice(2, 5), ['dccon-embedding-field dccon-embedding-provider', 'dccon-embedding-usage', 'dccon-embedding-credentials']);
  assert.match(textOf(usage()), /12,345 \/ 10,000 Neurons/);
  assert.equal(find(usage(), node => node.type === 'progress')[0].props.value, 10000);
  find(usage(), node => node.type === 'button')[0].props.onClick();
  assert.equal(requests.length, 3);
  requests[2].resolve(null); await settle();
  assert.equal(usage(), undefined, 'a failed refresh hides previously visible usage');
  e.status.phase = '이미지 색인'; ui.refresh();
  e.status.phase = '완료 · 일부 실패'; ui.refresh();
  assert.equal(requests.length, 4);
  revision++; ui.refresh();
  assert.ok(requests[3].signal.aborted);
  assert.equal(usage(), undefined);
  assert.equal(requests.length, 5);
  requests[3].resolve({neurons: 1, requests: 1}); await settle();
  assert.equal(usage(), undefined);
  requests[4].resolve({neurons: 10, requests: 2}); await settle();
  assert.ok(usage());
  find(usage(), node => node.type === 'button')[0].props.onClick();
  ui.componentWillUnmount();
  assert.ok(requests[5].signal.aborted);
  requests[5].resolve({neurons: 20, requests: 3}); await settle();
  assert.match(textOf(usage()), /10 \/ 10,000/);
  e.stop();
});

for (const change of ['disable', 'local']) {
  test(`usage is immediately cleared and pending requests aborted on ${change}`, {timeout: 3000}, async t => {
    const db = createConfig(new IDBFactory());
    const h = runtime({open: () => db.config('open', [{...legacy, [key]: credentials}]),
      read: () => db.config('read', []), save: (...args) => db.config('save', args)});
    const e = h.Embedding, ui = new h.EmbeddingEnvironmentPanel({});
    t.after(() => {ui.componentWillUnmount(); h.services.disconnect(); e.stop(); db.dispose();});
    await h.SharedConfig.open();
    let pending;
    e.getCloudflareUsage = async signal => {
      if (!pending) return {neurons: 85.7, requests: 105};
      return new Promise(resolve => {pending = {signal, resolve};});
    };
    ui.componentDidMount(); await settle();
    assert.match(textOf(usageBlock(ui)), /85\.7/);
    pending = {};
    find(usageBlock(ui), node => node.type === 'button')[0].props.onClick();
    if (change === 'disable') e.toggle(false);
    else e.setProvider('local');
    assert.ok(pending.signal.aborted);
    assert.equal(usageBlock(ui), undefined);
    assert.equal(ui.state.usage, null);
    pending.resolve({neurons: 800, requests: 200});
    await h.saveData('favorites', []); await settle();
    assert.equal(usageBlock(ui), undefined);
  });
}

test('credential save failures cannot quote backend error details in logs or the settings UI', async () => {
  const h = runtime({open: async () => ({settings: legacy}), save: async () => {throw Error(JSON.stringify(credentials));}});
  await h.SharedConfig.open();
  const e = h.Embedding;
  await assert.rejects(e.saveCloudflareCredentials(credentials), /저장하지 못했습니다/);
  const messages = JSON.stringify([h.logs, h.toasts, e.status]);
  assert.ok(!messages.includes(credentials.accountId) && !messages.includes(credentials.apiToken));
  assert.equal(h.loadData(key), undefined);
});

test('cancelSearch aborts the Cloudflare request without clearing the index', async () => {
  let started, signal;
  const pending = new Promise(resolve => {started = resolve;});
  const h = runtime({open: async () => ({settings: {...legacy, [key]: credentials}})}, async (_, options) => {
    signal = options.signal; started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  await h.SharedConfig.open();
  const e = h.Embedding; e.ready = true; e.vectors = {test: [1]};
  const rejection = assert.rejects(e.search('취소할 검색어'), /취소/);
  await pending; e.cancelSearch(); await rejection;
  assert.ok(signal.aborted); assert.ok(e.ready); assert.ok(e.vectors.test);
});

async function sharedInstances(t, net, globals) {
  const factory = new IDBFactory();
  const make = fetch => {
    const db = createConfig(factory);
    const h = runtime({open: () => db.config('open', [{...legacy, [key]: credentials,
      dccons: [{info: {package_idx: 1}, detail: [{path: 'img', ext: 'png'}]}]}]),
      read: () => db.config('read', []), save: (...args) => db.config('save', args)}, fetch, globals);
    t.after(() => {h.services.disconnect(); h.Embedding.stop(); db.dispose();});
    return h;
  };
  const a = make(async () => assert.fail('Instance A should not send a request'));
  const b = make(net);
  await a.SharedConfig.open(); await b.SharedConfig.open();
  return [a, b];
}

for (const change of ['disable', 'local', 'rotate']) {
  test(`IndexedDB instances abort active indexing and search after remote ${change}`, {timeout: 3000}, async t => {
    let started, aborted;
    const sent = [], notifications = [], openChannels = new Set();
    const allStarted = new Promise(resolve => {started = resolve;});
    const allAborted = new Promise(resolve => {aborted = resolve;});
    class Channel {
      constructor(name) {this.name = name; openChannels.add(this);}
      postMessage(data) {
        notifications.push(data);
        for (const peer of openChannels) if (peer !== this && peer.name === this.name)
          queueMicrotask(() => openChannels.has(peer) && peer.onmessage?.({data}));
      }
      close() {openChannels.delete(this);}
    }
    const [a, b] = await sharedInstances(t, async (_, {signal, body}) => {
      sent.push({signal, body: JSON.parse(body)});
      if (sent.length === 2) started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        if (sent.length === 2 && sent.every(request => request.signal.aborted)) aborted();
        reject(signal.reason);
      }, {once: true}));
    }, {
      BroadcastChannel: Channel,
      document: {createElement: () => ({getContext: () => ({fillRect() {}, drawImage() {}}), toDataURL: () => 'data:image/jpeg;base64,AA'})},
      createImageBitmap: async () => ({width: 10, height: 10, close() {}}),
    });
    const e = b.Embedding;
    b.setImageLoader(async () => ({type: 'image/png'}));
    e.files = () => ({readFile: async () => {throw Error('missing');}});
    e.ready = true;
    const indexing = e.index();
    const search = assert.rejects(e.search('이전 쿼리'), /취소/);
    await allStarted;
    assert.equal(sent.filter(request => request.body.messages).length, 1);
    assert.equal(sent.filter(request => request.body.input).length, 1);
    const rotated = {...credentials, apiToken: 'rotated-dummy-token'};
    if (change === 'disable') a.Embedding.toggle(false);
    else if (change === 'local') a.Embedding.setProvider('local');
    else await a.Embedding.saveCloudflareCredentials(rotated);
    await allAborted;
    await Promise.all([indexing, search]);
    assert.equal(e.ready, false);
    assert.equal(e.enabled(), change !== 'disable');
    assert.equal(e.provider(), change === 'local' ? 'local' : 'cloudflare');
    assert.deepEqual(b.loadData(key), change === 'rotate' ? rotated : undefined);
    await assert.rejects(e.search('다음 쿼리'));
    await e.index();
    assert.equal(sent.length, 2);
    assert.deepEqual(notifications, ['embedding-settings-changed']);
    a.services.disconnect(); b.services.disconnect();
    assert.equal(openChannels.size, 0);
  });
}

for (const change of ['disable', 'local']) {
  test(`fresh IndexedDB reads prevent stale sends before the remote ${change} notification arrives`, {timeout: 3000}, async t => {
    // Simulate isolated profiles or an asynchronous notification that hasn't arrived.
    let calls = 0;
    const [a, b] = await sharedInstances(t, async () => {calls++; return okResponse;});
    b.Embedding.ready = true;
    await b.Embedding.search('cached');
    assert.equal(calls, 1);
    if (change === 'disable') a.Embedding.toggle(false);
    else a.Embedding.setProvider('local');
    await a.saveData('favorites', []); // Ensure the shared write has committed.
    // Cover both a cache hit and a would-be Cloudflare request before notification.
    await assert.rejects(b.Embedding.search(change === 'disable' ? 'cached' : 'new query'));
    assert.equal(calls, 1);
    assert.equal(b.Embedding.ready, false);
    assert.equal(b.loadData(key), undefined);
    await assert.rejects(b.Embedding.testCloudflareCredentials(credentials));
    assert.equal(calls, 1);
  });
}

test('optional analytics checks committed settings before using a stale instance token', {timeout: 3000}, async t => {
  let calls = 0;
  const [a, b] = await sharedInstances(t, async () => {calls++; return okResponse;});
  assert.ok(b.Embedding.hasCloudflareCredentials());
  a.Embedding.toggle(false);
  await a.saveData('favorites', []);
  assert.equal(await b.Embedding.getCloudflareUsage(), null);
  assert.equal(calls, 0);
  assert.equal(b.Embedding.hasCloudflareCredentials(), false);
});

test('polling observes shared settings without BroadcastChannel and stops on disconnect', {timeout: 3000}, async t => {
  const timers = new Set();
  let started, aborted;
  const active = new Promise(resolve => {started = resolve;});
  const cancelled = new Promise(resolve => {aborted = resolve;});
  const [a, b] = await sharedInstances(t, async (_, {signal}) => {
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted(); reject(signal.reason);
    }, {once: true}));
  }, {
    setInterval(callback) {timers.add(callback); return callback;},
    clearInterval(callback) {timers.delete(callback);},
  });
  b.Embedding.ready = true;
  const search = assert.rejects(b.Embedding.search('이전 쿼리'), /취소/);
  await active;
  a.Embedding.toggle(false);
  await a.saveData('favorites', []);
  assert.equal(timers.size, 2);
  const pollB = [...timers][1];
  pollB();
  await cancelled; await search;
  assert.equal(b.Embedding.enabled(), false);
  a.services.disconnect(); b.services.disconnect();
  assert.equal(timers.size, 0);
});

test('empty credential save is a no-op and cannot revert a remotely rotated token', async t => {
  const [a, b] = await sharedInstances(t, async () => okResponse);
  const rotated = {...credentials, apiToken: 'rotated-token-in-a'};
  await a.Embedding.saveCloudflareCredentials(rotated);
  await b.Embedding.saveCloudflareCredentials({accountId: '', apiToken: ''});
  await b.SharedConfig.open();
  assert.deepEqual(b.loadData(key), rotated);
});
