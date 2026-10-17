const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {JSDOM} = require('jsdom');
const {IDBFactory} = require('fake-indexeddb');
const {createBetterDiscordPlatform} = require('../src/platform/betterdiscord.ts');
const {buildBetterDiscord, pluginPath} = require('../scripts/build.cjs');
const {createNativeServices} = require('../src/platform/native.ts');
const root = path.resolve(__dirname, '..');

test('BetterDiscord delegates host methods with their receiver and keeps optional services lazy', async () => {
  const calls = [];
  const api = {
    Webpack: {getByKeys() {assert.equal(this, api.Webpack); return {};}, getModule() {}},
    Net: {fetch(url, options) {assert.equal(this, api.Net); calls.push([url, options]); return Promise.resolve('response');}},
    Data: {load(name, key) {assert.equal(this, api.Data); return [name, key];},
      save(name, key, value) {assert.equal(this, api.Data); calls.push([name, key, value]);}},
    DOM: {addStyle(id, css) {assert.equal(this, api.DOM); calls.push([id, css]);}, removeStyle() {assert.equal(this, api.DOM);}},
  };
  const platform = createBetterDiscordPlatform(api, undefined);
  assert.equal(platform.cacheAvailable(), false);
  assert.equal(platform.config, undefined);
  const options = {signal: new AbortController().signal, headers: {Referer: 'test'}};
  assert.equal(await platform.net.fetch('test-url', options), 'response');
  assert.equal(calls[0][1], options);
  assert.deepEqual(platform.data.load('favorites'), ['discord-dccon', 'favorites']);
  platform.data.save('favorites', []);
  platform.styles.add('test', 'css'); platform.styles.remove('test');
  assert.deepEqual(calls.slice(1), [['discord-dccon', 'favorites', []], ['test', 'css']]);
});

test('native file access preserves error codes lost across the Electron bridge', async () => {
  const services = createNativeServices({file: async () => {throw Error('Error: ENOENT: missing cache');}});
  await assert.rejects(services.file('readFile', '/cache/images/missing', null), {code: 'ENOENT'});
  services.dispose();
});

test('BetterDiscord distribution is generated only under artifacts and contains no source-evaluation bridge', () => {
  const source = buildBetterDiscord();
  assert.equal(fs.readFileSync(pluginPath, 'utf8'), source);
  assert.equal(path.relative(root, pluginPath).split(path.sep).join('/'), 'artifacts/betterdiscord/discord-dccon.plugin.js');
  assert.equal(fs.existsSync(path.join(root, 'discord-dccon.plugin.js')), false);
  // The bundled third-party codec uses Function internally; storage must not evaluate module text.
  assert.doesNotMatch(source, /new Function\(["'](?:require|module)["']/);
});

test('shared core has no BetterDiscord or Node entry dependency', () => {
  const source = fs.readFileSync(path.join(root, 'src/core/plugin.ts'), 'utf8');
  // Embedded codec/storage programs have separate execution environments.
  const core = source.replace(/const (?:SHARED_STORAGE|SPLIT_WORKER)_SOURCE = .*;/g, '');
  assert.doesNotMatch(core, /\bBdApi\s*[.(]|\brequire\s*\(/);
  assert.doesNotMatch(core, /createBetterDiscordPlatform/);
  assert.match(core, /export function createPlugin\(platform: Platform/);
});

test('built userscript boots its own adapter, renders the picker, saves settings and cleans up without Shelter or BdApi', async t => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-userscript.cjs')], {cwd: root});
  const source = fs.readFileSync(path.join(root, 'artifacts/userscript/discord-dccon.user.js'), 'utf8');
  assert.doesNotMatch(source, /createBetterDiscordPlatform|createShelterPlatform|createConfigStore|createNativeRequire/);
  const dom = new JSDOM('<form><div class="channelTextArea_test"><textarea>draft</textarea><input type="file" multiple><div class="buttons_test"></div></div></form>',
    {url: 'https://discord.com/channels/1/2', runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom;
  t.after(() => {window.dispatchEvent(new window.Event('pagehide')); window.close();});
  window.document.querySelector('textarea').getClientRects = () => [{}];
  const indexedDB = new IDBFactory();
  Object.assign(window, {unsafeWindow: window, indexedDB, TextEncoder, TextDecoder, structuredClone,
    GM_getValue: (key, fallback) => key === 'data' ? {dccons: [], embeddingEnabled: false} : fallback,
    GM_xmlhttpRequest: () => {throw Error('Startup must not download');}});
  window.eval(source);
  async function until(check) {
    const end = Date.now() + 3000;
    while (!check()) {
      assert.ok(Date.now() < end, 'Userscript UI did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await until(() => window.document.documentElement.dataset.dcconAttachPoc === 'started' && window.document.querySelector('.dccon-trigger'));
  assert.equal(window.BdApi, undefined); assert.equal(window.shelter, undefined);
  window.document.querySelector('.dccon-trigger').click();
  await until(() => window.document.querySelector('[role="dialog"]'));
  assert.equal(window.document.querySelector('textarea').value, 'draft');
  const configuration = await new Promise((resolve, reject) => {
    const request = indexedDB.open('discord-dccon-userscript-settings', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('config'), read = tx.objectStore('config').get('current');
      read.onsuccess = () => resolve(read.result);
      tx.oncomplete = () => db.close();
    };
  });
  assert.equal(configuration.settings.embeddingEnabled, false);
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(window.document.querySelector('.dccon-trigger'), null);
  assert.equal(window.document.querySelector('[role="dialog"]'), null);
  assert.equal(window.document.documentElement.dataset.dcconAttachPoc, undefined);
});
