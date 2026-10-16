const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const executablePath = [process.env.WEBP_TEST_BROWSER, chromium.executablePath()].find(p => p && fs.existsSync(p));

test('real touch gestures collect once, preserve short taps, allow scrolling and cancel on unmount', {skip: !executablePath}, async t => {
  const source = require('esbuild').buildSync({stdin: {resolveDir: path.resolve(__dirname, '..'), contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPickerUI} from './src/core/ui/picker.ts';
    window.calls = []; window.menus = [];
    document.addEventListener('contextmenu', event => queueMicrotask(() => window.menus.push(event.defaultPrevented)), true);
    const {DCConItem} = createPickerUI({react: React}, {
      settings: {loadData: (_, fallback) => fallback}, packs: {toggleFavorite() {}}, images: {}, embedding: {},
      events: {subscribe() {}, unsubscribe() {}},
      sending: {sendDCConMessage: async (con, options) => {window.calls.push(options.keepOpen);}},
      media: {DCConImage: props => React.createElement('img', {alt: props.alt,
        src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="red"/></svg>')})}
    });
    const root = createRoot(document.getElementById('items'));
    root.render(Array.from({length: 60}, (_, index) => React.createElement(DCConItem, {key: index,
      con: {idx: index, path: String(index), title: 'image ' + index}})));
    window.unmountItems = () => root.unmount();
  `}, bundle: true, write: false, format: 'iife', platform: 'browser', define: {'process.env.NODE_ENV': '"production"'}}).outputFiles[0].text;
  const browser = await chromium.launch({executablePath, headless: true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 390, height: 700}, hasTouch: true, isMobile: true});
  // Keep touch emulation and injected gestures on the same CDP session.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(path.join(__dirname, '../src/core/style.css'),'utf8')}</style>
    <section class="dccon-popover" style="width:374px;height:500px;left:8px;top:8px"><div class="dccon-browser-content" id="scroll"><div class="dccon-items" id="items"></div></div></section>`);
  await page.addScriptTag({content: source});
  const item = page.locator('.dccon-item').first(); await item.waitFor();
  assert.equal(await item.locator('img').evaluate(i => getComputedStyle(i).pointerEvents), 'none');
  const point = async () => {const r = await item.boundingBox(); return {x: r.x + r.width / 2, y: r.y + r.height / 2};};
  const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: p ? [{...p, id: 1}] : []});
  let p = await point();
  await touch('touchStart', p); await page.waitForTimeout(650);
  assert.deepEqual(await page.evaluate(() => calls), [true]);
  // Verify cancellation even on desktop builds that do not raise a native long-press menu.
  assert.equal(await item.evaluate(e => e.dispatchEvent(new PointerEvent('contextmenu', {bubbles: true, cancelable: true, pointerType: 'touch'}))), false);
  await touch('touchEnd'); await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => calls), [true], 'release must not send/attach');
  await item.tap(); await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => calls), [true, false], 'the next short tap must work');
  await page.evaluate(() => document.getElementById('scroll').scrollTop = 0);
  p = await point(); await touch('touchStart', p); await page.waitForTimeout(80);
  for (let i = 1; i <= 5; i++) {await touch('touchMove', {x: p.x, y: p.y - i * 12}); await page.waitForTimeout(30);}
  await touch('touchEnd'); await page.waitForTimeout(550);
  assert.deepEqual(await page.evaluate(() => calls), [true, false]);
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollTop > 0), 'touch scrolling remains available');
  await page.evaluate(() => document.getElementById('scroll').scrollTop = 0);
  p = await point(); await touch('touchStart', p); await page.waitForTimeout(100);
  await page.evaluate(() => unmountItems()); await page.waitForTimeout(500); await touch('touchEnd');
  assert.deepEqual(await page.evaluate(() => calls), [true, false]);
  assert.ok(await page.evaluate(() => menus.length > 0 && menus.every(Boolean)));
});
