const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServices} = require('../src/core/plugin.ts');
const {createSettings} = require('../src/core/settings.ts');
const {createEvents} = require('../src/core/events.ts');
const {webpFile, isWebP} = require('../src/core/codecs.ts');

function platform() {
  const settings = {dccons: [], recent: [], embeddingEnabled: true};
  return {config: {
    open: async () => ({settings: structuredClone(settings)}),
    save: async (key, value) => {settings[key] = value; return {settings: structuredClone(settings)};},
  }, logger: {error() {}}, ui: {showToast() {}}};
}

test('feature instances own their queues, notifications and cancellation state', () => {
  const a = createServices(platform(), {splitWorkerSource: ''});
  const b = createServices(platform(), {splitWorkerSource: ''});
  const entry = {con: {path: 'one'}, file: new File(['one'], 'one.gif')};
  let changesA = 0, changesB = 0;
  a.events.subscribe('DCCON_BUFFER_UPDATE', () => changesA++);
  b.events.subscribe('DCCON_BUFFER_UPDATE', () => changesB++);
  a.sending.updateQueue('channel', [entry]);
  assert.deepEqual(a.sending.activeQueue('channel'), [entry]);
  assert.deepEqual(b.sending.activeQueue('channel'), []);
  assert.equal(changesA, 1); assert.equal(changesB, 0);
  b.sending.updateQueue('channel', [entry]);
  a.sending.stop(); a.codecs.stop();
  assert.deepEqual(a.sending.activeQueue('channel'), []);
  assert.deepEqual(b.sending.activeQueue('channel'), [entry]);
  assert.equal(b.codecs.generation, 0);
  a.disconnect(); b.disconnect();
});

test('settings changes trigger indexing once and reconnect cleanly after stopping', async () => {
  const services = createServices(platform(), {splitWorkerSource: ''});
  await services.settings.open();
  let indexed = 0;
  services.embedding.index = async () => {indexed++;};
  services.connect(); services.connect();
  await services.settings.saveData('dccons', []);
  assert.equal(indexed, 1);
  await services.settings.saveData('favorites', []);
  assert.equal(indexed, 1);
  services.disconnect(); services.disconnect();
  await services.settings.saveData('personalCons', []);
  assert.equal(indexed, 1);
  services.connect(); services.connect();
  await services.settings.saveData('personalCons', []);
  assert.equal(indexed, 2);
  services.disconnect();
});

test('settings notify after optimistic state changes without waiting for persistence', async () => {
  let complete;
  const host = platform();
  host.config.save = () => new Promise(resolve => {complete = resolve;});
  const settings = createSettings(host, 'test');
  await settings.open();
  const observed = [];
  const unsubscribe = settings.subscribe(key => observed.push([key, settings.loadData(key)]));
  const saving = settings.saveData('embeddingEnabled', false);
  assert.deepEqual(observed, [['embeddingEnabled', false]]);
  await Promise.resolve();
  complete({settings: {embeddingEnabled: false}});
  await saving;
  unsubscribe();
});

test('small utilities and events are directly importable without a plugin or browser', () => {
  const events = createEvents(), received = [];
  const listener = event => received.push(event.type);
  events.subscribe('test', listener); events.dispatch({type: 'test'}); events.unsubscribe('test', listener);
  events.dispatch({type: 'test'});
  assert.deepEqual(received, ['test']);
  const bytes = new Uint8Array(Buffer.from('RIFF0000WEBPVP8L00000000000000'));
  assert.equal(isWebP(bytes), true);
  assert.equal(webpFile(bytes).name, 'dccon.gif');
});
