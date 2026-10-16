const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { createFiles } = require("../shelter/native");
function runtime(folder, cacheFolder, data = {}, extra = {}) {
  const context = {
    module: { exports: {} },
    require,
    File,
    Blob,
    URL,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    ...extra,
    BdApi: { Plugins: { folder, cacheFolder }, Logger: { error() {
    } }, Data: { load: (_, key) => data[key], save: (_, key, value) => {
      data[key] = value;
    } }, React: { Component: class {
    } }, Webpack: { getByKeys: () => ({}), getModule: () => ({}), Filters: { byKeys: () => () => true } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../discord-dccon.plugin.js"), "utf8") + "\nmodule.exports={appDataDirectory:(os,env,home)=>DCConPlatformAdapters.appDataDirectory(os,env,home,platform.paths.join),cachePath,readCacheFile,writeCacheFile,SharedConfig,getDCConImage,Embedding,WebPCache,loadData,saveData,setImageLoader:value=>{getDCConImage=value;}};", context);
  return { ...context.module.exports, context };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dccon-shared-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cache: path.join(root, "cache") };
}
const vector = Array(768).fill(0);
vector[0] = 1;
const pack = (paths) => [{ info: { package_idx: 1 }, detail: paths.map((path2) => ({ path: path2, ext: "png" })) }];
test("cache paths use OS app data and the same root for installation and channel variants", (t) => {
  const h = runtime("/unused", "/shared", {}, { require: (name) => name === "path" ? path.posix : require(name) });
  assert.equal(h.appDataDirectory("darwin", {}, "/Users/me"), "/Users/me/Library/Application Support");
  assert.equal(h.appDataDirectory("linux", {}, "/home/me"), "/home/me/.config");
  assert.equal(h.appDataDirectory("linux", { XDG_CONFIG_HOME: "/custom" }, "/home/me"), "/home/me/.config");
  assert.equal(h.appDataDirectory("win32", { APPDATA: "C:/Roaming" }, "/home/me"), "C:/Roaming");
  assert.equal(h.cachePath("images", "hash"), "/shared/images/hash");
  const fallback = runtime("/unused", void 0, {}, { require: (name) => name === "path" ? path.posix : name === "process" ? { platform: "linux", env: { XDG_CONFIG_HOME: "/custom" } } : name === "os" ? { homedir: () => "/home/me" } : require(name) });
  assert.equal(fallback.cachePath("models"), "/home/me/.config/discord-dccon/cache/models");
});
test("legacy images, merged images, codecs and models migrate without modifying the originals", async (t) => {
  const { root, cache } = fixture(t), old = path.join(root, "old"), h = runtime(old, cache);
  for (const [kind, previous] of [["images", ""], ["merged", "merged"], ["webp-codecs", "webp-codecs"], ["models", "embedding-gemma2"]]) {
    const source = path.join(old, "discord-dccon-cache", previous, "hash");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, Buffer.from([0, 128, 255]));
    assert.deepEqual(await h.readCacheFile(kind, "hash"), Buffer.from([0, 128, 255]));
    assert.deepEqual(fs.readFileSync(path.join(cache, kind, "hash")), Buffer.from([0, 128, 255]));
    assert.deepEqual(fs.readFileSync(source), Buffer.from([0, 128, 255]));
  }
  const other = runtime(path.join(root, "another-installation"), cache);
  assert.deepEqual(await other.readCacheFile("images", "hash"), Buffer.from([0, 128, 255]));
});
test("atomic writes from independent runtimes never share a temporary filename", async (t) => {
  const { root, cache } = fixture(t), a = runtime(root, cache), b = runtime(root, cache), target = path.join(cache, "images", "same");
  await Promise.all([a.writeCacheFile(target, Buffer.from("first")), b.writeCacheFile(target, Buffer.from("second"))]);
  assert.ok(["first", "second"].includes(fs.readFileSync(target, "utf8")));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["same"]);
});

test("atomic cache writes retry temporary Windows contention but propagate other failures", async (t) => {
  const { root, cache } = fixture(t), h = runtime(root, cache), target = path.join(cache, "images", "retry");
  let attempts = 0;
  const adapter = {mkdir: fs.promises.mkdir, writeFile: fs.promises.writeFile, unlink: fs.promises.unlink, async rename(...args) {
    if (++attempts === 1) throw Object.assign(Error("Busy destination"), {code: "EPERM"});
    return fs.promises.rename(...args);
  }};
  await h.writeCacheFile(target, Buffer.from("complete"), adapter);
  assert.equal(attempts, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "complete");
  adapter.rename = async () => {throw Object.assign(Error("No space"), {code: "ENOSPC"});};
  await assert.rejects(h.writeCacheFile(target, Buffer.from("replacement"), adapter), {code: "ENOSPC"});
  assert.equal(fs.readFileSync(target, "utf8"), "complete");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['retry']);
});

test("native migration error codes survive IPC and stop incompatible cache startup", async (t) => {
  const { root, cache } = fixture(t), h = runtime(root, cache);
  h.context.BdApi.Config = {open: async () => ({error: {message: "Newer configuration", code: "CONFIG_VERSION_TOO_NEW"}})};
  await assert.rejects(h.SharedConfig.open(), {code: "CONFIG_VERSION_TOO_NEW", message: "Newer configuration"});
});

test("cancelled model saves clean up the complete temporary file", async t => {
  const {root, cache} = fixture(t), h = runtime(root, cache), target = path.join(cache, 'models', 'model');
  let checks = 0;
  await assert.rejects(h.writeCacheFile(target, Buffer.alloc(1024 * 1024), fs.promises, () => {
    if (++checks === 2) throw Error('cancelled');
  }), /cancelled/);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
});

test("rapid shared setting saves keep newer optimistic edits and do not update the legacy store", async t => {
  const {root, cache} = fixture(t), legacy = {favorites: []}, h = runtime(root, cache, legacy);
  const {createConfigStore} = require('../scripts/shared-storage.cjs');
  const store = createConfigStore({root, vectorSpec: 'q8-image560-video6x280-v2'});
  let entered, finish;
  const ready = new Promise(resolve => {entered = resolve;});
  let first = true;
  h.context.BdApi.Config = {open: async () => {
    const config = await store.open(); return {...config, settings: Object.freeze(config.settings)};
  }, save: async (...args) => {
    if (first) {first = false; entered(); await new Promise(resolve => {finish = resolve;});}
    return store.save(...args);
  }};
  await h.SharedConfig.open();
  const a = {path: 'a', ext: 'png'}, b = {path: 'b', ext: 'png'};
  const p = h.saveData('favorites', [a]); await ready;
  const q = h.saveData('favorites', [a, b]);
  assert.equal(h.loadData('favorites').length, 2); finish(); await Promise.all([p, q]);
  assert.deepEqual((await store.open()).settings.favorites, [a, b]);
  assert.deepEqual(legacy, {favorites: []});
});

test("BetterDiscord callback filesystem initializes and saves the shared JSON with bridge-style errors", async t => {
  const {root, cache} = fixture(t), plugins = path.join(root, 'plugins'), legacy = {favorites: [{path:'bd',ext:'png'}]};
  fs.mkdirSync(plugins); fs.writeFileSync(path.join(plugins, 'discord-dccon.config.json'), JSON.stringify(legacy));
  const callbackFS = {};
  for (const method of ['mkdir','rmdir','readdir','lstat','stat','realpath','readFile','writeFile','rename','unlink']) callbackFS[method] = (...args) => {
    const callback = args.pop();
    fs[method === 'lstat' ? 'stat' : method](...args, (error, value) => callback(error ? Error(error.message) : null, value));
  };
  callbackFS.realpathSync = fs.realpathSync;
  const h = runtime(plugins, cache, legacy, {require: name => name === 'fs' ? callbackFS : require(name)});
  await h.SharedConfig.open(); await h.saveData('embeddingEnabled', false);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(config.version, 2); assert.equal(config.settings.embeddingEnabled, false);
  assert.deepEqual(config.settings.favorites, legacy.favorites);
  assert.equal(legacy.embeddingEnabled, undefined);
});
test("native cache mount is shared while saved images remain isolated and traversal is rejected", async (t) => {
  const { root, cache } = fixture(t), a = createFiles(path.join(root, "stable"), void 0, cache), b = createFiles(path.join(root, "canary"), void 0, cache);
  await a("mkdir", ["/cache/images", { recursive: true }]);
  await a("writeFile", ["/cache/images/hash", Buffer.from("shared")]);
  assert.equal((await b("readFile", ["/cache/images/hash", null])).toString(), "shared");
  await assert.rejects(a("writeFile", ["/cache/../../escape", Buffer.from("x")]), /escapes/);
  await assert.rejects(a("unlink", ["/cache/images/hash"]), /Invalid personal/);
  await assert.rejects(b("readFile", ["/dccon/saved", null]), { code: "ENOENT" });
});
test("different registered packs share per-image vectors without removing or overwriting other entries", async (t) => {
  const { root, cache } = fixture(t), dataA = { dccons: pack(["a", "b"]) }, dataB = { dccons: pack(["a", "c"]) };
  const a = runtime(path.join(root, "stable"), cache, dataA), b = runtime(path.join(root, "canary"), cache, dataB);
  let callsA = 0, callsB = 0;
  for (const h of [a, b]) {
    h.Embedding.ready = true;
    h.setImageLoader(async () => ({ type: "image/webp", arrayBuffer: async () => new ArrayBuffer(1) }));
  }
  a.Embedding.call = async () => {
    callsA++;
    return vector.slice();
  };
  b.Embedding.call = async () => {
    callsB++;
    return vector.slice();
  };
  await a.Embedding.index();
  await b.Embedding.index();
  assert.equal(callsA, 2);
  assert.equal(callsB, 1);
  const bFile = a.Embedding.vectorFile("b:png"), before = fs.readFileSync(bFile);
  dataA.dccons = pack(["a"]);
  await a.Embedding.index();
  assert.deepEqual(fs.readFileSync(bFile), before);
  assert.equal(fs.readdirSync(a.Embedding.vectorDirectory()).length, 3);
  const next = runtime(path.join(root, "third"), cache, { dccons: pack(["b"]) });
  next.Embedding.ready = true;
  next.Embedding.call = async () => {
    throw Error("must reuse vector");
  };
  await next.Embedding.index();
  assert.equal(next.Embedding.status.phase, "준비 완료");
  assert.deepEqual(Array.from(next.Embedding.vectors["b:png"]), vector);
  next.Embedding.call = async () => vector;
  assert.deepEqual(Array.from(await next.Embedding.search("query"), (r) => r.con.path), ["b"]);
});
test("legacy vector JSON migrates through startup without running image inference", async (t) => {
  const { root, cache } = fixture(t), old = path.join(root, "old"), file = path.join(old, "discord-dccon-cache", "embedding-gemma2", "vectors-v1.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved = JSON.stringify({ spec: "q8-image560-video6x280-v2", vectors: { "a:png": vector } });
  fs.writeFileSync(file, saved);
  const h = runtime(old, cache, { dccons: pack(["a"]) }, { navigator: { gpu: {} }, Worker: class {
    terminate() {
    }
  } });
  h.Embedding.asset = async () => new ArrayBuffer(0);
  h.Embedding.call = async (action) => {
    assert.equal(action, "init");
    return {};
  };
  h.setImageLoader(async () => {
    throw Error("must reuse legacy vector");
  });
  await h.Embedding.runStart();
  assert.equal(h.Embedding.status.phase, "준비 완료");
  assert.ok(fs.existsSync(h.Embedding.vectorFile("a:png")));
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  h.Embedding.stop();
});
test("a malformed or mismatched vector is rebuilt within its model namespace", async (t) => {
  const { root, cache } = fixture(t), h = runtime(root, cache, { dccons: pack(["a"]) });
  const e = h.Embedding;
  e.ready = true;
  fs.mkdirSync(e.vectorDirectory(), { recursive: true });
  fs.writeFileSync(e.vectorFile("a:png"), JSON.stringify({ spec: "other-model", key: "a:png", vector }));
  let calls = 0;
  h.setImageLoader(async () => ({ type: "image/webp", arrayBuffer: async () => new ArrayBuffer(1) }));
  e.call = async () => {
    calls++;
    return vector;
  };
  await e.index();
  assert.equal(calls, 1);
  const saved = JSON.parse(fs.readFileSync(e.vectorFile("a:png"), "utf8"));
  assert.equal(saved.spec, "q8-image560-video6x280-v2");
  assert.deepEqual(saved.vector, vector);
});
