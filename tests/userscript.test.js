const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IDBFactory} = require('fake-indexeddb');
const {createUserscriptNative} = require('../userscript/native');
const {createBrowserFiles} = require('../userscript/browser-files');
const vm = require('node:vm');

test('userscript native preserves hashing, clipboard and binary cache support', async () => {
  const native = createUserscriptNative(() => {throw Error('Unexpected download');}, {
    indexedDB: new IDBFactory(), navigator: {clipboard: {readText: async () => 'clipboard text'}},
  });
  assert.equal(native.hash(['a', new Uint8Array([98, 99])], 'hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await native.readClipboardText(), 'clipboard text');
  await native.file('writeFile', ['/dccon/cache/test', new Uint8Array([0, 255])]);
  assert.deepEqual(await native.file('readFile', ['/dccon/cache/test']), new Uint8Array([0, 255]));
  native.dispose();
  await assert.rejects(native.file('readFile', ['/dccon/cache/test']), /closed/);
});

test('userscript downloads directly with GM, without cookies or a proxy', async () => {
  let options;
  const native = createUserscriptNative(value => {options = value; return {abort() {}};}, {indexedDB: new IDBFactory()});
  const request = native.fetch('one', 'https://dccon.dcinside.com/index/package_detail', {
    method: 'POST', body: 'package_idx=41982', headers: {'X-Requested-With':'XMLHttpRequest', Cookie:'discard', Authorization:'discard'},
  });
  assert.equal(options.url, 'https://dccon.dcinside.com/index/package_detail');
  assert.equal(options.anonymous, true);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
  options.onload({status:200, responseHeaders:'Content-Type: application/json\r\n', response:new Uint8Array([0, 255]).buffer, finalUrl:options.url});
  assert.deepEqual((await request).bytes, new Uint8Array([0,255]));
  await assert.rejects(native.fetch('two', 'https://discord.com/api/v9/users/@me'), /Unsupported/);
  native.dispose();
});

test('userscript unload aborts and rejects an outstanding GM request', async () => {
  let aborted = 0;
  const native = createUserscriptNative(() => ({abort() {aborted++;}}), {indexedDB: new IDBFactory()});
  const pending = native.fetch('one', 'https://cdn.jsdelivr.net/test');
  native.dispose();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(aborted, 1);
  await assert.rejects(native.fetch('two', 'https://cdn.jsdelivr.net/test'), /stopped/);
});

test('Firefox GM cookie continuation lines cannot become invalid response header names', async () => {
  let options;
  const native = createUserscriptNative(value => {options=value;return {abort(){}};}, {indexedDB:new IDBFactory()});
  const pending = native.fetch('search', 'https://dccon.dcinside.com/hot/1/title/cat');
  options.onload({status:200, finalUrl:options.url, response:new ArrayBuffer(0), responseHeaders:
    'Content-Type: text/html; charset=UTF-8\r\nSet-Cookie: example=ignored\r\nexample=ignored; expires=Thu, 15 Oct 2026 16:00:00 GMT\r\nContent-Length: 123\r\n'});
  const response = await pending;
  const headers = new Headers(response.headers);
  assert.equal(headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(headers.get('content-length'), '123');
  assert.equal(headers.get('set-cookie'), null);
  assert.equal([...headers].length, 2);
  native.dispose();
});

test('remote thumbnails render without a React hook dispatcher and release stale requests and URLs', async () => {
  const source = require('./helpers/core.cjs').coreSource();
  const pending = [], revoked = [];
  const context = {module:{exports:{}}, AbortController,
    URL:{createObjectURL: value => 'blob:' + value, revokeObjectURL: value => revoked.push(value)},
    platform:{react:{
      Component:class {constructor(props){this.props=props;}setState(value){Object.assign(this.state,value);}},
      createElement:(type,props)=>({type,props}),
      useState(){throw Error('No dispatcher');}, useEffect(){throw Error('No dispatcher');},
    },net:{resolveImage:(src,signal)=>new Promise(resolve=>pending.push({src,signal,resolve}))}},
  };
  vm.runInNewContext(source.slice(source.indexOf('class DCConImage'), source.indexOf('const ManduIcon')) + '\nmodule.exports=DCConImage;', context);
  const Image = context.module.exports, image = new Image({src:'first',loading:'lazy'});
  image.componentDidMount();
  pending[0].resolve('first'); await Promise.resolve();
  assert.equal(image.render().props.src, 'blob:first');
  assert.equal(image.render().props.loading, 'eager');
  image.props = {src:'second'}; image.componentDidUpdate({src:'first'});
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(revoked, ['blob:first']);
  image.componentWillUnmount();
  pending[1].resolve('second'); await Promise.resolve();
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(image.state.source, undefined);
});

test('userscript thumbnails use direct DC bytes and reject unexpected final hosts', async () => {
  const calls=[];
  const native=createUserscriptNative(options=>{calls.push(options);queueMicrotask(()=>options.onload({status:200,responseHeaders:'Content-Type: image/gif',response:new Uint8Array([71,73,70]).buffer,finalUrl:options.url}));return {abort(){}};},{indexedDB:new IDBFactory()});
  const blob=await native.resolveImage('https://dccon-proxy.minibox.workers.dev/?no=abc123');
  assert.equal(calls[0].url,'https://dcimg5.dcinside.com/dccon.php?no=abc123');
  assert.equal(blob.type,'image/gif');
  native.dispose();
  const redirect=createUserscriptNative(options=>{queueMicrotask(()=>options.onload({status:200,responseHeaders:'',response:new ArrayBuffer(0),finalUrl:'https://example.com/'}));return {abort(){}};},{indexedDB:new IDBFactory()});
  await assert.rejects(redirect.fetch('one','https://dcimg5.dcinside.com/dccon.php?no=abc123'),/Unsupported/);
  redirect.dispose();
});

test('browser file cache preserves binary and UTF-8 data across reopening, with atomic rename', async () => {
  const indexedDB = new IDBFactory(), files = createBrowserFiles(indexedDB);
  const temp = '/dccon/discord-dccon-cache/a.tmp', target = '/dccon/discord-dccon-cache/a';
  await assert.rejects(files.file('readFile', [target, null]), {code: 'ENOENT'});
  await files.file('mkdir', ['/dccon/discord-dccon-cache', {recursive: true}]);
  await files.file('writeFile', [temp, new Uint8Array([0, 255, 137, 80])]);
  await files.file('rename', [temp, target]);
  await assert.rejects(files.file('readFile', [temp, null]), {code: 'ENOENT'});
  await files.file('writeFile', [target + '.json', '{"name":"고양이"}']);
  files.dispose();
  const reopened = createBrowserFiles(indexedDB);
  assert.deepEqual(await reopened.file('readFile', [target, null]), new Uint8Array([0, 255, 137, 80]));
  assert.equal(await reopened.file('readFile', [target + '.json', 'utf8']), '{"name":"고양이"}');
  await assert.rejects(reopened.file('rename', [temp, target]), {code: 'ENOENT'});
  assert.deepEqual(await reopened.file('readFile', [target, null]), new Uint8Array([0, 255, 137, 80]));
  await reopened.file('unlink', [target]);
  await assert.rejects(reopened.file('readFile', [target, null]), {code: 'ENOENT'});
  await assert.rejects(reopened.file('readFile', ['/dccon/../outside', null]), /Invalid/);
  reopened.dispose();
});
