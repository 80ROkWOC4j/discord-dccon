const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({attachFiles, uploadFails = false, postFails = false, missing = false, cleanupFails = false, noAcknowledgement = false, postRejects = false, htmlResponse = false, functionDecoy = false, onUpload, splitImage, mergeImage, cacheDirectory, fetchFails = false, callbackFs = false, cacheWriteFails = false, downloadBytes = [1, 2, 3]} = {}) {
  const calls = {staged: 0, posts: [], closes: 0, errors: [], uploads: [], fetches: 0};
  const data = {sendMode: "image", draft: '작성 중인 글', attachments: ['existing'], reply: 'reply-id'};
  class Upload extends EventEmitter {
    constructor(item, channelId) { super(); this.filename = item.file.name; calls.uploads.push({item, channelId, instance: this}); }
    trackUploadFinished() {}
    upload() {
      onUpload?.();
      if (uploadFails) this.emit('error', new Error('test'));
      else { this.uploadedFilename = 'uploaded/test.png'; this.emit('complete'); }
    }
    cancel() {}
    off(...args) {
      if (cleanupFails) throw new Error('different emitter API');
      return super.off(...args);
    }
  }
  const rest = {
    get() {}, put() {}, del() {},
    async post(args) {
      calls.posts.push(args);
      if (htmlResponse) return {status: 200, body: '<!doctype html><html>private content</html>', headers: {'content-type': 'text/html'}};
      if (postRejects) throw {status: 403, body: {code: 50013}, message: 'Missing Permissions'};
      return {status: postFails ? 403 : 200, ok: !postFails, body: noAcknowledgement ? {} : {id: 'message-test'}};
    },
  };
  const drafts = new Map();
  const getDraft = channel => { if (!drafts.has(channel)) drafts.set(channel, [{id: 'manual', item: {file: new File(['manual'], 'manual.txt')}}]); return drafts.get(channel); };
  const staging = {
    addFiles: ({channelId, files}) => { calls.staged++; getDraft(channelId).push(...files.map(item => ({id: 'queued-' + calls.staged, item}))); },
    removeFiles: (channel, ids) => drafts.set(channel, getDraft(channel).filter(item => !ids.includes(item.id))),
  };
  const modules = missing ? [staging] : [Upload, rest, staging];
  if (functionDecoy) modules.unshift(Object.assign(function WrongRest() {}, {
    get() {}, put() {}, del() {}, post() { throw new Error('wrong REST module'); },
  }));
  // Match BetterDiscord: callbacks wrap synchronous filesystem operations; no promises export.
  const polyfillFs = Object.fromEntries(['readFile', 'mkdir', 'writeFile', 'rename', 'unlink'].map(method => [method,
    (...args) => {
      const callback = args.pop();
      try {
        if (cacheWriteFails && method === 'writeFile') throw Object.assign(new Error('private/path'), {code: 'EACCES'});
        if (method === 'readFile' && args[1] === undefined) args[1] = 'utf-8';
        callback(null, fs[method + 'Sync'](...args));
      } catch (error) { callback(error, null); }
    },
  ]));
  const pluginRequire = name => name === 'fs' && callbackFs ? polyfillFs : require(name);
  const context = {require: pluginRequire, URL, module: {exports: {}}, Blob, File, structuredClone, setTimeout, clearTimeout, BdApi: {
    Composer: attachFiles ? {attachFiles} : undefined,
    Plugins: {folder: cacheDirectory, cacheFolder: cacheDirectory && path.join(cacheDirectory, "cache")}, React: {Component: class {}},
    Data: {load: (_, key) => data[key], save: (_, key, value) => { data[key] = value; }},
    Webpack: {getStore: () => ({getUploads: getDraft}), getModule: filter => modules.find(filter), getByKeys: () => ({}),
      Filters: {byKeys: (...keys) => value => keys.every(key => key in value)}},
    Net: {fetch: async () => { calls.fetches++; if (fetchFails) throw new Error('offline'); return {arrayBuffer: async () => new Uint8Array(downloadBytes).buffer}; }},
    UI: {showToast: text => calls.errors.push(text)}, Logger: {error() {}},
  }};
  require('./helpers/core.cjs').loadCore(context);
  context.module.exports.WebPCache.convert = async bytes => bytes;
  if (splitImage) context.module.exports.setSplitForTest(splitImage);
  if (mergeImage) context.module.exports.setMergeForTest(mergeImage);
  const api = context.module.exports;
  api.setChannel('test-channel');
  api.events.subscribe('DCCON_CLOSE', () => calls.closes++);
  return {api, calls, data, drafts, staging};
}
const con = {idx: '1', path: 'image', ext: 'png', title: 'test'};

test('buffer additions preserve recent order until a successful send', async () => {
  const {api, data} = harness();
  const other = {...con, idx: '2', path: 'other'};
  data.recent = [other, con];
  let updates = 0;
  api.events.subscribe('DCCON_RECENT_UPDATE', () => updates++);
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.deepEqual(data.recent, [other, con]);
  assert.equal(updates, 0);
  await api.sendDCConMessage(null);
  assert.deepEqual(Array.from(data.recent, item => item.path), ['image', 'other']);
  assert.equal(updates, 1);
});

test('instant send posts only selected file and leaves draft, existing attachments and reply untouched', async () => {
  const {api, calls, data} = harness();
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(calls.staged, 0);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].url, '/channels/test-channel/messages');
  const body = calls.posts[0].body;
  assert.equal(body.content, '');
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].uploaded_filename, 'uploaded/test.png');
  assert.equal(Object.hasOwn(body, 'message_reference'), false);
  assert.equal(Object.hasOwn(body, 'flags'), false);
  assert.equal(data.draft, '작성 중인 글');
  assert.deepEqual(data.attachments, ['existing']);
  assert.equal(data.reply, 'reply-id');
  assert.equal(calls.closes, 1);
  assert.equal(calls.uploads[0].instance.listenerCount('complete'), 0);
});

test('Shift accumulates only private buffer; normal click sends one batch without touching native attachments', async () => {
  const {api, calls, drafts} = harness();
  await api.sendDCConMessage(con, {keepOpen: true});
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(calls.closes, 0);
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.staged, 0);
  assert.equal(api.activeQueue('test-channel').length, 2);
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].body.attachments.length, 3);
  assert.equal(new Set(calls.posts[0].body.attachments.map(item => item.id)).size, 3);
  assert.equal(drafts.size, 0);
  assert.equal(api.activeQueue('test-channel').length, 0);
  assert.equal(calls.closes, 1);
  await api.sendDCConMessage(con);
  assert.notEqual(calls.posts[0].body.nonce, calls.posts[1].body.nonce);
});

test('split send posts nine tiles in order and records only the original con', async () => {
  const files = Array.from({length: 9}, (_, i) => new File([String(i)], 'tile-' + i + '.webp'));
  const {api, calls, data} = harness({splitImage: async (file, checkActive) => {checkActive(); return files;}});
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(null, {splitNine: true}), true);
  assert.deepEqual(calls.uploads.map(upload => upload.item.file), files);
  assert.equal(calls.posts[0].body.attachments.length, 9);
  assert.equal(api.activeQueue('test-channel').length, 0);
  assert.deepEqual(Array.from(data.recent, item => item.path), [con.path]);
});

test('split requires exactly one queued image, including pending additions', async () => {
  let splits = 0;
  const {api, calls} = harness({splitImage: async () => {splits++; return [];}});
  assert.equal(await api.sendDCConMessage(null, {splitNine: true}), false);
  await api.sendDCConMessage(con, {keepOpen: true});
  const adding = api.sendDCConMessage(con, {keepOpen: true});
  const sending = api.sendDCConMessage(null, {splitNine: true});
  await adding;
  assert.equal(await sending, false);
  assert.equal(splits, 0);
  assert.equal(calls.posts.length, 0);
  assert.equal(api.activeQueue('test-channel').length, 2);
});

test('split preparation locks the buffer and failure preserves its original image', async () => {
  let rejectSplit;
  const {api, calls} = harness({splitImage: () => new Promise((_, reject) => {rejectSplit = reject;})});
  await api.sendDCConMessage(con, {keepOpen: true});
  const sending = api.sendDCConMessage(null, {splitNine: true});
  await new Promise(resolve => setImmediate(resolve));
  api.removeBuffered('test-channel');
  assert.equal(await api.sendDCConMessage(null, {splitNine: true}), false);
  rejectSplit(new Error('conversion failed'));
  assert.equal(await sending, false);
  assert.equal(calls.posts.length, 0);
  assert.equal(api.activeQueue('test-channel').length, 1);
  assert.equal(calls.closes, 0);
});

test('merged send uploads one file and records all original cons in selection order', async () => {
  const merged = new File(['merged'], 'dccon.webp', {type: 'image/webp'});
  let inputs;
  const {api, calls, data} = harness({mergeImage: async (files, checkActive) => {checkActive(); inputs = files; return merged;}});
  const second = {...con, path: 'second'}, third = {...con, path: 'third'};
  for (const item of [con, second, third]) await api.sendDCConMessage(item, {keepOpen: true});
  const queued = Array.from(api.activeQueue('test-channel'), entry => entry.file);
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), true);
  assert.deepEqual(Array.from(inputs), queued);
  assert.equal(calls.posts[0].body.attachments.length, 1);
  assert.equal(calls.uploads[0].item.file, merged);
  assert.equal(api.activeQueue('test-channel').length, 0);
  assert.deepEqual(Array.from(data.recent, item => item.path), ['third', 'second', 'image']);
});

test('merged send rejects invalid counts, ordinary clicks and conflicting modes before merging', async () => {
  let merges = 0;
  const {api, calls} = harness({mergeImage: async () => {merges++; return new File(['merged'], 'merged.webp');}});
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), false);
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), false);
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(con, {mergeImages: true}), false);
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true, splitNine: true}), false);
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true, keepOpen: true}), false);
  for (let i = 0; i < 2; i++) await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), false);
  assert.equal(merges, 0);
  assert.equal(calls.posts.length, 0);
  assert.equal(api.activeQueue('test-channel').length, 4);
});

test('merge failure keeps the buffer and locks removal and duplicate sends during preparation', async () => {
  let fail;
  const {api, calls} = harness({mergeImage: () => new Promise((_, reject) => {fail = reject;})});
  for (let i = 0; i < 2; i++) await api.sendDCConMessage(con, {keepOpen: true});
  const sending = api.sendDCConMessage(null, {mergeImages: true});
  await new Promise(resolve => setImmediate(resolve));
  api.removeBuffered('test-channel');
  assert.equal(api.activeQueue('test-channel').length, 2);
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), false);
  fail(Error('애니메이션 재생 길이가 같아야 합니다.'));
  assert.equal(await sending, false);
  assert.equal(api.activeQueue('test-channel').length, 2);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.closes, 0);
});

test('buffer-only send preserves order and duplicates without fetching or appending another image', async () => {
  const {api, calls, data} = harness();
  const second = {...con, path: 'second', title: 'second'};
  for (const item of [con, second, con]) await api.sendDCConMessage(item, {keepOpen: true});
  const files = Array.from(api.activeQueue('test-channel'), entry => entry.file);
  const fetches = calls.fetches;
  assert.equal(await api.sendDCConMessage(null), true);
  assert.deepEqual(calls.uploads.map(upload => upload.item.file), files);
  assert.equal(calls.fetches, fetches);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].body.attachments.length, 3);
  assert.equal(api.activeQueue('test-channel').length, 0);
  assert.deepEqual(Array.from(data.recent, item => item.path), ['image', 'second']);
});

test('buffer-only send uses the preview channel and waits for pending additions', async () => {
  const {api, calls} = harness();
  const adding = api.sendDCConMessage(con, {keepOpen: true});
  api.setChannel('other');
  const sending = api.sendDCConMessage(null, {channelId: 'test-channel'});
  assert.equal(await adding, true);
  assert.equal(await sending, true);
  assert.equal(calls.posts[0].url, '/channels/test-channel/messages');
  assert.equal(calls.posts[0].body.attachments.length, 1);
  assert.equal(await api.sendDCConMessage(null), false);
  assert.equal(calls.posts.length, 1);
});

test('failed buffer-only send preserves the preview and rejects duplicate send clicks', async () => {
  const {api, calls} = harness({postFails: true});
  await api.sendDCConMessage(con, {keepOpen: true});
  const sending = api.sendDCConMessage(null);
  assert.equal(await api.sendDCConMessage(null), false);
  assert.equal(await sending, false);
  assert.equal(calls.posts.length, 1);
  assert.equal(api.activeQueue('test-channel').length, 1);
  assert.equal(calls.closes, 0);
});

for (const failure of ['uploadFails', 'postFails', 'missing']) {
  test(`${failure}: no close, no recent update, no staging fallback or automatic resend`, async () => {
    const {api, calls, data} = harness({[failure]: true});
    assert.equal(await api.sendDCConMessage(con), false);
    assert.equal(calls.closes, 0);
    assert.equal(data.recent, undefined);
    assert.equal(calls.staged, 0);
    assert.equal(calls.posts.length, failure === 'postFails' ? 1 : 0);
    assert.equal(calls.errors.length, 1);
  });
}


test('diagnostic identifies rejected message request and records API status/code without draft content', async () => {
  const {api} = harness({postRejects: true});
  assert.equal(await api.sendDCConMessage(con), false);
  const report = api.inspectInstantSend().lastSendAttempt;
  assert.equal(report.phase, '메시지 생성 요청');
  assert.equal(report.outcome, '실패');
  assert.equal(report.error.status, 403);
  assert.equal(report.error.code, 50013);
  assert.equal(JSON.stringify(report).includes('작성 중인 글'), false);
  assert.equal(JSON.stringify(report).includes('test-channel'), false);
});

test('cleanup API failure cannot swallow upload completion or block message request', async () => {
  const {api, calls} = harness({cleanupFails: true});
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(calls.posts.length, 1);
  assert.equal(api.inspectInstantSend().lastSendAttempt.cleanupError.message, 'different emitter API');
});

test('missing server message acknowledgement is not reported as success or retried', async () => {
  const {api, calls, data} = harness({noAcknowledgement: true});
  assert.equal(await api.sendDCConMessage(con), false);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.closes, 0);
  assert.equal(data.recent, undefined);
  assert.equal(api.inspectInstantSend().lastSendAttempt.hasMessageId, false);
});

test('upload failure diagnostics retain the original error', async () => {
  const {api} = harness({uploadFails: true});
  await api.sendDCConMessage(con);
  const report = api.inspectInstantSend().lastSendAttempt;
  assert.equal(report.phase, 'Discord 파일 업로드');
  assert.equal(report.uploadError.message, 'test');
});

test('REST discovery excludes function exports with coincidentally matching method names', async () => {
  const {api, calls} = harness({functionDecoy: true});
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(calls.posts.length, 1);
});

test('HTTP 200 HTML remains a failure and diagnostic records shape without content', async () => {
  const {api, calls} = harness({htmlResponse: true});
  assert.equal(await api.sendDCConMessage(con), false);
  const report = api.inspectInstantSend().lastSendAttempt;
  assert.equal(report.responseShape.looksLikeHtml, true);
  assert.equal(report.responseShape.contentType, 'text/html');
  assert.equal(report.responseShape.bodyType, 'string');
  // Function source in this mock has a literal fixture; check the response summary itself.
  assert.equal(JSON.stringify(report.responseShape).includes('private content'), false);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.closes, 0);
});

test('deleted attachments are excluded and channel queues stay separate', async () => {
  const {api, calls, staging} = harness();
  await api.sendDCConMessage(con, {keepOpen: true});
  api.removeBuffered('test-channel', api.activeQueue('test-channel')[0]);
  await api.sendDCConMessage(con);
  assert.equal(calls.posts[0].body.attachments.length, 1);
  await api.sendDCConMessage(con, {keepOpen: true});
  api.setChannel('other');
  await api.sendDCConMessage(con);
  assert.equal(calls.posts[1].body.attachments.length, 1);
  api.setChannel('test-channel');
  await api.sendDCConMessage(con);
  assert.equal(calls.posts[2].body.attachments.length, 2);
});

test('failed batch retains attachments with no retry', async () => {
  const {api, calls, drafts} = harness({postFails: true});
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(con), false);
  assert.equal(api.activeQueue('test-channel').length, 1);
  assert.equal(drafts.size, 0);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.closes, 0);
});

test('rapid Shift and ordinary clicks execute in order and enforce the batch limit', async () => {
  const {api, calls} = harness();
  const results = await Promise.all(Array.from({length: 10}, () => api.sendDCConMessage(con, {keepOpen: true})));
  assert.equal(results.filter(Boolean).length, 9);
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(calls.posts[0].body.attachments.length, 10);
});

test('buffer cannot be removed while sending and duplicate sends are rejected', async () => {
  let remove = () => {};
  const {api, calls} = harness({onUpload: () => remove()});
  await api.sendDCConMessage(con, {keepOpen: true});
  remove = () => api.removeBuffered('test-channel');
  const sending = api.sendDCConMessage(con);
  assert.equal(await api.sendDCConMessage(con), false);
  assert.equal(await sending, true);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].body.attachments.length, 2);
});

test('rapid Shift then normal click captures the channel and sends accumulated files', async () => {
  const {api, calls} = harness();
  const staged = api.sendDCConMessage(con, {keepOpen: true});
  const sent = api.sendDCConMessage(con);
  api.setChannel('other');
  assert.equal(await staged, true);
  assert.equal(await sent, true);
  assert.equal(calls.posts[0].url, '/channels/test-channel/messages');
  assert.equal(calls.posts[0].body.attachments.length, 2);
});

test('disk cache survives plugin reload, coalesces requests, and works offline', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-cache-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const first = harness({cacheDirectory: directory});
  const images = await Promise.all([first.api.getDCConImage(con), first.api.getDCConImage(con)]);
  assert.equal(first.calls.fetches, 1);
  assert.equal(images[0].size, 3);
  await first.api.getDCConImage(con);
  assert.equal(first.calls.fetches, 1);
  const second = harness({cacheDirectory: directory, fetchFails: true});
  assert.equal((await second.api.getDCConImage(con)).size, 3);
  assert.equal(second.calls.fetches, 0);
});

test('download failure creates no cached file and buffer is unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-cache-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const {api} = harness({cacheDirectory: directory, fetchFails: true});
  assert.equal(await api.sendDCConMessage(con, {keepOpen: true}), false);
  assert.equal(api.activeQueue('test-channel').length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'cache/images')), false);
});

test('new downloads are cached as WebP, and cache reads need no codec or download', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-webp-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const cache = path.join(directory, 'cache/images'); fs.mkdirSync(cache, {recursive: true});
  const file = path.join(cache, require('node:crypto').createHash('sha256').update('image:png').digest('hex'));
  const original = Buffer.from([1, 2, 3]);
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const first = harness({cacheDirectory: directory});
  let conversions = 0;
  first.api.WebPCache.convert = async bytes => {conversions++; assert.deepEqual(Buffer.from(bytes), original); return webp;};
  const images = await Promise.all([first.api.getDCConImage(con), first.api.getDCConImage(con)]);
  assert.equal(conversions, 1);
  assert.equal(images[0].name, 'dccon.gif'); assert.equal(images[0].type, 'image/webp');
  assert.deepEqual(fs.readFileSync(file), webp);
  const second = harness({cacheDirectory: directory, fetchFails: true});
  second.api.WebPCache.convert = () => assert.fail('cached WebP must not re-encode');
  assert.equal(await second.api.sendDCConMessage(con), true);
  assert.equal(second.calls.fetches, 0);
  assert.equal(second.calls.uploads[0].item.file.type, 'image/webp');
});

test('conversion failure does not send or cache original bytes', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-webp-fail-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const cache = path.join(directory, 'cache/images'); fs.mkdirSync(cache, {recursive: true});
  const file = path.join(cache, require('node:crypto').createHash('sha256').update('image:png').digest('hex'));
  const {api, calls} = harness({cacheDirectory: directory});
  api.WebPCache.convert = async () => {throw Error('conversion failed');};
  assert.equal(await api.sendDCConMessage(con), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(calls.uploads.length, 0); assert.equal(calls.fetches, 1);
});

test('empty cache file is fetched again; unsafe image identifiers stay within cache directory', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-cache-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const {api, calls} = harness({cacheDirectory: directory});
  const unsafe = {...con, path: '../../outside'};
  await api.getDCConImage(unsafe);
  const cache = path.join(directory, 'cache/images');
  const name = fs.readdirSync(cache)[0];
  assert.match(name, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(cache, name), '');
  await api.getDCConImage(unsafe);
  assert.equal(calls.fetches, 2);
});

test('BetterDiscord callback-only fs caches bytes across reload and works offline', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-polyfill-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const first = harness({cacheDirectory: directory, callbackFs: true});
  await first.api.sendDCConMessage(con);
  assert.equal(first.calls.fetches, 1);
  const next = harness({cacheDirectory: directory, callbackFs: true, fetchFails: true});
  assert.equal(await next.api.sendDCConMessage(con), true);
  assert.equal(next.calls.fetches, 0);
  assert.deepEqual([...new Uint8Array(await next.calls.uploads[0].item.file.arrayBuffer())], [1, 2, 3]);
});

test('cache write errors do not prevent sending', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-polyfill-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const {api} = harness({cacheDirectory: directory, callbackFs: true, cacheWriteFails: true});
  assert.equal(await api.sendDCConMessage(con), true);
  assert.equal(api.inspectInstantSend().lastSendAttempt.outcome, '전송 성공 확인');
});

test('BetterDiscord UTF-8 default cannot corrupt binary image bytes after cache reload', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dccon-binary-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 254];
  const first = harness({cacheDirectory: directory, callbackFs: true, downloadBytes: bytes});
  await first.api.getDCConImage(con);
  const cached = fs.readFileSync(path.join(directory, 'cache/images', fs.readdirSync(path.join(directory, 'cache/images'))[0]));
  assert.deepEqual([...cached], bytes);
  const second = harness({cacheDirectory: directory, callbackFs: true, fetchFails: true});
  assert.equal(await second.api.sendDCConMessage(con), true);
  const uploaded = second.calls.uploads[0].item.file;
  assert.equal(uploaded.size, bytes.length);
  assert.deepEqual([...new Uint8Array(await uploaded.arrayBuffer())], bytes);
  assert.equal(second.calls.fetches, 0);
});

for (const previous of [{}, {sendMode: 'link'}, {sendMode: 'attach'}, {attachOnly: true}, {sendMode: 'image'}]) {
  test(`image sending replaces previous settings ${JSON.stringify(previous)}`, async () => {
    const {api, calls, data} = harness();
    delete data.sendMode;
    Object.assign(data, previous);
    assert.equal(await api.sendDCConMessage(con), true);
    assert.equal(calls.posts[0].body.content, '');
    assert.equal(calls.posts[0].body.attachments.length, 1);
    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.staged, 0);
    await api.sendDCConMessage(con, {keepOpen: true});
    assert.equal(calls.posts.length, 1);
    assert.equal(api.activeQueue('test-channel').length, 1);
    await api.sendDCConMessage({...con, path: 'second'});
    assert.equal(calls.posts[1].body.attachments.length, 2);
    assert.equal(api.activeQueue('test-channel').length, 0);
    assert.equal(data.draft, '작성 중인 글');
  });
}

test('clearing the private buffer keeps subsequent sends image-only', async () => {
  const {api, calls} = harness();
  await api.sendDCConMessage(con, {keepOpen: true});
  api.removeBuffered('test-channel');
  await api.sendDCConMessage(con);
  assert.equal(calls.posts[0].body.attachments.length, 1);
  assert.equal(calls.posts[0].body.content, '');
});


test('attachment host uses the shared queue without uploading or posting messages', async () => {
  const attached = [];
  const {api, calls} = harness({attachFiles: (files, channelId) => attached.push({files, channelId})});
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage({...con, path: 'second'}), true);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].files.length, 2);
  assert.equal(attached[0].channelId, 'test-channel');
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.posts.length, 0);
  assert.equal(api.activeQueue('test-channel').length, 0);
});

test('attachment failure preserves the queue and never falls back to direct sending', async () => {
  const {api, calls} = harness({attachFiles: () => {throw Error('Channel changed');}});
  await api.sendDCConMessage(con, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(null), false);
  assert.equal(api.activeQueue('test-channel').length, 1);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.posts.length, 0);
});

test('merged images use the attachment host instead of direct sending', async () => {
  const attached = [];
  const {api, calls} = harness({
    attachFiles: files => attached.push(files),
    mergeImage: async () => new File(['merged'], 'merged.webp', {type: 'image/webp'}),
  });
  await api.sendDCConMessage(con, {keepOpen: true});
  await api.sendDCConMessage({...con, path: 'second'}, {keepOpen: true});
  assert.equal(await api.sendDCConMessage(null, {mergeImages: true}), true);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].length, 1);
  assert.equal(attached[0][0].name, 'merged.webp');
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.posts.length, 0);
});
