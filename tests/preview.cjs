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
  const packs = ['일상 인사', '작업 중', '오늘의 기분을 표현하는 아주 긴 이름의 디시콘 모음'].map((title, i) => ({
    info: {package_idx: i + 1, title, list_img_path: sample(String(i + 1), '#b6baff'), main_img_path: sample(String(i + 1), '#b6baff')},
    detail: ['안녕', '고마워', '좋아요', '잘자', '최고', '응원'].map((text, j) => ({idx: i * 10 + j, title: text, path: sample(text, ['#b6baff', '#a6e4cf', '#f4cf97'][i])})),
  }));
  const context = {module: {exports: {}}, structuredClone, window: {matchMedia: () => ({matches: false})}, BdApi: {
    React, Data: {load: (_, key) => key === 'dccons' ? packs : key === 'personalCons' ? packs[0].detail.slice(0, 3) : []},
    Webpack: {getByKeys: () => ({locale: 'ko'}), getModule: () => ({}), Filters: {byKeys: () => () => true}},
  }};
  require('./helpers/core.cjs').loadCore(context);
  const {Plugin, DCConPanel, DCConSettingsPanel, PersonalImage} = context.module.exports;
  // Supply preview assets directly; server rendering cannot load local image files.
  PersonalImage.prototype.render = function () { return React.createElement('img', {src: this.props.con.path, alt: this.props.con.title}); };
  class PersonalSettingsPanel extends DCConSettingsPanel {
    constructor(props) { super(props); this.state.activeTab = 'personal'; }
  }
  class SavedSettingsPanel extends DCConSettingsPanel {
    constructor(props) { super(props); this.state.activeTab = 'saved'; }
  }
  class ShopSettingsPanel extends DCConSettingsPanel {
    constructor(props) {
      super(props);
      this.state.activeTab = 'shop';
      this.state.searchQuery = '일상';
      this.state.searchResults = packs.map(pack => ({idx: String(pack.info.package_idx), name: pack.info.title, seller: '만든 사람', thumbId: pack.info.main_img_path}));
    }
  }
  const css = Object.getOwnPropertyDescriptor(Plugin.prototype, 'css').get.call({});
  const output = path.resolve(__dirname, '../artifacts/ui-previews');
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({...(process.env.WEBP_TEST_BROWSER ? {executablePath: process.env.WEBP_TEST_BROWSER} : {channel: 'chrome'}), headless: true, ignoreDefaultArgs: ['--hide-scrollbars']});
  try {
    const page = await browser.newPage();
    const managementLayouts = new Map();
    for (const [name, width, theme, management, scale = 1] of [
      ['dark', 620, 'theme-dark', false], ['light', 620, 'theme-light', false],
      ['narrow', 360, 'theme-dark', false], ['manage', 620, 'theme-dark', true], ['manage-narrow', 360, 'theme-dark', true],
      ['settings', 620, 'theme-dark', 'settings'], ['settings-narrow', 360, 'theme-dark', 'settings'],
      ['personal', 620, 'theme-dark', 'personal'], ['personal-narrow', 360, 'theme-dark', 'personal'],
      ['shop', 620, 'theme-dark', 'shop'], ['shop-narrow', 360, 'theme-dark', 'shop'],
      ['manage-scaled', 930, 'theme-dark', true, 1.5], ['personal-scaled', 930, 'theme-dark', 'personal', 1.5],
      ['shop-scaled', 930, 'theme-dark', 'shop', 1.5],
    ]) {
      await page.setViewportSize({width, height: 630 * scale});
      const markup = renderToStaticMarkup(React.createElement(management === 'shop' ? ShopSettingsPanel : management === 'personal' ? PersonalSettingsPanel : management === true ? SavedSettingsPanel : management ? DCConSettingsPanel : DCConPanel, {type: 'dccon', section: management === 'settings' ? 'settings' : 'packs'})).replaceAll('https://dccon-proxy.minibox.workers.dev/?no=', '');
      await page.setContent(`<html class="${theme}"><meta charset="utf-8"><style>body {background:${theme === 'theme-dark' ? '#313338' : '#fff'}; margin:0} button,input {color:black; font:13px serif} ${css}</style><section class="dccon-popover" style="left:8px;top:16px;height:580px;zoom:${scale}"><div class="dccon-popover-toolbar"><button aria-pressed="${!management}">내 디시콘</button><button aria-pressed="${management}">팩 추가 / 관리</button><button aria-pressed="${management === 'settings'}">설정</button><button>×</button></div><div class="dccon-popover-body">${markup}</div></section></html>`);
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => { image.loading = 'eager'; return image.decode(); }));
      });
      await page.screenshot({path: path.join(output, name + '.png')});
      const result = await page.evaluate(() => {
        const root = document.querySelector('.dccon-popover');
        const heading = document.querySelector('.dccon-category-name, .dccon-card-content h3, .dccon-user-settings h3');
        const rect = selector => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const {x, y, width, height} = element.getBoundingClientRect();
          return {x, y, width, height};
        };
        return {fits: root.scrollWidth <= root.clientWidth, color: getComputedStyle(heading).color, font: getComputedStyle(heading).fontFamily,
          toolbar: rect('.dccon-list-toolbar, .dccon-search-bar'), button: rect('.dccon-list-toolbar > button, .dccon-search-bar > button'), input: rect('.dccon-search-bar input'), card: rect('.dccon-card'), cardAction: rect('.dccon-pack-actions > button'),
          cardSpacing: [...document.querySelectorAll('.dccon-card')].map(card => {
            const bounds = card.getBoundingClientRect();
            return {height: bounds.height, bottomGaps: [...card.querySelectorAll('.dccon-card-thumbnail, .dccon-pack-actions button')].map(element => bounds.bottom - element.getBoundingClientRect().bottom)};
          })};
      });
      assert.equal(result.fits, true, name + ' must not overflow horizontally');
      assert.notEqual(result.color, 'rgb(0, 0, 0)', name + ' should use theme text color');
      if (result.toolbar && result.card) {
        const scrolling = await page.evaluate(() => {
          const body = document.querySelector('.dccon-popover-body');
          const list = document.querySelector('.dccon-search-results, .dccon-saved-container');
          const card = list.querySelector('.dccon-card').cloneNode(true);
          const bounds = () => {
            const {x, y, width, height} = document.querySelector('.dccon-list-toolbar > button').getBoundingClientRect();
            return {x, y, width, height};
          };
          list.replaceChildren();
          const empty = bounds();
          for (let i = 0; i < 12; i++) list.append(card.cloneNode(true));
          return {empty, full: bounds(), overflows: body.scrollHeight > body.clientHeight};
        });
        assert.ok(scrolling.overflows, name + ' must exercise a scrolling list');
        assert.deepEqual(scrolling.full, scrolling.empty, name + ' button must not move when a scrollbar appears');
        assert.equal(result.card.width, result.toolbar.width, name + ' cards must fit the toolbar width');
        const right = rect => rect.x + rect.width;
        assert.ok(Math.abs(right(result.button) - right(result.cardAction)) < 1, name + ' toolbar and card buttons must align on the right');
        if (result.input) {
          assert.equal(result.input.height - result.button.height, 2 * scale, name + ' button must be 2px shorter than the input');
          assert.equal(result.input.y + result.input.height / 2, result.button.y + result.button.height / 2, name + ' input and button centers must match');
          assert.ok(Math.abs(result.input.x - result.card.x - 12 * scale) < 1, name + ' input must align with card content');
        }
        const layout = {toolbar: result.toolbar, button: result.button, card: result.card};
        const key = `${width}:${scale}`;
        if (managementLayouts.has(key)) assert.deepEqual(layout, managementLayouts.get(key), name + ' must match the other management tabs');
        else managementLayouts.set(key, layout);
        for (const card of result.cardSpacing) {
          assert.equal(card.height, 96 * scale, name + ' card must fit its thumbnail');
          for (const gap of card.bottomGaps) assert.ok(Math.abs(gap - 12 * scale) < 1, name + ' thumbnail and buttons must have equal bottom padding');
        }
      }
      console.log(name, result);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
