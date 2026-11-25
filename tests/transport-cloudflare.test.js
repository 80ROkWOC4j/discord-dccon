const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {IDBFactory} = require('fake-indexeddb');
const {allowedDownload, download} = require('../shelter/native');
const {createUserscriptNative} = require('../userscript/native');

const api = 'https://api.cloudflare.com/client/v4/test';
const auth = {Authorization: 'Bearer test-only'};

test('shelter allows exact Cloudflare API host only', () => {
  assert.equal(allowedDownload(api), api);
  for (const url of ['https://sub.api.cloudflare.com/', 'https://api.cloudflare.com.evil.test/', 'http://api.cloudflare.com/', 'https://user@api.cloudflare.com/'])
    assert.throws(() => allowedDownload(url), /Unsupported/);
});

test('shelter stops credential redirects even without manual, and aborts', async () => {
  const request = new EventEmitter();
  let followed = 0, aborted = 0, body, opts;
  Object.assign(request, {setHeader() {}, end(value) {body = value;}, abort() {aborted++;}, followRedirect() {followed++;}});
  const net = {request(value) {opts = value; return request;}};
  const promise = download(net, api, {method: 'POST', headers: auth, body: '{}'});
  request.emit('redirect', 307, 'POST', api + '/next', {location: ['/next']});
  assert.equal((await promise).status, 307);
  assert.equal(opts.redirect, 'manual'); assert.equal(body, '{}'); assert.equal(followed, 0); assert.equal(aborted, 1);
  const controller = new AbortController();
  const pending = download(net, api, {redirect: 'manual'}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/i);
});

test('userscript scopes authorization to Cloudflare across managers (including Violentmonkey)', async () => {
  let details, aborted = 0;
  const native = createUserscriptNative(value => {details = value; return {abort() {aborted++;}};}, {indexedDB: new IDBFactory()});
  const pending = native.fetch('a', api, {method: 'POST', headers: auth, body: '{}', redirect: 'manual'});
  assert.equal(details.headers.Authorization, auth.Authorization);
  assert.equal(details.redirect, 'manual'); assert.equal(details.method, 'POST'); assert.equal(details.data, '{}');
  details.onload({status: 307, responseHeaders: 'Location: /next', response: new ArrayBuffer(0), finalUrl: api});
  assert.equal((await pending).status, 307);
  const other = native.fetch('b', 'https://api.github.com/', {headers: auth});
  assert.equal(details.headers.Authorization, undefined); assert.equal(details.redirect, undefined);
  native.abort('b'); await assert.rejects(other, {name: 'AbortError'}); assert.equal(aborted, 1);
  for (const url of ['https://sub.api.cloudflare.com/', 'https://api.cloudflare.com.evil.test/', 'https://api.cloudflare.com:444/'])
    await assert.rejects(native.fetch('x', url, {headers: auth}), /Unsupported/);
  native.dispose();
});

test('userscript rejects credentialed Cloudflare responses redirected to another host', async () => {
  let details;
  const native = createUserscriptNative(value => {details = value; return {abort() {}};}, {indexedDB: new IDBFactory()});
  const pending = native.fetch('r', api, {method: 'POST', headers: auth, body: '{}'});
  details.onload({status: 200, responseHeaders: '', response: new ArrayBuffer(0), finalUrl: 'https://dcinside.com/'});
  await assert.rejects(pending, /Unsupported redirect host/);
  native.dispose();
});
