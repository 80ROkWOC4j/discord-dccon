const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function runtime(initial = {}, fetch = undefined, globals = {}) {
  const data = {...initial};
  const context = {module: {exports: {}}, structuredClone, setTimeout, clearTimeout, URL, AbortController, ArrayBuffer, ...globals,
    BdApi: {Logger: {error() {}}, Net: {fetch}, Data: {load: (_, key) => data[key], save: (_, key, value) => {data[key] = value;}},
      React: {Component: class {constructor(props) {this.props = props;} setState(value) {Object.assign(this.state, value);}}},
      Webpack: {getByKeys: () => ({}), getModule: () => ({}), Filters: {byKeys: () => () => true}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../discord-dccon.plugin.js'), 'utf8') +
    '\nmodule.exports = {Embedding, DCConPanel, readEmbeddingVectors, setImageLoader: loader => {getDCConImage = loader;}};', context);
  return {...context.module.exports, data};
}

test('vector search ranks by cosine, deduplicates packs, and excludes removed images', async () => {
  const {Embedding: e} = runtime({dccons: [
    {info: {package_idx: 1}, detail: [{path: 'a', ext: 'png'}, {path: 'b', ext: 'png'}]},
    {info: {package_idx: 2}, detail: [{path: 'a', ext: 'png'}]},
  ]});
  e.ready = true; e.vectors = {'a:png': [0, 1], 'b:png': [1, 0], 'removed:png': [1, 0]};
  e.call = async () => [1, 0];
  const results = await e.search('무관한 파일명');
  assert.deepEqual(Array.from(results, item => item.con.path), ['b', 'a']);
});

test('turning embedding off terminates Worker and rejects pending operations', async () => {
  const {Embedding: e, data} = runtime({embeddingEnabled: true});
  let terminated = false;
  e.worker = {postMessage() {}, terminate() {terminated = true;}};
  const request = e.call('query');
  const rejected = assert.rejects(request, /중단/);
  e.toggle(false);
  await rejected;
  assert.equal(terminated, true);
  assert.equal(data.embeddingEnabled, false);
  assert.equal(e.pending.size, 0);
  assert.equal(e.ready, false);
});

test('unready semantic search reports preparation instead of using title search', async () => {
  const {Embedding: e} = runtime();
  await assert.rejects(e.search('고양이'), /모델 준비/);
});

test('search clearing and unmount discard an older asynchronous semantic result', async () => {
  const {Embedding: e, DCConPanel} = runtime({embeddingEnabled: true});
  let resolve;
  e.search = () => new Promise(done => {resolve = done;});
  const panel = new DCConPanel({type: 'dccon'});
  panel.componentDidMount();
  panel.changeSearch('고양이');
  await new Promise(done => setTimeout(done, 380));
  panel.clearSearch();
  resolve([{con: {path: 'old'}}]);
  await new Promise(done => setImmediate(done));
  assert.equal(panel.state.semanticResults.length, 0);
  assert.equal(panel.state.searching, false);
  panel.componentWillUnmount();
});

test('pack changes during indexing schedule a follow-up pass', async () => {
  const {Embedding: e} = runtime();
  e.ready = true; e.indexing = true;
  await e.index();
  assert.equal(e.reindex, true);
});

for (const action of ['clear', 'unmount', 'replace']) {
  test(`search ${action} cancels queued inference before it reaches the worker`, async () => {
    let timer, finish;
    const {Embedding: e, DCConPanel} = runtime({embeddingEnabled: true}, undefined, {
      setTimeout: callback => {timer = callback; return 1;}, clearTimeout: () => {timer = null;},
    });
    const calls = [];
    e.ready = true;
    e.call = async (_, args) => {
      calls.push(args.text);
      if (args.text === 'first') await new Promise(resolve => {finish = resolve;});
      return [1, 0];
    };
    const first = assert.rejects(e.search('first'), /취소/);
    await new Promise(resolve => setImmediate(resolve));
    const panel = new DCConPanel({type: 'dccon'});
    panel.componentDidMount();
    panel.changeSearch('obsolete');
    const pending = timer();
    if (action === 'clear') panel.clearSearch();
    else if (action === 'unmount') panel.componentWillUnmount();
    else panel.changeSearch('latest');
    finish();
    await Promise.all([first, pending]);
    assert.deepEqual(calls, ['first']);
    assert.equal(panel.state.searchError, '');
    if (action === 'replace') {
      await timer();
      assert.deepEqual(calls, ['first', 'latest']);
      assert.equal(panel.state.searching, false);
    }
    if (action !== 'unmount') panel.componentWillUnmount();
  });
}

test('model download resolves relative redirects without BetterDiscord automatic handling', async () => {
  const requests = [];
  const response = {status: 200};
  const {Embedding: e} = runtime({}, async (url, options) => {
    assert.equal(options.redirect, 'manual');
    requests.push(url);
    return requests.length === 1 ? {status: 307, headers: {get: () => '/api/cache/model?etag=abc'}} :
      requests.length === 2 ? {status: 302, headers: {get: () => 'https://cdn.example/model?signature=xyz'}} : response;
  });
  assert.equal(await e.download('https://huggingface.co/model/resolve/rev/config.json', 0), response);
  assert.deepEqual(requests, ['https://huggingface.co/model/resolve/rev/config.json',
    'https://huggingface.co/api/cache/model?etag=abc', 'https://cdn.example/model?signature=xyz']);
});

test('model download stops redirect loops and cancelled requests', async () => {
  let count = 0;
  const {Embedding: e} = runtime({}, async () => {count++; return {status: 307, headers: {get: () => '/loop'}};});
  await assert.rejects(e.download('https://example.com/model', 0), /횟수/);
  assert.equal(count, 9);
  e.generation++;
  await assert.rejects(e.download('https://example.com/model', 0), /중단/);
  assert.equal(count, 9);
});

test('model asset requests coalesce and clear failed requests for retry', async () => {
  const {Embedding: e} = runtime();let finish,count=0;
  e.readAsset=()=>{count++;return new Promise(resolve=>{finish=resolve;});};
  const one=e.asset('model',0),two=e.asset('model',0);assert.equal(count,1);
  finish(new ArrayBuffer(4));assert.equal(await one,await two);assert.equal(e.assetRequests.size,0);
  e.readAsset=async()=>{throw Error('network');};
  await assert.rejects(e.asset('model',0),/network/);assert.equal(e.assetRequests.size,0);
});

test('stopping embedding aborts in-flight download and releases vectors', async () => {
  let signal;const {Embedding: e}=runtime({},async(_,options)=>{signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));});
  e.vectors={'test:png':[1]};const request=e.download('https://example.com/model',0);
  const rejected=assert.rejects(request,/aborted/);e.stop();await rejected;
  assert.equal(signal.aborted,true);assert.equal(e.downloads.size,0);assert.equal(Object.keys(e.vectors).length,0);
});

test('latest semantic query replaces waiting queries without extra model inference', async () => {
  const {Embedding: e}=runtime();e.ready=true;const calls=[];let finish;
  e.call=async(_,args)=>{calls.push(args.text);if(args.text==='first')await new Promise(resolve=>{finish=resolve;});return [1,0];};
  const one=e.search('first');const firstRejected=assert.rejects(one,/취소/);
  await new Promise(resolve=>setImmediate(resolve));
  const two=e.search('obsolete');const secondRejected=assert.rejects(two,/취소/);
  const three=e.search('latest');finish();await Promise.all([firstRejected,secondRejected,three]);
  assert.deepEqual(calls,['first','latest']);
});

test('worker RPC transfers buffers and cleans up synchronous post failure', async () => {
  const {Embedding: e}=runtime();let sent;
  const bytes=new ArrayBuffer(16);e.worker={postMessage:(message,transfer)=>{sent={message,transfer};}};
  const task=e.call('image',{bytes});assert.equal(sent.transfer[0],bytes);
  e.pending.get(sent.message.id).resolve('ok');e.pending.delete(sent.message.id);assert.equal(await task,'ok');
  e.worker={postMessage:()=>{throw Error('clone failed');}};
  await assert.rejects(e.call('image',{bytes}),/clone failed/);assert.equal(e.pending.size,0);
});

test('legacy cache keeps static vectors, rebuilds GIFs, and rejects damaged vectors', () => {
  const {readEmbeddingVectors: read}=runtime();const vector=Array(768).fill(0);vector[0]=1;
  const saved={spec:'q8-560-gif3-browser-v1',vectors:{'ok:png':vector,'old:gif':vector,'zero:png':Array(768).fill(0),'short:png':[1]}};
  assert.deepEqual(Object.keys(read(saved)),['ok:png']);saved.spec='q8-image560-video6x280-v2';assert.deepEqual(Object.keys(read(saved)),['ok:png','old:gif']);
});

test('cached index does not rewrite unchanged vector file', async () => {
  const {Embedding: e}=runtime({dccons:[{info:{package_idx:1},detail:[{path:'a',ext:'png'}]}]},undefined,{require});
  let writes=0;e.ready=true;e.vectors={'a:png':[1]};e.directory=()=>'/test';e.vectorDirectory=()=>'/test';e.files=()=>({mkdir:async()=>{},writeFile:async()=>{writes++;},rename:async()=>{}});
  await e.index();assert.equal(writes,0);assert.equal(e.status.phase,'준비 완료');
});

for (const failure of ['write', 'rename']) {
  test(`index retries unsaved vectors after ${failure} failure without repeating inference`, async () => {
    const {Embedding: e, setImageLoader} = runtime({dccons: [{info: {package_idx: 1},
      detail: [{path: 'a', ext: 'png'}]}]}, undefined, {require});
    let failing = true, calls = 0, writes = 0, temporary, saved;
    e.ready = true;
    e.directory = () => '/test'; e.vectorDirectory = () => '/test';
    e.files = () => ({
      mkdir: async () => {},
      writeFile: async (_, text) => {
        writes++;
        if (failing && failure === 'write') throw Error('disk unavailable');
        temporary = JSON.parse(text);
      },
      rename: async () => {
        if (failing && failure === 'rename') throw Error('file locked');
        saved = temporary;
      },
    });
    setImageLoader(async () => ({arrayBuffer: async () => new ArrayBuffer(1)}));
    e.call = async () => {calls++; return [1];};
    await e.index();
    assert.equal(e.status.phase, '오류');
    assert.equal(saved, undefined);
    assert.equal(e.dirtyVectors, 1);
    failing = false;
    await e.index();
    assert.deepEqual(saved.vector, [1]);
    assert.equal(e.status.phase, '준비 완료');
    assert.equal(e.dirtyVectors, 0);
    assert.equal(calls, 1);
    const successfulWrites = writes;
    await e.index();
    assert.equal(writes, successfulWrites);
  });
}

test('old checkpoint completion cannot clear a restarted index dirty state', async () => {
  const {Embedding: e, setImageLoader} = runtime({dccons: [{info: {package_idx: 1},
    detail: [{path: 'a', ext: 'png'}]}]}, undefined, {require});
  let finish;
  e.ready = true;
  e.directory = () => '/test'; e.vectorDirectory = () => '/test';
  e.files = () => ({mkdir: async () => {}, writeFile: async () => {}, rename: () => new Promise(resolve => {finish = resolve;})});
  setImageLoader(async () => ({arrayBuffer: async () => new ArrayBuffer(1)}));
  e.call = async () => [1];
  const indexing = e.index();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  e.stop();
  assert.equal(e.dirtyVectors, 0);
  e.dirtyVectors = 2;
  e.update({phase: '준비 중'});
  finish();
  await indexing;
  assert.equal(e.dirtyVectors, 2);
  assert.equal(e.status.phase, '준비 중');
});

test('index cancelled during file read cannot enqueue into a restarted worker', async () => {
  const {Embedding: e, setImageLoader} = runtime({dccons: [{info: {package_idx: 1}, detail: [{path: 'a', ext: 'png'}]}]});
  let finish, calls = 0;
  e.ready = true;
  setImageLoader(async () => ({arrayBuffer: () => new Promise(resolve => {finish = resolve;})}));
  e.call = async () => {calls++; return [1];};
  const indexing = e.index();
  await new Promise(resolve => setImmediate(resolve));
  e.stop(); e.ready = true;
  finish(new ArrayBuffer(1));
  await indexing;
  assert.equal(calls, 0);
  assert.equal(Object.keys(e.vectors).length, 0);
});

test('index saves completed work before stopping after three errors', async () => {
  const {Embedding: e,setImageLoader}=runtime({dccons:[{info:{package_idx:1},detail:['a','b','c','d'].map(path=>({path,ext:'jpg'}))}]},undefined,{require});
  let calls=0,saved,type;e.ready=true;e.directory=()=>'/test';e.vectorDirectory=()=>'/test';e.files=()=>({mkdir:async()=>{},writeFile:async(_,text)=>{saved=JSON.parse(text);},rename:async()=>{}});
  setImageLoader(async()=>({type:'image/webp',arrayBuffer:async()=>new ArrayBuffer(1)}));
  e.call=async(_,args)=>{type=args.type;if(calls++>0)throw Error('decode failed');return [1];};
  await e.index();assert.equal(type,'image/webp');assert.equal(e.status.phase,'오류');assert.ok(saved.vector);assert.equal(e.indexing,false);
});

test('an old index error cannot overwrite restarted status after checkpoint completes', async () => {
  const {Embedding: e, setImageLoader} = runtime({dccons: [{info: {package_idx: 1},
    detail: ['a', 'b', 'c', 'd'].map(path => ({path, ext: 'png'}))}]}, undefined, {require});
  let finish, calls = 0, renames = 0;
  e.ready = true;
  e.directory = () => '/test'; e.vectorDirectory = () => '/test';
  e.files = () => ({mkdir: async () => {}, writeFile: () => new Promise(resolve => {finish = resolve;}), rename: async () => {renames++;}});
  setImageLoader(async () => ({arrayBuffer: async () => new ArrayBuffer(1)}));
  e.call = async () => {if (calls++) throw Error('old failure'); return [1];};
  const indexing = e.index();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  e.stop();
  e.update({phase: '준비 중', error: ''});
  e.indexing = true;
  finish();
  await indexing;
  assert.equal(e.status.phase, '준비 중');
  assert.equal(e.status.error, '');
  assert.equal(e.indexing, true);
  assert.equal(renames, 0);
});

function scheduledRuntime() {
  const timers = new Map();
  let sequence = 0;
  const instance = runtime({}, undefined, {
    navigator: {gpu: {}},
    setTimeout(callback, delay) {assert.equal(delay, 500); timers.set(++sequence, callback); return sequence;},
    clearTimeout(id) {timers.delete(id);},
  });
  return {...instance, timers, async fire() {
    const callbacks = [...timers.values()]; timers.clear();
    callbacks.forEach(callback => callback());
    await new Promise(resolve => setImmediate(resolve));
  }};
}

test('rapid embedding toggles start once for the final enabled state and off cancels immediately', async () => {
  const {Embedding: e, timers, fire} = scheduledRuntime();
  let starts = 0;
  e.runStart = async () => {starts++;};
  for (let i = 0; i < 30; i++) {e.toggle(true); e.toggle(false);}
  assert.equal(timers.size, 0);
  await fire(); assert.equal(starts, 0);
  e.toggle(true); e.toggle(true);
  assert.equal(timers.size, 1);
  await fire(); assert.equal(starts, 1);
  e.stop();
});

test('retry bursts coalesce and cannot start after embedding is disabled', async () => {
  const {Embedding: e, timers, fire, data} = scheduledRuntime();
  data.embeddingEnabled = true;
  e.status.phase = '오류';
  let starts = 0;
  e.runStart = async () => {starts++;};
  for (let i = 0; i < 30; i++) e.start();
  assert.equal(timers.size, 1);
  await fire(); assert.equal(starts, 1);
  e.start(); e.toggle(false); e.start();
  await fire(); assert.equal(starts, 1);
  assert.equal(timers.size, 0);
});

test('retries cannot restart active initialization and old cleanup cannot unlock a new startup', async () => {
  const {Embedding: e, timers, fire} = scheduledRuntime();
  const pending = [];
  e.directory = () => '/test'; e.vectorDirectory = () => '/test';
  e.files = () => ({mkdir: () => new Promise(resolve => pending.push(resolve)), readFile: async () => {throw Error('missing');}});
  e.toggle(true); await fire();
  assert.equal(e.starting, true);
  const generation = e.generation;
  for (let i = 0; i < 30; i++) e.start();
  assert.equal(timers.size, 0);
  assert.equal(e.generation, generation);
  e.toggle(false); e.toggle(true); await fire();
  assert.equal(pending.length, 2);
  pending[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.starting, true);
  e.toggle(false); pending[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.starting, false);
});

test('failed startup releases its lock for a later retry; indexing ignores retries', async () => {
  const {Embedding: e, timers, fire} = scheduledRuntime();
  let attempts = 0;
  e.directory = () => '/test'; e.vectorDirectory = () => '/test';
  e.files = () => ({mkdir: async () => {attempts++; throw Error('disk unavailable');}});
  e.toggle(true); await fire();
  assert.equal(e.status.phase, '오류');
  assert.equal(e.starting, false);
  e.start(); await fire();
  assert.equal(attempts, 2);
  e.indexing = true;
  e.start(); assert.equal(timers.size, 0);
  e.stop();
});
