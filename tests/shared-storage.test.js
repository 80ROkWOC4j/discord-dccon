const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {createConfigStore} = require('../scripts/shared-storage.cjs');
const spec = 'q8-image560-video6x280-v2';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const con = name => ({path: name, ext: 'png', title: name});
async function fixture(t) {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'dccon-config-'));
  t.after(() => fs.rm(appData, {recursive: true, force: true}));
  return {root: path.join(appData, 'discord-dccon'), vectorSpec: spec};
}
async function write(file, value) {await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, value);}
async function state(root) {try {return JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));} catch (e) {if (e.code === 'ENOENT') return null; throw e;}}
async function missing(file) {await assert.rejects(fs.access(file), {code: 'ENOENT'});}

test('missing configuration imports legacy JSON and IndexedDB, merging lists and preferring current options', async t => {
  const options = await fixture(t), legacy = path.join(path.dirname(options.root), 'BetterDiscord', 'plugins', 'discord-dccon.config.json');
  const old = {embeddingEnabled: true, favorites: [con('bd')], dccons: [{info: {package_idx: 1}, detail: [con('a')]}]};
  await write(legacy, JSON.stringify(old));
  const preferred = {embeddingEnabled: false, favorites: [con('standalone')], dccons: [{info: {package_idx: 2}, detail: [con('b')]}]};
  const result = await createConfigStore(options).open(preferred);
  assert.equal(result.version, 2); assert.equal(result.settings.embeddingEnabled, false);
  assert.deepEqual(result.settings.favorites.map(v => v.path), ['standalone', 'bd']);
  assert.deepEqual(result.settings.dccons.map(v => v.info.package_idx), [2, 1]);
  assert.deepEqual(JSON.parse(await fs.readFile(legacy, 'utf8')), old);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, 'migration-backup', 'settings', hash(legacy) + '.json'), 'utf8')), old);
  await createConfigStore(options).save('favorites', [], result.settings.favorites);
  const reopened = await createConfigStore(options).open(preferred);
  assert.deepEqual(reopened.settings.favorites, []); // Never resurrect old imports on later startup.
});
test('new installation creates default config and sequential versions checkpoint after each step', async t => {
  const options = await fixture(t), calls = [];
  const steps = {2: async () => {calls.push(2); assert.equal((await state(options.root)).version, 1);},
    3: async () => {calls.push(3); assert.equal((await state(options.root)).version, 2);}};
  assert.equal((await createConfigStore(options, steps).open()).version, 3);
  await createConfigStore(options, steps).open(); assert.deepEqual(calls, [2, 3]);
  const fresh = await fixture(t); assert.deepEqual(await createConfigStore(fresh).open(), {version: 2, settings: {}});
});
test('failed later migration resumes only that step; failed checkpoint does not advance', async t => {
  const options = await fixture(t), calls = []; let fail = true;
  const steps = {2: async () => {calls.push(2);}, 3: async () => {calls.push(3); if (fail) throw Error('interrupted');}};
  await assert.rejects(createConfigStore(options, steps).open(), /interrupted/);
  assert.equal((await state(options.root)).version, 2); await missing(path.join(options.root, 'config.lock'));
  fail = false; await createConfigStore(options, steps).open(); assert.deepEqual(calls, [2, 3, 3]);
  const next = await fixture(t); let commits = 0;
  const backend = {...fs, rename: async (a, b) => {if (b === path.join(next.root, 'config.json') && ++commits === 2) throw Error('checkpoint failed'); return fs.rename(a, b);}};
  await assert.rejects(createConfigStore({...next, fs: backend}).open(), /checkpoint failed/);
  assert.equal((await state(next.root)).version, 1);
  await createConfigStore(next).open(); assert.equal((await state(next.root)).version, 2);
});
test('corrupt, future and missing migration versions do not overwrite existing configuration', async t => {
  const options = await fixture(t), file = path.join(options.root, 'config.json');
  await write(file, '{broken'); await assert.rejects(createConfigStore(options).open(), SyntaxError);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await write(file, JSON.stringify({version: 4, settings: {keep: true}}));
  const store = createConfigStore(options);
  await assert.rejects(store.open(), {code: 'CONFIG_VERSION_TOO_NEW'});
  await assert.rejects(store.save('keep', false, true), {code: 'CONFIG_VERSION_TOO_NEW'});
  assert.equal((await state(options.root)).settings.keep, true);
  const next = await fixture(t);
  await assert.rejects(createConfigStore(next, {3: async () => {}}).open(), /Missing configuration migration v2/);
});
test('v2 moves caches, archives differences, converts vectors and absorbs old marker into config', async t => {
  const options = await fixture(t), old = path.join(path.dirname(options.root), 'BetterDiscord', 'plugins', 'discord-dccon-cache');
  const cache = path.join(options.root, 'cache'), a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  await write(path.join(old, a), 'same'); await write(path.join(cache, 'images', a), 'same');
  await write(path.join(old, b), 'old'); await write(path.join(cache, 'images', b), 'new');
  for (const [source, target] of [['webp-codecs','webp-codecs'], ['merged','merged'], ['embedding-gemma2','models']]) {
    await write(path.join(old, source, c), source);
  }
  await write(path.join(old, 'unknown'), 'preserve');
  const vector = Array(768).fill(0); vector[0] = 1;
  const raw = JSON.stringify({spec, vectors: {'a:png': vector}});
  await write(path.join(old, 'embedding-gemma2', 'vectors-v1.json'), raw);
  await write(path.join(cache, 'migration.json'), '{"version":2}');
  await createConfigStore(options).open(); await missing(old); await missing(path.join(cache, 'migration.json'));
  assert.equal(await fs.readFile(path.join(cache, 'images', b), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(cache, 'migration-backup', 'v2', hash(old), b), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(cache, 'migration-backup', 'v2', hash(old), 'unknown'), 'utf8'), 'preserve');
  assert.equal(await fs.readFile(path.join(cache, 'migration-backup', 'v2', hash(old), 'embedding-gemma2', 'vectors-v1.json'), 'utf8'), raw);
  for (const name of ['webp-codecs', 'merged', 'models']) assert.ok((await fs.stat(path.join(cache, name, c))).isFile());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache, 'vectors', spec, hash('a:png') + '.json'), 'utf8')), {spec, key: 'a:png', vector});
  assert.equal(JSON.parse(await fs.readFile(path.join(options.root, 'migration-backup', 'cache-migration.json'), 'utf8')).version, 2);
});
test('personal library is shared, duplicates removed and conflicts preserved', async t => {
  const options = await fixture(t), appData = path.dirname(options.root), a = 'a'.repeat(64), b = 'b'.repeat(64);
  const bd = path.join(appData, 'BetterDiscord', 'plugins', 'discord-dccon-library');
  const canary = path.join(appData, 'discord-dccon-canary', 'discord-dccon-library');
  const target = path.join(options.root, 'discord-dccon-library');
  await write(path.join(target, a), 'stable'); await write(path.join(bd, a), 'stable');
  await write(path.join(canary, a), 'different'); await write(path.join(canary, b), 'unique');
  await createConfigStore(options).open(); await missing(bd); await missing(canary);
  assert.equal(await fs.readFile(path.join(target, a), 'utf8'), 'stable');
  assert.equal(await fs.readFile(path.join(target, b), 'utf8'), 'unique');
  assert.equal(await fs.readFile(path.join(options.root, 'migration-backup', 'library', hash(canary), a + '.' + hash('different')), 'utf8'), 'different');
});
test('interrupted file movement preserves originals and resumes', async t => {
  const options = await fixture(t), old = path.join(options.root, 'discord-dccon-cache'), a = 'a'.repeat(64), b = 'b'.repeat(64);
  await write(path.join(old, a), 'a'); await write(path.join(old, b), 'b');
  const backend = {...fs, rename: async (source, target) => {if (source === path.join(old, b)) throw Error('locked source'); return fs.rename(source, target);}};
  await assert.rejects(createConfigStore({...options, fs: backend}).open(), /locked source/);
  assert.equal((await state(options.root)).version, 1); assert.equal(await fs.readFile(path.join(old, b), 'utf8'), 'b');
  await createConfigStore(options).open(); await missing(old);
});
test('cross-volume copies verify hashes before unlinking sources', async t => {
  for (const corrupt of [false, true]) {
    const options = await fixture(t), old = path.join(options.root, 'discord-dccon-cache'), source = path.join(old, 'a'.repeat(64));
    await write(source, 'original');
    const backend = {...fs, rename: async (a, b) => {if (a === source) throw Object.assign(Error('EXDEV'), {code: 'EXDEV'}); return fs.rename(a, b);}};
    if (corrupt) backend.copyFile = async (_, target) => fs.writeFile(target, 'bad');
    if (corrupt) {await assert.rejects(createConfigStore({...options, fs: backend}).open(), /verification failed/); assert.equal(await fs.readFile(source, 'utf8'), 'original');}
    else {await createConfigStore({...options, fs: backend}).open(); await missing(old);}
  }
});
test('Windows overlay layers are all moved before committing v2', async t => {
  const options = await fixture(t), old = path.join(options.root, 'discord-dccon-cache'), file = path.join(old, 'notes'); let revealed = false;
  await write(file, 'overlay');
  const backend = {...fs, rmdir: async dir => {await fs.rmdir(dir); if (dir === old && !revealed) {revealed = true; await write(file, 'underlying');}}};
  await createConfigStore({...options, fs: backend}).open(); await missing(old);
  const backup = path.join(options.root, 'cache', 'migration-backup', 'v2', hash(old), 'notes');
  assert.equal(await fs.readFile(backup, 'utf8'), 'overlay'); assert.equal(await fs.readFile(backup + '.' + hash('underlying'), 'utf8'), 'underlying');
});
test('BetterDiscord errors without code support first run, missing files and lock contention', async t => {
  const options = await fixture(t), backend = {};
  for (const method of ['mkdir','rmdir','readdir','lstat','stat','realpath','readFile','writeFile','rename','unlink']) backend[method] = async (...args) => {
    try {return await fs[method](...args);} catch (e) {throw Error(e.message);}
  };
  const [a, b] = await Promise.all([createConfigStore({...options, fs: backend}).open(), createConfigStore({...options, fs: backend}).open()]);
  assert.equal(a.version, 2); assert.equal(b.version, 2);
});
test('concurrent starts execute each step once and saves preserve different and same-key updates', async t => {
  const options = await fixture(t), calls = []; let entered, finish;
  const ready = new Promise(resolve => {entered = resolve;});
  const steps = {2: async () => {calls.push(2); entered(); await new Promise(resolve => {finish = resolve;});}};
  const first = createConfigStore(options, steps).open(); await ready;
  const second = createConfigStore(options, steps).open(); finish(); await Promise.all([first, second]); assert.deepEqual(calls, [2]);
  const a = createConfigStore(options), b = createConfigStore(options);
  await Promise.all([a.save('embeddingEnabled', true, undefined), b.save('collapsedPacks', {one: true}, undefined)]);
  await Promise.all([a.save('favorites', [con('a')], []), b.save('favorites', [con('b')], [])]);
  const result = (await a.open()).settings;
  assert.equal(result.embeddingEnabled, true); assert.deepEqual(result.collapsedPacks, {one: true});
  assert.deepEqual(new Set(result.favorites.map(c => c.path)), new Set(['a','b']));
  await a.save('favorites', [con('b')], result.favorites);
  await b.save('favorites', [con('a'), con('b'), con('c')], result.favorites);
  assert.deepEqual((await a.open()).settings.favorites.map(c => c.path), ['b','c']);
});

test('independent Node processes save to one config without losing simultaneous list additions', async t => {
  const options = await fixture(t);
  await createConfigStore(options).open();
  const program = `const {createConfigStore}=require(process.argv[1]);
    const store=createConfigStore({root:process.argv[2],vectorSpec:'${spec}'});
    process.on('message',async()=>{try{
      await store.save('favorites',[{path:process.argv[3],ext:'png'}],[]);
      process.disconnect();
    }catch(error){console.error(error);process.exit(1);}});
    process.send('ready');`;
  const children = ['stable','canary'].map(name => spawn(process.execPath,
    ['-e', program, require.resolve('../scripts/shared-storage.cjs'), options.root, name], {stdio:['ignore','ignore','pipe','ipc']}));
  t.after(() => {for (const child of children) if (child.exitCode === null) child.kill();});
  const completed = children.map(child => new Promise((resolve,reject) => {
    let stderr = ''; child.stderr.on('data', bytes => {stderr += bytes;});
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr || 'child exit '+code)));
  }));
  await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))));
  for (const child of children) child.send('save');
  await Promise.all(completed);
  assert.deepEqual(new Set((await createConfigStore(options).open()).settings.favorites.map(c=>c.path)), new Set(['stable','canary']));
});
test('fresh heartbeat prevents stealing a running lock even when owner metadata is unreadable', async t => {
  const options = await fixture(t), lock = path.join(options.root, 'config.lock');
  await write(path.join(lock, 'owner.json'), ''); await write(path.join(lock, 'heartbeat'), '');
  const old = new Date(Date.now() - 130000); await fs.utimes(lock, old, old);
  const store = createConfigStore({...options, waitMs: 0});
  await assert.rejects(store.open(), /Timed out/); assert.equal(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'), '');
});
test('dead owners are recovered and failed owner writes release the lock', async t => {
  const options = await fixture(t), lock = path.join(options.root, 'config.lock');
  await write(path.join(lock, 'owner.json'), JSON.stringify({pid: 987654321, token: 'f'.repeat(32)}));
  await createConfigStore({...options, ownerAlive: () => false}).open(); await missing(lock);
  const next = await fixture(t), backend = {...fs, writeFile: async (file, ...args) => {if (file.includes('owner.json.tmp-')) throw Error('owner failed'); return fs.writeFile(file, ...args);}};
  await assert.rejects(createConfigStore({...next, fs: backend}).open(), /owner failed/); await missing(path.join(next.root, 'config.lock'));
  await createConfigStore(next).open();
});
test('stat-only filesystem shims cannot move cache or library links outside legacy roots', async t => {
  for (const library of [false, true]) {
    const options = await fixture(t), sourceRoot = path.join(path.dirname(options.root), 'BetterDiscord', 'plugins', library ? 'discord-dccon-library' : 'discord-dccon-cache');
    const source = path.join(sourceRoot, 'a'.repeat(64)); await write(source, 'original');
    const backend = {...fs, realpath: async file => file === source ? path.join(path.dirname(options.root), 'outside') : fs.realpath(file)};
    await assert.rejects(createConfigStore({...options, fs: backend}).open(), /Symbolic links|escapes/);
    assert.equal(await fs.readFile(source, 'utf8'), 'original'); assert.equal((await state(options.root)).version, 1);
  }
});
