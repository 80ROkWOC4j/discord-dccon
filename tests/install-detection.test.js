const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const pwsh = process.env.DCCON_TEST_PWSH || 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const original = 'module.exports = require("./core.asar");\n';
const betterdiscord = 'require("/BetterDiscord/data/betterdiscord.asar");\n' + original;
const hash = text => createHash('sha256').update(text).digest('hex');
async function put(file, content = '') {await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, content);}

for (const platform of ['mac', 'windows']) test(`${platform}: detect current injection, refuse conflicts, ignore leftovers`, {
  skip: platform === 'mac' ? process.platform !== 'darwin' : !hasPwsh,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dccon-detection-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const app = path.join(dir, 'Discord.app'), root = path.join(dir, 'Discord');
  const appData = path.join(dir, 'Application Support'), data = path.join(appData, 'discord'), bd = path.join(appData, 'BetterDiscord');
  const resources = platform === 'mac' ? path.join(app, 'Contents/Resources') : path.join(root, 'app-0.0.415/resources');
  const core = path.join(data, 'app-0.0.415/modules/discord_desktop_core-1/discord_desktop_core');
  await put(path.join(resources, 'build_info.json'), '{"version":"0.0.415"}');
  await put(path.join(resources, 'app.asar'), 'original app');
  await put(path.join(core, 'index.js'), original);
  await put(path.join(core, 'core.asar'));
  await put(path.join(data, 'settings.json'), '{"UPDATE_ENDPOINT":null,"unrelated":null}');
  await fs.mkdir(path.join(bd, 'plugins'), {recursive:true}); // A leftover folder is not injection.
  let command, args;
  if (platform === 'mac') {
    const source = await fs.readFile(path.join(repo, 'install.sh'), 'utf8');
    const script = path.join(dir, 'detect.sh');
    await put(script, source.split('# Online entry point.')[0] + '\ndetect_installation "$@"\n');
    command = 'bash'; args = [script, app, data, bd];
  } else {
    const source = await fs.readFile(path.join(repo, 'install.ps1'), 'utf8');
    const script = path.join(dir, 'detect.ps1');
    await put(script, "$ErrorActionPreference = 'Stop'\n" + source.slice(source.indexOf('function Get-DesktopCoreEntries'), source.indexOf('\nif (!$DiscordRoot)')) + '\nGet-InstallationMode $args[0] $args[1]\n');
    command = pwsh; args = ['-NoProfile', '-File', script, root, data];
  }
  const detect = expected => {
    const result = spawnSync(command, args, {encoding:'utf8', env:{...process.env, APPDATA:appData}});
    if (expected) {assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);}
    else assert.notEqual(result.status, 0, result.stdout);
  };
  detect('Standalone');
  await put(path.join(data, 'app-0.0.414/modules/discord_desktop_core-1/discord_desktop_core/index.js'), betterdiscord);
  detect('Standalone'); // Ignore an old host version.
  await put(path.join(core, 'index.js'), betterdiscord);
  detect(null); // Broken BetterDiscord must not fall back.
  await put(path.join(bd, 'data/betterdiscord.asar'));
  detect('BetterDiscord');
  await put(path.join(data, 'settings.json'), '{"UPDATE_ENDPOINT":"https://inject.example/shelter"}');
  detect(null);
  await put(path.join(data, 'settings.json'), '{}');
  await put(path.join(core, 'index.js'), 'require("./another-mod");\n' + original);
  detect(null);
  await put(path.join(core, 'index.js'), original);
  await fs.rename(path.join(resources, 'app.asar'), path.join(resources, 'betterdiscord.app.asar'));
  await put(path.join(resources, 'app/index.js'), 'require("/BetterDiscord/data/betterdiscord.asar");\nmodule.exports=require("../betterdiscord.app.asar");');
  detect('BetterDiscord');
  await put(path.join(core, 'index.js'), betterdiscord);
  detect(null); // Double injection.
  await put(path.join(core, 'index.js'), original);
  await fs.rename(path.join(resources, 'betterdiscord.app.asar'), path.join(resources, 'app.asar'));
  detect(null); // Stale app/ with a live app.asar is ambiguous.
  await fs.rm(path.join(resources, 'app'), {recursive:true});
  if (platform === 'mac') {
    const installed = path.join(core, 'discord-dccon');
    const loader = 'require("./discord-dccon/runtime/main.cjs");\n' + original;
    await put(path.join(installed, 'original.js'), original);
    await put(path.join(installed, 'original.sha256'), hash(original));
    await put(path.join(installed, 'loader.sha256'), hash(loader));
    await put(path.join(core, 'index.js'), loader);
    detect('Standalone');
    await put(path.join(core, 'index.js'), loader + '// modified');
    detect(null);
  } else {
    await fs.rename(path.join(resources, 'app.asar'), path.join(resources, 'discord-dccon-original.asar'));
    await put(path.join(resources, 'app/discord-dccon-install.json'), '{"kind":"discord-dccon-standalone"}');
    detect(null); // An incomplete legacy record must not be accepted for cleanup.
    await put(path.join(core, 'index.js'), betterdiscord);
    detect(null);
  }
});
