const path = require('path');
const crypto = require('crypto');

function digest(bytes) {return crypto.createHash('sha256').update(bytes).digest('hex');}
function validVector(vector) {
  return Array.isArray(vector) && vector.length === 768 && vector.every(Number.isFinite) &&
    Math.abs(Math.hypot(...vector) - 1) < 0.001;
}
async function readConfig(fs, root) {
  let text;
  try {text = await fs.readFile(path.join(root, 'config.json'), 'utf8');}
  catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  const state = JSON.parse(text);
  if (!Number.isInteger(state.version) || state.version < 1 || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings))
    throw Error('Invalid shared configuration');
  return state;
}
async function atomicJSON(ctx, file, value) {
  await ctx.fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = file + '.tmp-' + ctx.token + '-' + ++ctx.sequence;
  try {
    await ctx.fs.writeFile(temporary, JSON.stringify(value));
    await rename(ctx.fs, temporary, file);
  } catch (error) {
    try {await ctx.fs.unlink(temporary);} catch { /* Keep the previously committed state. */ }
    throw error;
  }
}
async function rename(fs, source, target) {
  for (let attempt = 0; ; attempt++) {
    try {return await fs.rename(source, target);}
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
async function exists(fs, file) {
  try {await fs.stat(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
function within(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Migration path escapes cache root');
}
async function moveFile(ctx, source, target) {
  within(ctx.root, target);
  await ctx.fs.mkdir(path.dirname(target), {recursive: true});
  try {await ctx.fs.rename(source, target);}
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const temporary = target + '.tmp-' + ctx.token + '-' + ++ctx.sequence;
    try {
      if (ctx.fs.copyFile) await ctx.fs.copyFile(source, temporary);
      else await ctx.fs.writeFile(temporary, await ctx.fs.readFile(source, null));
      if (await ctx.hashFile(source) !== await ctx.hashFile(temporary)) throw Error('Migration copy verification failed');
      await ctx.fs.rename(temporary, target);
      await ctx.fs.unlink(source);
    } catch (copyError) {
      try {await ctx.fs.unlink(temporary);} catch { /* Retain the source on failure. */ }
      throw copyError;
    }
  }
  ctx.report.moved++;
}
async function archiveFile(ctx, source, legacyRoot, relative) {
  const archive = path.join(ctx.cacheRoot, 'migration-backup', 'v2', digest(legacyRoot), relative);
  if (await exists(ctx.fs, archive)) {
    const hash = await ctx.hashFile(source);
    if (hash === await ctx.hashFile(archive)) {await ctx.fs.unlink(source); ctx.report.duplicates++; return;}
    await moveFile(ctx, source, archive + '.' + hash);
  } else await moveFile(ctx, source, archive);
  ctx.report.archived++;
}
async function migrateVectors(ctx, source, legacyRoot, relative) {
  let saved;
  try {saved = JSON.parse(await ctx.fs.readFile(source, 'utf8'));}
  catch { /* Preserve an unreadable legacy index in the migration backup. */ }
  if (saved && [ctx.vectorSpec, 'q8-560-gif3-browser-v1'].includes(saved.spec) && saved.vectors) {
    for (const [key, vector] of Object.entries(saved.vectors)) {
      if (!validVector(vector) || (saved.spec !== ctx.vectorSpec && key.endsWith(':gif'))) continue;
      const target = path.join(ctx.cacheRoot, 'vectors', ctx.vectorSpec, digest(key) + '.json');
      let current;
      try {current = JSON.parse(await ctx.fs.readFile(target, 'utf8'));} catch { /* Write a missing or invalid vector. */ }
      if (current?.spec === ctx.vectorSpec && current.key === key && validVector(current.vector)) continue;
      await atomicJSON(ctx, target, {spec: ctx.vectorSpec, key, vector});
      ctx.report.vectors++;
    }
  }
  await archiveFile(ctx, source, legacyRoot, relative);
}
async function migration_v2(ctx) {
  for (const legacyRoot of ctx.legacyRoots) {
    if (!['discord-dccon-cache', 'DCCon-cache'].includes(path.basename(legacyRoot))) throw Error('Unexpected legacy cache directory');
    if (legacyRoot === ctx.cacheRoot) throw Error('Legacy and current cache directories must differ');
    let realRoot;
    async function visit(directory) {
      within(legacyRoot, directory);
      let entries;
      try {entries = await ctx.fs.readdir(directory);}
      catch (error) {if (error.code === 'ENOENT') return; throw error;}
      for (const name of entries.sort()) {
        const source = path.join(directory, name), info = await ctx.fs.lstat(source);
        within(legacyRoot, source);
        if (info.isSymbolicLink()) throw Error('Symbolic links in legacy cache require manual migration');
        // BetterDiscord's lstat shim follows links. Native Node lstat already
        // detects them and avoids false positives from Windows file virtualization.
        if (ctx.verifyRealPaths) {
          const expected = path.join(realRoot, path.relative(legacyRoot, source));
          const actual = await ctx.fs.realpath(source);
          const same = path.sep !== '/' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
          if (!same) throw Error('Symbolic links in legacy cache require manual migration');
        }
        if (info.isDirectory()) {await visit(source); continue;}
        if (!info.isFile()) throw Error('Unsupported legacy cache entry');
        const relative = path.relative(legacyRoot, source), parts = relative.split(path.sep);
        if (parts.length === 2 && parts[0] === 'embedding-gemma2' && name === 'vectors-v1.json') {
          await migrateVectors(ctx, source, legacyRoot, relative); continue;
        }
        let target;
        if (parts.length === 1 && /^[a-f0-9]{64}$/.test(name)) target = path.join(ctx.cacheRoot, 'images', name);
        if (parts.length === 2 && /^[a-f0-9]{64}$/.test(name)) {
          const category = {merged: 'merged', 'webp-codecs': 'webp-codecs', 'embedding-gemma2': 'models'}[parts[0]];
          if (category) target = path.join(ctx.cacheRoot, category, name);
        }
        if (!target) {await archiveFile(ctx, source, legacyRoot, relative); continue;}
        if (await exists(ctx.fs, target)) {
          if (await ctx.hashFile(source) === await ctx.hashFile(target)) {await ctx.fs.unlink(source); ctx.report.duplicates++;}
          else await archiveFile(ctx, source, legacyRoot, relative);
        } else await moveFile(ctx, source, target);
      }
      await ctx.fs.rmdir(directory);
    }
    // Windows virtualization can reveal an underlying directory after moving
    // its overlay. Finish all visible layers before committing this version.
    while (await exists(ctx.fs, legacyRoot)) {
      if ((await ctx.fs.lstat(legacyRoot)).isSymbolicLink()) throw Error('Legacy cache root must not be a symbolic link');
      if (ctx.verifyRealPaths) {
        realRoot = await ctx.fs.realpath(legacyRoot);
        const expected = path.join(await ctx.fs.realpath(path.dirname(legacyRoot)), path.basename(legacyRoot));
        const same = path.sep !== '/' ? expected.toLowerCase() === realRoot.toLowerCase() : expected === realRoot;
        if (!same) throw Error('Legacy cache root must not be a symbolic link');
      }
      await visit(legacyRoot);
    }
  }
}
function defaultLegacyRoots(cacheRoot) {
  const appData = path.dirname(path.dirname(cacheRoot));
  return [path.join(appData, 'BetterDiscord', 'plugins', 'discord-dccon-cache'),
    path.join(appData, 'discord-dccon', 'discord-dccon-cache'),
    path.join(appData, 'discord-dccon-canary', 'discord-dccon-cache'),
    path.join(appData, 'discord-dccon', 'DCCon-cache')];
}

// Electron's contextBridge drops Error.code from BetterDiscord's fs shim.
function normalizeFS(backend) {
  return new Proxy(backend, {get(target, key) {
    const method = target[key];
    if (typeof method !== 'function') return method;
    return async (...args) => {
      try {return await method.apply(target, args);}
      catch (error) {
        if (!error.code) {
          const code = /(?:^|Error: )(E[A-Z0-9]+):/.exec(error.message)?.[1];
          if (code) error.code = code;
        }
        throw error;
      }
    };
  }});
}
const listKeys = new Set(['dccons', 'favorites', 'recent', 'personalCons']);
function itemKey(key, item) {
  return key === 'dccons' ? String(item.info.package_idx) : item.path + ':' + item.ext;
}
function same(a, b) {return JSON.stringify(a) === JSON.stringify(b);}
function mergeSetting(key, before, next, current) {
  if (listKeys.has(key) && Array.isArray(next)) {
    const previous = new Map((before || []).map(item => [itemKey(key, item), item]));
    const desired = new Map(next.map(item => [itemKey(key, item), item]));
    const latest = new Map((current || []).map(item => [itemKey(key, item), item]));
    for (const id of previous.keys()) if (!desired.has(id)) latest.delete(id);
    const ordered = new Map();
    for (const [id, item] of desired) {
      if (!previous.has(id) || !same(previous.get(id), item)) latest.set(id, item);
      if (latest.has(id)) ordered.set(id, latest.get(id));
    }
    for (const [id, item] of latest) if (!ordered.has(id)) ordered.set(id, item);
    return [...ordered.values()];
  }
  if (key === 'collapsedPacks' && next && typeof next === 'object') {
    const result = {...current};
    for (const name of new Set([...Object.keys(before || {}), ...Object.keys(next)])) {
      if (same(before?.[name], next[name])) continue;
      if (Object.hasOwn(next, name)) result[name] = next[name]; else delete result[name];
    }
    return result;
  }
  return next;
}
async function importSettings(ctx, preferred) {
  const appData = path.dirname(ctx.root), legacy = ctx.options.legacyPluginsRoot || path.join(appData, 'BetterDiscord', 'plugins');
  const sources = [path.join(legacy, 'discord-dccon.config.json'),
    path.join(appData, 'discord-dccon-canary', 'discord-dccon.config.json'),
    path.join(appData, 'discord-dccon', 'discord-dccon.config.json')];
  const settings = {};
  for (const source of sources) {
    let raw;
    try {raw = await ctx.fs.readFile(source, 'utf8');}
    catch (error) {if (error.code === 'ENOENT') continue; throw error;}
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid legacy settings');
    await atomicJSON(ctx, path.join(ctx.root, 'migration-backup', 'settings', digest(source) + '.json'), value);
    for (const [key, item] of Object.entries(value)) settings[key] = mergeSetting(key, undefined, item, settings[key]);
  }
  for (const [key, item] of Object.entries(preferred)) settings[key] = mergeSetting(key, undefined, item, settings[key]);
  // Keep an independent backup of the imported IndexedDB/BD snapshot.
  if (Object.keys(preferred).length)
    await atomicJSON(ctx, path.join(ctx.root, 'migration-backup', 'settings', 'imported-' + digest(JSON.stringify(preferred)) + '.json'), preferred);
  return settings;
}
async function migrateLibrary(ctx) {
  const appData = path.dirname(ctx.root), destination = path.join(ctx.root, 'discord-dccon-library');
  const roots = [path.join(ctx.options.legacyPluginsRoot || path.join(appData, 'BetterDiscord', 'plugins'), 'discord-dccon-library'),
    path.join(appData, 'discord-dccon-canary', 'discord-dccon-library')];
  for (const root of roots) {
    if (!await exists(ctx.fs, root)) continue;
    const realRoot = await ctx.fs.realpath(root);
    if (ctx.verifyRealPaths) {
      const expected = path.join(await ctx.fs.realpath(path.dirname(root)), path.basename(root));
      if (path.sep === '/' ? realRoot !== expected : realRoot.toLowerCase() !== expected.toLowerCase()) throw Error('Library root must not be a symbolic link');
    }
    async function visit(directory) {
      const info = await ctx.fs.lstat(directory);
      if (info.isSymbolicLink()) throw Error('Symbolic links in legacy library require manual migration');
      if (ctx.verifyRealPaths) {
        const actual = await ctx.fs.realpath(directory), expected = path.join(realRoot, path.relative(root, directory));
        if (path.sep === '/' ? actual !== expected : actual.toLowerCase() !== expected.toLowerCase()) throw Error('Library path escapes source');
      }
      if (info.isDirectory()) {
        for (const name of (await ctx.fs.readdir(directory)).sort()) await visit(path.join(directory, name));
        await ctx.fs.rmdir(directory); return;
      }
      if (!info.isFile()) throw Error('Unsupported legacy library entry');
      const relative = path.relative(root, directory);
      const target = /^[a-f0-9]{64}$/.test(relative) ? path.join(destination, relative)
        : path.join(ctx.root, 'migration-backup', 'library', digest(root), relative);
      if (await exists(ctx.fs, target)) {
        if (await ctx.hashFile(directory) === await ctx.hashFile(target)) {await ctx.fs.unlink(directory); return;}
        await moveFile(ctx, directory, path.join(ctx.root, 'migration-backup', 'library', digest(root), relative + '.' + await ctx.hashFile(directory)));
      } else await moveFile(ctx, directory, target);
    }
    while (await exists(ctx.fs, root)) await visit(root);
  }
}
async function upgradeV2(ctx) {
  const oldMarker = path.join(ctx.cacheRoot, 'migration.json');
  let marker;
  try {marker = JSON.parse(await ctx.fs.readFile(oldMarker, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (marker && (!Number.isInteger(marker.version) || marker.version < 1)) throw Error('Invalid legacy cache version');
  if (marker?.version > 2) throw Object.assign(Error('Cache format is newer than this plugin'), {code: 'CONFIG_VERSION_TOO_NEW'});
  await migration_v2(ctx);
  await migrateLibrary(ctx);
  if (marker) await moveFile(ctx, oldMarker, path.join(ctx.root, 'migration-backup', 'cache-migration.json'));
}
function checkVersion(config, latest) {
  if (config.version > latest) throw Object.assign(Error('Configuration is newer than this plugin'), {code: 'CONFIG_VERSION_TOO_NEW'});
}
function createConfigStore(options, migrations = {2: upgradeV2}) {
  if (!/^[a-zA-Z0-9-]+$/.test(options.vectorSpec)) throw Error('Invalid vector cache version');
  const fs = normalizeFS(options.fs || require('fs').promises), root = path.resolve(options.root);
  const latest = options.latestVersion ?? Math.max(...Object.keys(migrations).map(Number));
  const ownerAlive = options.ownerAlive || (pid => {
    if (typeof process === 'undefined' || process.isWeb) return null;
    try {process.kill(pid, 0); return true;} catch (error) {return error.code !== 'ESRCH';}
  });
  async function locked(action) {
    await fs.mkdir(root, {recursive: true});
    const token = crypto.randomBytes(16).toString('hex'), lock = path.join(root, 'config.lock');
    const ownerFile = path.join(lock, 'owner.json'), pulse = path.join(lock, 'heartbeat'), staleLocks = [], started = Date.now();
    const ctx = {fs, root, cacheRoot: path.join(root, 'cache'), token, sequence: 0, options, vectorSpec: options.vectorSpec,
      verifyRealPaths: !!options.fs, legacyRoots: [...new Set((options.legacyRoots || [
        ...(options.legacyPluginsRoot ? [path.join(options.legacyPluginsRoot, 'discord-dccon-cache')] : []),
        ...defaultLegacyRoots(path.join(root, 'cache'))]).map(value => path.resolve(value)))],
      report: {moved: 0, duplicates: 0, archived: 0, vectors: 0}};
    ctx.hashFile = async file => {
      if (options.fs) return digest(await fs.readFile(file, null));
      const hash = crypto.createHash('sha256');
      for await (const bytes of require('fs').createReadStream(file)) hash.update(bytes);
      return hash.digest('hex');
    };
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let staleObservation;
    while (true) {
      try {await fs.mkdir(lock, {recursive: false}); break;}
      catch (error) {if (error.code !== 'EEXIST') throw error;}
      let owner, info;
      try {owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));} catch { /* Retry incomplete owner metadata. */ }
      try {info = await fs.stat(pulse);}
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {info = await fs.stat(lock);} catch (missing) {if (missing.code === 'ENOENT') continue; throw missing;}
      }
      const alive = Number.isInteger(owner?.pid) ? ownerAlive(owner.pid) : null;
      const identity = /^[a-f0-9]{32}$/.test(owner?.token) ? owner.token : digest(String(info.birthtimeMs));
      const expired = alive === false || (alive === null && Date.now() - info.mtimeMs > 120000);
      if (expired && staleObservation === identity + ':' + info.mtimeMs) {
        const stale = lock + '.stale-' + identity;
        try {await fs.rename(lock, stale); staleLocks.push(stale); continue;}
        catch (error) {if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;}
      }
      staleObservation = expired ? identity + ':' + info.mtimeMs : undefined;
      if (Date.now() - started > (options.waitMs ?? 60000)) throw Error('Timed out waiting for shared configuration');
      await sleep(100);
    }
    const owner = {pid: options.pid ?? (typeof process === 'undefined' ? 0 : process.pid), token};
    let timer, heartbeat = Promise.resolve();
    try {
      await atomicJSON(ctx, ownerFile, owner);
      await fs.writeFile(pulse, '');
      timer = setInterval(() => {heartbeat = heartbeat.then(() => fs.writeFile(pulse, '')).catch(() => {});}, 5000);
      return await action(ctx);
    } finally {
      clearInterval(timer); await heartbeat;
      let current;
      try {current = JSON.parse(await fs.readFile(ownerFile, 'utf8'));} catch {}
      if (!current || current.token === token) {
        for (const file of [ownerFile, pulse]) try {await fs.unlink(file);} catch (error) {if (error.code !== 'ENOENT') throw error;}
        await fs.rmdir(lock);
      }
      for (const stale of staleLocks) {
        for (const name of ['owner.json', 'heartbeat']) try {await fs.unlink(path.join(stale, name));} catch (error) {if (error.code !== 'ENOENT') throw error;}
        try {await fs.rmdir(stale);} catch (error) {if (error.code !== 'ENOTEMPTY') throw error;}
      }
    }
  }
  return {
    open(preferred = {}) {return locked(async ctx => {
      let config = await readConfig(fs, root);
      if (!config) {
        config = {version: 1, settings: await importSettings(ctx, preferred)};
        await atomicJSON(ctx, path.join(root, 'config.json'), config);
      }
      checkVersion(config, latest);
      while (config.version < latest) {
        const next = config.version + 1;
        if (typeof migrations[next] !== 'function') throw Error('Missing configuration migration v' + next);
        await migrations[next](ctx);
        config.version = next;
        await atomicJSON(ctx, path.join(root, 'config.json'), config);
      }
      return config;
    });},
    save(key, value, before) {return locked(async ctx => {
      const config = await readConfig(fs, root);
      if (!config) throw Error('Shared configuration has not been initialized');
      checkVersion(config, latest);
      if (config.version !== latest) throw Error('Shared configuration needs migration');
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Invalid setting key');
      config.settings[key] = mergeSetting(key, before, value, config.settings[key]);
      await atomicJSON(ctx, path.join(root, 'config.json'), config);
      return config;
    });}
  };
}
module.exports = {createConfigStore, migration_v2, normalizeFS, mergeSetting};
