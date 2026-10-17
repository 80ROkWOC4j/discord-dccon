const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {buildBetterDiscord, buildShelterPlugin, buildStorage} = require('../scripts/build.cjs');
const output = path.resolve(__dirname, '../artifacts/shelter');
async function main() {
  const source = buildBetterDiscord();
  await fs.mkdir(output, {recursive: true});
  const dependency = path.resolve(__dirname, '../vendor/shelter');
  let shelter;
  try {shelter = await fs.readFile(path.join(dependency, 'shelter.js'), 'utf8');}
  catch {throw Error('Initialize shelter first: git submodule update --init --recursive');}
  const revision = execFileSync('git', ['-C', dependency, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  new vm.Script(shelter);
  const read = name => fs.readFile(path.join(__dirname, name), 'utf8');
  const version = JSON.parse(await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8')).version;
  const plugin = buildShelterPlugin(version);
  new vm.Script(plugin);
  // The shared plugin source receives its platform API without modifying globals.
  const bootstrap = `(() => {\n${await read('webpack.js')}\nlet shelterRequire;\n` +
    `const dcconWebpack=captureWebpack(globalThis,DCConNative.hostMod==='vencord'?()=>globalThis.Vencord?.Webpack?.wreq:` +
    `DCConNative.hostMod==='shelter'?()=>shelterRequire ||= findWebpackRequire(globalThis,globalThis.shelter?.flux?.storesFlat.SelectedChannelStore):undefined);\n` +
    // The plugin ID also namespaces shelter storage.
    `const plugin={js:${JSON.stringify(plugin)},local:true,update:false,` +
    `manifest:{name:'discord-dccon',author:'80ROkWOC4j',description:'discord-dccon running on shelter'},` +
    `injectorIntegration:{isVisible:true,allowedActions:{toggle:true},loaderName:'discord-dccon'}};\n` +
    // shelter evals plugins in the global scope, so provide the captured module index explicitly.
    `globalThis.dcconWebpack=dcconWebpack;\n` +
    `if(DCConNative.hostMod==='shelter'){SHELTER_INJECTOR_PLUGINS['discord-dccon']=plugin;}else{\n` +
    `const SHELTER_INJECTOR_PLUGINS={'discord-dccon':plugin};\n${shelter}\n}\n})();`;
  new vm.Script(bootstrap);
  await fs.writeFile(path.join(output, 'bootstrap.js'), bootstrap);
  for (const name of ['main.cjs', 'preload.cjs', 'native.js']) await fs.copyFile(path.join(__dirname, name), path.join(output, name));
  await fs.writeFile(path.join(output, 'shared-storage.cjs'), buildStorage());
  const packages = path.resolve(__dirname, '../artifacts/dist');
  const standalone = path.join(packages, 'standalone'), betterdiscord = path.join(packages, 'betterdiscord');
  // Rebuild staging directories so renamed files cannot remain in release archives.
  for (const directory of [standalone, betterdiscord]) {
    if (path.dirname(directory) !== packages) throw Error('Unexpected package staging path');
    await fs.rm(directory, {recursive: true, force: true});
  }
  await fs.mkdir(path.join(standalone, 'runtime'), {recursive: true});
  await fs.mkdir(betterdiscord, {recursive: true});
  for (const name of ['bootstrap.js', 'main.cjs', 'preload.cjs', 'native.js', 'shared-storage.cjs']) {
    await fs.copyFile(path.join(output, name), path.join(standalone, 'runtime', name));
  }
  await fs.writeFile(path.join(betterdiscord, 'discord-dccon.plugin.js'), source);
  for (const directory of [standalone, betterdiscord]) await fs.copyFile(path.resolve(__dirname, '../LICENSE'), path.join(directory, 'LICENSE'));
  for (const directory of [standalone, betterdiscord]) await fs.copyFile(path.resolve(__dirname, '../THIRD_PARTY_NOTICES.md'), path.join(directory, 'THIRD_PARTY_NOTICES.md'));
  await fs.writeFile(path.join(standalone, 'shelter-version.json'), JSON.stringify({
    installLayout: 'desktop_core', channels: ['Stable', 'PTB', 'Canary'], hostMods: ['vencord', 'shelter'],
    revision, source: 'https://github.com/uwu/shelter', builds: 'https://github.com/uwu/shelter-builds', license: 'CC0-1.0',
  }, null, 2) + '\n');
  if (!process.argv.includes('--stage-only')) execFileSync('pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'package.ps1')], {stdio: 'inherit'});
  console.log(`Built discord-dccon: ${output}\nShelter submodule: ${revision}`);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
