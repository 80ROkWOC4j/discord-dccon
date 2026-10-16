const path = require('node:path');
const {buildSync} = require('esbuild');
const root = path.resolve(__dirname, '..');
function bundlePlatform(name) {
  return buildSync({absWorkingDir: root, tsconfigRaw: {}, entryPoints: [`platform/${name}.ts`], bundle: true,
    write: false, format: 'iife', globalName: 'DCConPlatformAdapters', platform: 'browser', target: 'es2022'}).outputFiles[0].text;
}
const platformPattern = /\/\/ BEGIN GENERATED PLATFORM[\s\S]*?\/\/ END GENERATED PLATFORM/;
function coreSource(source) {
  if (!platformPattern.test(source)) throw Error('Missing platform insertion marker');
  return source.replace(platformPattern, 'const platform = DCConPlatform;');
}
module.exports = {bundlePlatform, coreSource};
