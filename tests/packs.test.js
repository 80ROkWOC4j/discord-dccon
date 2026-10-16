const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const React = require('react');

function pack(id, title = '고양이콘') {
  return {info: {package_idx: id, title, main_img_path: '', list_img_path: ''}, detail: []};
}

async function scenario(file, initial, run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const {createRoot} = require('react-dom/client');
  const data = {dccons: initial};
  const uploads = [];
  const nativeUploads = [];
  let requests = 0;
  const context = {module: {exports: {}}, window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver, queueMicrotask, structuredClone, setTimeout, clearTimeout, Blob, File, URL, AbortController, BdApi: {
    React, ReactDOM: require('react-dom'),
    // Deliberately return the SAME object, as a cached BetterDiscord store can.
    Data: {load: (name, key) => {assert.equal(name, 'discord-dccon'); return data[key];}, save: (name, key, value) => {assert.equal(name, 'discord-dccon'); data[key] = value;}},
    Net: {fetch: async () => { requests++; return {text: async () => JSON.stringify(pack(42)), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer}; }},
    UI: {showToast() {}}, Logger: {error: (...args) => { throw Error(args.join(' ')); }},
    DOM: {addStyle() {}, removeStyle() {}},
    Webpack: {getByKeys: () => ({locale: 'ko', addChangeListener() {}}), getStore: name => name === 'SelectedChannelStore' ? undefined : {getUploads: () => nativeUploads}, getModule: () => ({addFiles: args => { uploads.push(args); nativeUploads.push({id: String(uploads.length), item: args.files[0]}); }}), Filters: {byKeys: () => () => true}},
  }};
  vm.runInNewContext(require('./helpers/core.cjs').coreSource() +
    '\nWebPCache.convert = async bytes => bytes; module.exports = {DCConButton, DCConCategory, DCConSettingsPanel, Plugin: module.exports, DCConPanel, DCConItem, BufferTray: typeof BufferTray === "undefined" ? null : BufferTray, sendDCConMessage, updateQueue, setAnimationTiming: value => {animationTiming = value;}, PackThumbnail: typeof PackThumbnail === "undefined" ? null : PackThumbnail, events: PluginEvents, setChannel: id => { currentChannelId = id; }};', context);
  const {DCConSettingsPanel, Plugin} = context.module.exports;
  const root = createRoot(document.getElementById('root'));
  const ref = React.createRef();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const click = async element => {
    assert.ok(element);
    await React.act(async () => element.dispatchEvent(new window.MouseEvent('click', {bubbles: true})));
  };
  try {
    await React.act(async () => root.render(React.createElement(DCConSettingsPanel, {ref})));
    await run({data, errors, ref, click, requests: () => requests, Plugin, root, uploads, DCConSettingsPanel, ...context.module.exports});
  } finally {
    await React.act(async () => root.unmount());
    console.error = originalError;
    dom.window.close();
    delete global.window;
    delete global.document;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
}

async function searchResult(ref) {
  await React.act(async () => ref.current.setState({activeTab: 'shop', searchResults: [
    {idx: '42', name: '고양이콘', seller: '테스트', thumbId: ''},
  ]}));
}

test('individual con management opens a URL form when clipboard is unavailable', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({click, errors}) => {
    await click([...document.querySelectorAll('.dccon-tab-item')].find(item => item.textContent === '개별 콘'));
    await click(document.querySelector('.dccon-personal > button'));
    assert.equal(document.querySelectorAll('.dccon-personal-form input').length, 2);
    assert.match(document.querySelector('[role="status"]').textContent, /링크를 직접 입력/);
    assert.equal(document.querySelector('button[type="submit"]').disabled, true);
    const cancel = [...document.querySelectorAll('.dccon-personal-form button')].find(item => item.textContent === '취소');
    await click(cancel);
    assert.equal(document.querySelector('.dccon-personal-form'), null);
    assert.deepEqual(errors, []);
  });
});

test('one add and a rapid repeated remove keep storage and UI synchronized without changing tabs', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({data, ref, click, errors, requests}) => {
    await searchResult(ref);
    const add = document.querySelector('.dccon-card button');
    await React.act(async () => {
      add.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
      add.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(requests(), 1);
    assert.equal(data.dccons.length, 1);
    assert.equal(document.querySelector('.dccon-card button').disabled, true);
    await click(document.querySelector('.dccon-tab-item'));
    assert.equal(document.querySelectorAll('.dccon-card').length, 1);
    const remove = document.querySelector('.dccon-card .dccon-item-error');
    await React.act(async () => {
      remove.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
      remove.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(data.dccons.length, 0);
    assert.equal(document.querySelectorAll('.dccon-card').length, 0);
    assert.ok(document.querySelector('.dccon-empty-state'));
    await searchResult(ref);
    await click(document.querySelector('.dccon-card button'));
    await click(document.querySelector('.dccon-tab-item'));
    assert.equal(document.querySelectorAll('.dccon-card').length, 1);
    assert.deepEqual(errors, []);
  });
});

test('existing numeric/string duplicate IDs render once and removal preserves other packs', async () => {
  await scenario('discord-dccon.plugin.js', [pack(42), pack('42'), pack(99, '다른 팩')], async ({data, click, errors}) => {
    assert.equal(document.querySelectorAll('.dccon-card').length, 2);
    await click(document.querySelector('.dccon-card .dccon-item-error'));
    assert.equal(data.dccons.length, 1);
    assert.equal(String(data.dccons[0].info.package_idx), '99');
    assert.equal(document.querySelectorAll('.dccon-card').length, 1);
    assert.equal(document.querySelector('.dccon-card h3').textContent, '다른 팩');
    assert.deepEqual(errors, []);
  });
});

test('pack order controls persist order across remount and picker navigation', async () => {
  const initial = [pack(1, '첫째'), pack(2, '둘째'), pack(3, '셋째')];
  for (const item of initial) item.detail = [{idx: String(item.info.package_idx), title: '콘', path: 'image', ext: 'png'}];
  await scenario('discord-dccon.plugin.js', initial, async ({data, root, DCConSettingsPanel, DCConPanel, click, errors}) => {
    const titles = () => [...document.querySelectorAll('.dccon-card h3')].map(node => node.textContent);
    assert.equal(document.querySelector('[aria-label="첫째 위로"]').disabled, true);
    assert.equal(document.querySelector('[aria-label="셋째 아래로"]').disabled, true);
    await click(document.querySelector('[aria-label="셋째 위로"]'));
    assert.deepEqual(titles(), ['첫째', '셋째', '둘째']);
    await click(document.querySelector('[aria-label="첫째 아래로"]'));
    assert.deepEqual(titles(), ['셋째', '첫째', '둘째']);
    assert.deepEqual(Array.from(data.dccons, item => item.info.package_idx), [3, 1, 2]);
    await React.act(async () => root.render(null));
    await React.act(async () => root.render(React.createElement(DCConSettingsPanel)));
    assert.deepEqual(titles(), ['셋째', '첫째', '둘째']);
    await React.act(async () => root.render(React.createElement(DCConPanel, {type: 'dccon'})));
    assert.deepEqual([...document.querySelectorAll('.dccon-rail-button')].slice(3, 6).map(node => node.title), ['셋째', '첫째', '둘째']);
    assert.deepEqual(errors, []);
  });
});

test('startup repairs stored duplicates once and retains the original data backup', async () => {
  await scenario('discord-dccon.plugin.js', [pack(42), pack('42'), pack(99)], async ({data, Plugin}) => {
    const plugin = new Plugin({name: 'discord-dccon'});
    plugin.start();
    assert.equal(data.dccons.length, 2);
    assert.equal(data.dcconsBeforeDedup.length, 3);
    const backup = JSON.stringify(data.dcconsBeforeDedup);
    plugin.stop();
    plugin.start();
    assert.equal(data.dccons.length, 2);
    assert.equal(JSON.stringify(data.dcconsBeforeDedup), backup);
    plugin.stop();
  });
});

test('favorite star persists, appears in favorites, and removes immediately without attaching', async () => {
  const saved = pack(42);
  saved.detail = [{idx: '7', title: '안녕', path: 'image-path', ext: 'png'}];
  await scenario('discord-dccon.plugin.js', [saved], async ({root, DCConPanel, data, click, requests, errors}) => {
    await React.act(async () => root.render(React.createElement(DCConPanel, {type: 'dccon'})));
    await click(document.querySelector('.dccon-favorite'));
    assert.equal(data.favorites.length, 1);
    assert.equal(data.favorites[0].packageIdx, 42);
    assert.equal(requests(), 0);
    await click(document.querySelector('[aria-label="즐겨찾기"]'));
    assert.equal(document.querySelectorAll('.dccon-item').length, 1);
    await click(document.querySelector('.dccon-favorite'));
    assert.equal(data.favorites.length, 0);
    assert.equal(document.querySelectorAll('.dccon-item').length, 0);
    assert.ok(document.querySelector('.dccon-empty-state'));
    assert.deepEqual(errors, []);
  });
});


test('thumbnail uses cover and falls back from a 1px image, then to a label on errors', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({root, PackThumbnail, errors}) => {
    const saved = pack(42);
    saved.info.main_img_path = 'cover';
    saved.info.list_img_path = 'list';
    saved.detail = [{path: 'first-con'}];
    await React.act(async () => root.render(React.createElement(PackThumbnail, {pack: saved})));
    let image = document.querySelector('img');
    assert.ok(image.src.endsWith('cover'));
    Object.defineProperty(image, 'naturalWidth', {configurable: true, value: 1});
    await React.act(async () => image.dispatchEvent(new window.Event('load')));
    assert.ok(document.querySelector('img').src.endsWith('first-con'));
    await React.act(async () => image.dispatchEvent(new window.Event('error')));
    assert.ok(document.querySelector('img').src.endsWith('list'));
    await React.act(async () => image.dispatchEvent(new window.Event('error')));
    assert.equal(document.querySelector('img'), null);
    assert.equal(document.getElementById('root').textContent, '고');
    assert.deepEqual(errors, []);
  });
});

test('diagnostic tab displays a copyable report without uploading or modifying saved data', async () => {
  await scenario('discord-dccon.plugin.js', [pack(42)], async ({data, click, requests, uploads, errors, root, DCConSettingsPanel}) => {
    const before = JSON.stringify(data);
    await React.act(async () => root.render(React.createElement(DCConSettingsPanel, {section: 'settings'})));
    await click(document.querySelector('.dccon-diagnostics button'));
    const textarea = document.querySelector('textarea');
    assert.equal(textarea.readOnly, true);
    const report = JSON.parse(textarea.value);
    assert.ok(Object.hasOwn(report, 'CloudUpload'));
    assert.ok(Object.hasOwn(report, 'REST post/get/put/del'));
    assert.equal(requests(), 0);
    assert.equal(uploads.length, 0);
    assert.equal(JSON.stringify(data), before);
    await click([...document.querySelectorAll('.dccon-diagnostics button')].find(button => button.textContent === '제보용 정보 복사'));
    assert.match(document.querySelector('[role="status"]').textContent, /Ctrl\+C/);
    assert.equal(textarea.selectionEnd, textarea.value.length);
    assert.deepEqual(errors, []);
  });
});

test('settings no longer offer removed send modes', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({requests, uploads, root, DCConSettingsPanel}) => {
    await React.act(async () => root.render(React.createElement(DCConSettingsPanel, {section: 'settings'})));
    assert.equal(document.querySelector('input[name="dccon-send-mode"]'), null);
    assert.equal(document.querySelector('.dccon-mode-choice'), null);
    assert.ok(document.querySelector('.dccon-diagnostics'));
    assert.equal(requests(), 0);
    assert.equal(uploads.length, 0);
  });
});

test('buffer expands to the left without remounting the picker and collapses when cleared', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({root, DCConButton, sendDCConMessage, click, errors}) => {
    await React.act(async () => root.render(React.createElement(DCConButton, {channelId: 'side-buffer'})));
    await click(document.querySelector('[aria-label="디시콘"]'));
    const picker = document.querySelector('.dccon-pickerContainer');
    const height = document.querySelector('.dccon-popover').style.height;
    const con = {idx: '1', title: '안녕', path: 'test', ext: 'png'};
    await React.act(async () => { await sendDCConMessage(con, {keepOpen: true}); });
    const popup = document.querySelector('.dccon-popover-expanded');
    assert.ok(popup);
    assert.equal(popup.firstElementChild.className, 'dccon-buffer');
    assert.equal(document.querySelector('.dccon-pickerContainer'), picker);
    assert.equal(picker.querySelector('.dccon-buffer'), null);
    assert.equal(popup.style.height, height);
    await click(document.querySelector('.dccon-buffer-heading button'));
    assert.equal(document.querySelector('.dccon-popover-expanded'), null);
    assert.equal(document.querySelector('.dccon-pickerContainer'), picker);
    await click(document.querySelector('[aria-label="닫기"]'));
    assert.equal(document.querySelector('.dccon-overlay'), null);
    assert.deepEqual(errors, []);
  });
});

test('private buffer tray shows local thumbnails, survives remount, and supports remove and clear', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({root, BufferTray, sendDCConMessage, setChannel, click, uploads, errors, data}) => {
    data.sendMode = 'image';
    setChannel('buffer-ui');
    const con = {idx: '1', title: '안녕', path: 'test', ext: 'png'};
    await React.act(async () => root.render(React.createElement(BufferTray, {channelId: 'buffer-ui'})));
    await React.act(async () => { await sendDCConMessage(con, {keepOpen: true}); await sendDCConMessage(con, {keepOpen: true}); });
    assert.equal(uploads.length, 0);
    assert.equal(document.querySelectorAll('.dccon-buffer img').length, 2);
    assert.equal(document.querySelector('.dccon-buffer-items').dataset.count, '2');
    assert.equal(document.querySelector('.dccon-buffer-send').disabled, false);
    assert.equal(document.querySelector('.dccon-buffer-split').disabled, true);
    assert.deepEqual([...document.querySelectorAll('.dccon-buffer-order')].map(node => node.textContent), ['1', '2']);
    assert.ok(document.querySelector('.dccon-buffer img').src.startsWith('blob:'));
    await React.act(async () => root.render(null));
    await React.act(async () => root.render(React.createElement(BufferTray, {channelId: 'buffer-ui'})));
    assert.equal(document.querySelectorAll('.dccon-buffer img').length, 2);
    await click(document.querySelector('[aria-label="안녕 제거"]'));
    assert.match(document.querySelector('[role="status"]').textContent, /1\/9/);
    assert.equal(document.querySelector('.dccon-buffer-items').dataset.count, '1');
    assert.equal(document.querySelector('.dccon-buffer-order').textContent, '1');
    assert.equal(document.querySelector('.dccon-buffer-split').disabled, false);
    await click(document.querySelector('.dccon-buffer-heading button'));
    assert.equal(document.querySelector('.dccon-buffer'), null);
    assert.deepEqual(errors, []);
  });
});

test('pack collapse persists independently across remounts and pack reordering', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({root, DCConCategory, click, data, errors}) => {
    const first = pack(42, '첫 번째'), second = pack(43, '두 번째');
    const render = async packs => React.act(async () => root.render(React.createElement(React.Fragment, null,
      ...packs.map(dccon => React.createElement(DCConCategory, {key: dccon.info.package_idx, dccon})))));
    const headers = () => [...document.querySelectorAll('.dccon-category-header')];
    await render([first, second]);
    assert.deepEqual(headers().map(e => e.getAttribute('aria-expanded')), ['true', 'true']);
    await click(headers()[0]);
    await click(headers()[1]);
    assert.deepEqual(data.collapsedPacks, {'42': true, '43': true});
    await click(headers()[1]);
    assert.deepEqual(data.collapsedPacks, {'42': true});
    await React.act(async () => root.render(null));
    // A fresh component reads saved data, with string IDs and a different order.
    await render([second, {...first, info: {...first.info, package_idx: '42'}}]);
    assert.deepEqual(headers().map(e => e.getAttribute('aria-expanded')), ['true', 'false']);
    assert.equal(document.querySelectorAll('.dccon-items').length, 1);
    await click(headers()[1]);
    await React.act(async () => root.render(null));
    await render([first, second]);
    assert.deepEqual(headers().map(e => e.getAttribute('aria-expanded')), ['true', 'true']);
    assert.deepEqual(data.collapsedPacks, {});
    assert.deepEqual(errors, []);
  });
});

test('merge button follows animation compatibility and ignores stale asynchronous checks', async () => {
  await scenario('discord-dccon.plugin.js', [], async ({root, BufferTray, updateQueue, setAnimationTiming, errors}) => {
    const entry = duration => ({file: Object.assign(new File(['image'], 'dccon.webp'), {duration}), con: {title: '콘'}});
    setAnimationTiming(async file => ({count: 2, duration: file.duration, loops: Infinity}));
    const render = async entries => React.act(async () => {updateQueue('merge-ui', entries);});
    await React.act(async () => root.render(React.createElement(BufferTray, {channelId: 'merge-ui'})));
    await render([entry(200), entry(200)]);
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, false);
    await render([entry(200), entry(300)]);
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, true);
    assert.match(document.querySelector('.dccon-buffer-merge-reason').textContent, /재생 길이/);
    await render([entry(200), entry(200), entry(200)]);
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, false);
    await render(Array.from({length: 4}, () => entry(200)));
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, true);
    const pending = [];
    setAnimationTiming(() => new Promise(resolve => {pending.push(resolve);}));
    const shared = entry(200);
    await render([shared, shared]);
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, true);
    await render([entry(200)]);
    await React.act(async () => pending.forEach(resolve => resolve({count: 2, duration: 200, loops: Infinity})));
    assert.equal(document.querySelector('.dccon-buffer-merge').disabled, true);
    assert.match(document.querySelector('.dccon-buffer-merge-reason').textContent, /2~3개/);
    assert.deepEqual(errors, []);
  });
});
