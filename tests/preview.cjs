// Render the actual plugin components with sample assets, without Discord or network access.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {chromium} = require('playwright');
const assert = require('node:assert/strict');

async function main() {
  const sample = (text, color) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="8" y="8" width="84" height="84" rx="28" fill="${color}"/><text x="50" y="59" text-anchor="middle" font-size="20" font-family="sans-serif" fill="#202126">${text}</text></svg>`);
  const packs = ['일상 인사', '작업 중', '오늘의 기분'].map((title, i) => ({
    info: {package_idx: i + 1, title, list_img_path: sample(String(i + 1), '#b6baff'), main_img_path: sample(String(i + 1), '#b6baff')},
    detail: ['안녕', '고마워', '좋아요', '잘자', '최고', '응원'].map((text, j) => ({idx: i * 10 + j, title: text, path: sample(text, ['#b6baff', '#a6e4cf', '#f4cf97'][i])})),
  }));
  const context = {module: {exports: {}}, structuredClone, BdApi: {
    React, Data: {load: (_, key) => key === 'dccons' ? packs : []},
    Webpack: {getByKeys: () => ({locale: 'ko'}), getModule: () => ({}), Filters: {byKeys: () => () => true}},
  }};
  let source = require('./helpers/core.cjs').coreSource();
  source = source.replace(/const DCConProxyURL = .*?;/, 'const DCConProxyURL = "";');
  vm.runInNewContext(source + '\nmodule.exports = {Plugin: module.exports, DCConPanel, DCConSettingsPanel};', context);
  const {Plugin, DCConPanel, DCConSettingsPanel} = context.module.exports;
  const css = Object.getOwnPropertyDescriptor(Plugin.prototype, 'css').get.call({});
  const output = path.resolve(__dirname, '../artifacts/ui-previews');
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage();
    for (const [name, width, theme, management] of [
      ['dark', 620, 'theme-dark', false], ['light', 620, 'theme-light', false],
      ['narrow', 360, 'theme-dark', false], ['manage', 620, 'theme-dark', true],
      ['settings', 620, 'theme-dark', 'settings'], ['settings-narrow', 360, 'theme-dark', 'settings'],
    ]) {
      await page.setViewportSize({width, height: 630});
      const markup = renderToStaticMarkup(React.createElement(management ? DCConSettingsPanel : DCConPanel, {type: 'dccon', section: management === 'settings' ? 'settings' : 'packs'}));
      await page.setContent(`<html class="${theme}"><meta charset="utf-8"><style>body {background:${theme === 'theme-dark' ? '#313338' : '#fff'}; margin:0} button,input {color:black; font:13px serif} ${css}</style><section class="dccon-popover" style="left:8px;top:16px;height:580px"><div class="dccon-popover-toolbar"><button aria-pressed="${!management}">내 디시콘</button><button aria-pressed="${management}">팩 추가 / 관리</button><button aria-pressed="${management === 'settings'}">설정</button><button>×</button></div><div class="dccon-popover-body">${markup}</div></section></html>`);
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => { image.loading = 'eager'; return image.decode(); }));
      });
      await page.screenshot({path: path.join(output, name + '.png')});
      const result = await page.evaluate(() => {
        const root = document.querySelector('.dccon-popover');
        const heading = document.querySelector('.dccon-category-name, .dccon-card-content h3, .dccon-user-settings h3');
        return {fits: root.scrollWidth <= root.clientWidth, color: getComputedStyle(heading).color, font: getComputedStyle(heading).fontFamily};
      });
      assert.equal(result.fits, true, name + ' must not overflow horizontally');
      assert.notEqual(result.color, 'rgb(0, 0, 0)', name + ' should use theme text color');
      console.log(name, result);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
