const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const root = path.resolve(__dirname, '..');
const result = buildSync({
  absWorkingDir: root, entryPoints: ['scripts/split-worker.js'], bundle: true, write: false,
  format: 'esm', platform: 'browser', minify: true, legalComments: 'inline',
  inject: ['scripts/split-buffer.js'], external: ['fs', 'path', 'util'],
  define: {window: 'globalThis'},
});
// Embed only JS; the pinned WASM binary uses the existing verified on-disk codec cache.
const block = '// BEGIN GENERATED SPLIT WORKER\nconst SPLIT_WORKER_SOURCE = ' +
  JSON.stringify(result.outputFiles[0].text) + ';\n// END GENERATED SPLIT WORKER';
const file = path.join(root, 'discord-dccon.plugin.js');
const original = fs.readFileSync(file, 'utf8');
const pattern = /\/\/ BEGIN GENERATED SPLIT WORKER[\s\S]*?\/\/ END GENERATED SPLIT WORKER/;
let updated = pattern.test(original) ? original.replace(pattern, () => block)
  : original.replace('// Pinned libwebp WASM tools.', block + '\n\n// Pinned libwebp WASM tools.');
if (updated === original && !pattern.test(original)) throw Error('Missing worker insertion marker');
const migrationBlock = '// BEGIN GENERATED SHARED STORAGE\nconst SHARED_STORAGE_SOURCE = ' +
  JSON.stringify(fs.readFileSync(path.join(root, 'scripts/shared-storage.cjs'), 'utf8')) + ';\n// END GENERATED SHARED STORAGE';
const migrationPattern = /\/\/ BEGIN GENERATED SHARED STORAGE[\s\S]*?\/\/ END GENERATED SHARED STORAGE/;
updated = migrationPattern.test(updated) ? updated.replace(migrationPattern, () => migrationBlock)
  : updated.replace('// Pinned libwebp WASM tools.', migrationBlock + '\n\n// Pinned libwebp WASM tools.');
if (updated !== original) {
  // Installer tests build packages while other test processes read this file.
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, updated);
    fs.renameSync(temporary, file);
  } finally {fs.rmSync(temporary, {force: true});}
}
