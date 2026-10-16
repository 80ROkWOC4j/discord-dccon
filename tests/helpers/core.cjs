const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {buildSync} = require('esbuild');
const {root, buildSplitWorker} = require('../../scripts/build.cjs');
let source;
function fixtureBundle() {
  return source ??= buildSync({absWorkingDir: root, tsconfigRaw: {}, entryPoints: ['tests/fixtures/core.ts'],
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022'}).outputFiles[0].text;
}
function importCore(context) {
  context.module ||= {exports: {}};
  context.module.exports = {};
  vm.runInNewContext(fixtureBundle(), context);
  return context.module.exports;
}
function loadCore(context) {
  const api = importCore(context);
  const platform = context.DCConPlatform || api.createBetterDiscordPlatform(context.BdApi, context.require);
  const result = api.createHarness(platform, {splitWorkerSource: buildSplitWorker(), styles: fs.readFileSync(path.join(root, 'src/core/style.css'), 'utf8')});
  context.module.exports = result;
  return result;
}
module.exports = {loadCore, importCore, fixtureBundle};
