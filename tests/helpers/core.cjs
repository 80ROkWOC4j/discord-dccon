// Legacy unit fixtures inspect private functions. Compile the editable TS source
// in an isolated VM scope; never reverse-engineer a distribution bundle.
const fs = require('node:fs');
const path = require('node:path');
const {buildSync, transformSync} = require('esbuild');
const {root, buildSplitWorker} = require('../../scripts/build.cjs');
let cached;
function coreSource() {
  if (cached) return cached;
  const source = fs.readFileSync(path.join(root, 'src/core/plugin.ts'), 'utf8');
  const body = source.slice(source.indexOf('const DCConBaseURL'), source.lastIndexOf('return DCCon;'));
  const workers = fs.readFileSync(path.join(root, 'src/core/workers.ts'), 'utf8').replace(/^import type .*;\n/gm, '').replace(/^export /gm, '');
  const adapter = buildSync({absWorkingDir: root, tsconfigRaw: {}, entryPoints: ['src/platform/betterdiscord.ts'],
    bundle: true, write: false, format: 'iife', globalName: 'DCConPlatformAdapters', platform: 'browser', target: 'es2022'}).outputFiles[0].text;
  const prefix = `${adapter}\nconst platform = typeof DCConPlatform !== 'undefined' ? DCConPlatform : DCConPlatformAdapters.createBetterDiscordPlatform(BdApi,typeof require === 'function' ? require : undefined);
const styles=${JSON.stringify(fs.readFileSync(path.join(root, 'src/core/style.css'), 'utf8'))};
const SPLIT_WORKER_SOURCE=${JSON.stringify(buildSplitWorker())};\n`;
  cached = prefix + transformSync(workers + '\n' + body + '\nmodule.exports=DCCon;', {loader: 'ts', target: 'es2022', tsconfigRaw: {}}).code;
  return cached;
}
function shelterLifecycleSource() {
  const source = fs.readFileSync(path.join(root, 'src/entries/shelter.ts'), 'utf8');
  const start = source.indexOf('export function');
  return transformSync(source.slice(start).replace('export function', 'function'), {loader: 'ts', target: 'es2022', tsconfigRaw: {}}).code +
    '\ncreateShelterPlugin(shelter,DCConNative,dcconWebpack,dcconVersion)';
}
module.exports = {coreSource, shelterLifecycleSource};
