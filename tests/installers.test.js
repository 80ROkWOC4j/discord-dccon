const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const repo = path.resolve(__dirname, '..');
before(() => {
  if (process.platform !== 'win32') return;
  const built = spawnSync(process.execPath, ['shelter/build.cjs'], {cwd: repo, encoding: 'utf8'});
  assert.equal(built.status, 0, built.stderr);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-dccon-install-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const resources = path.join(dir, 'app-1.0.1/resources');
  await fs.mkdir(resources, {recursive: true});
  await fs.writeFile(path.join(resources, 'app.asar'), 'original Discord archive');
  const appData = path.join(dir, 'roaming'), plugins = path.join(appData, 'BetterDiscord/plugins');
  await fs.mkdir(plugins, {recursive: true});
  const wrapper = path.join(dir, 'installer-test.ps1');
  await fs.writeFile(wrapper, `param([switch]$Corrupt, [switch]$Missing, [switch]$ShortPath)
$ErrorActionPreference='Stop'
if ($ShortPath) {
  $folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder((Split-Path $env:DCCON_TEST_PROCESS))
  $env:DCCON_TEST_PROCESS = Join-Path $folder.ShortPath (Split-Path $env:DCCON_TEST_PROCESS -Leaf)
}
function Get-Process {
  param($Name,$ErrorAction)
  if ($env:DCCON_TEST_PROCESS) {
    if ($Name -notcontains 'DiscordCanary') {throw 'Canary process was not checked'}
    [pscustomobject]@{Path=$env:DCCON_TEST_PROCESS}
  }
}
function Invoke-RestMethod {
  param($Uri,$Headers)
  if ($Uri -ne 'https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases/latest') {throw 'Wrong API endpoint'}
  $names = if ($Missing) {@()} else {@('discord-dccon-betterdiscord.zip','discord-dccon-standalone.zip','checksums.json')}
  return @{tag_name='v3.0.0';assets=@($names | ForEach-Object {@{name=$_;browser_download_url="https://github.com/80ROkWOC4j/discord-dccon/releases/download/v3.0.0/$_"}})}
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing,$Uri,$Headers,$OutFile)
  $name = ([uri]$Uri).Segments[-1]
  Copy-Item -LiteralPath (Join-Path $env:DCCON_TEST_DIST $name) -Destination $OutFile
  if ($Corrupt -and $name.EndsWith('.zip')) {Add-Content -LiteralPath $OutFile -Value 'corrupt'}
}
& $env:DCCON_TEST_INSTALLER @args
`);
  const env = {...process.env, APPDATA: appData, LOCALAPPDATA: dir, TEMP: dir, TMP: dir,
    DCCON_TEST_DIST: path.join(repo, 'artifacts/dist'), DCCON_TEST_INSTALLER: path.join(repo, 'install.ps1'), DCCON_TEST_PROCESS: ''};
  // PowerShell 7's inherited module paths prevent Windows PowerShell from loading its own cmdlets.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const run = (args = [], success = true, shell = 'pwsh') => {
    const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, ...args], {cwd: repo, env, encoding: 'utf8'});
    if (success) assert.equal(result.status, 0, result.stderr || String(result.error));
    else assert.notEqual(result.status, 0);
    return result;
  };
  return {dir, resources, appData, plugins, env, run};
}
async function installBetterDiscordFixture({resources, appData}) {
  await fs.rename(path.join(resources, 'app.asar'), path.join(resources, 'betterdiscord.app.asar'));
  await fs.mkdir(path.join(resources, 'app'));
  await fs.writeFile(path.join(resources, 'app/index.js'), "require('betterdiscord.asar');");
  await fs.mkdir(path.join(appData, 'BetterDiscord/data'), {recursive: true});
  await fs.writeFile(path.join(appData, 'BetterDiscord/data/betterdiscord.asar'), 'BetterDiscord runtime');
}

test('standalone package installs, updates, restores vanilla archive and preserves old loaders', {skip: process.platform !== 'win32'}, async t => {
  const {dir, resources, run} = await fixture(t);
  run(['-DiscordRoot', dir]);
  assert.equal(await fs.readFile(path.join(resources, 'discord-dccon-original.asar'), 'utf8'), 'original Discord archive');
  assert.match(await fs.readFile(path.join(resources, 'app/index.js'), 'utf8'), /discord-dccon-original\.asar/);
  await fs.writeFile(path.join(resources, 'app/keep-me.txt'), 'user file');
  for (const file of ['bootstrap.js', 'main.cjs', 'preload.cjs', 'native.js', 'shared-storage.cjs'])
    assert.deepEqual(await fs.readFile(path.join(resources, 'app/runtime', file)), await fs.readFile(path.join(repo, 'artifacts/dist/standalone/runtime', file)));
  run(['-DiscordRoot', dir]);
  const previous = (await fs.readdir(resources)).find(name => name.startsWith('discord-dccon-previous-'));
  assert.equal(await fs.readFile(path.join(resources, previous, 'keep-me.txt'), 'utf8'), 'user file');
  run(['-DiscordRoot', dir, '-Restore']);
  assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), 'original Discord archive');
  await assert.rejects(fs.access(path.join(resources, 'app')));
});

test('standalone refuses existing mods and refuses restoring a modified loader', {skip: process.platform !== 'win32'}, async t => {
  const {dir, resources, run} = await fixture(t);
  await fs.mkdir(path.join(resources, 'app'));
  await fs.writeFile(path.join(resources, 'app/index.js'), 'other mod');
  assert.match(run(['-DiscordRoot', dir], false).stderr, /Unknown or inactive Discord app loader/);
  assert.equal(await fs.readFile(path.join(resources, 'app/index.js'), 'utf8'), 'other mod');
  await fs.rename(path.join(resources, 'app'), path.join(resources, 'other-mod'));
  run(['-DiscordRoot', dir]);
  await fs.appendFile(path.join(resources, 'app/index.js'), '\n// external edit');
  assert.match(run(['-DiscordRoot', dir, '-Restore'], false).stderr, /Modified loader/);
  assert.equal(await fs.readFile(path.join(resources, 'discord-dccon-original.asar'), 'utf8'), 'original Discord archive');
});

test('Canary selects its default directory, leaves Stable untouched, and blocks running Canary', {skip: process.platform !== 'win32'}, async t => {
  const {dir, env, run} = await fixture(t);
  for (const client of ['Discord', 'DiscordCanary']) {
    const resources = path.join(dir, client, 'app-1.0.1/resources');
    await fs.mkdir(resources, {recursive: true});
    await fs.writeFile(path.join(resources, 'app.asar'), client);
  }
  env.DCCON_TEST_PROCESS = path.join(dir, 'Discord/app-1.0.1/Discord.exe');
  const invoke = (args, success = true) => run(['-Channel', 'Canary', ...args], success);
  invoke([]);
  const canary = path.join(dir, 'DiscordCanary/app-1.0.1/resources');
  assert.equal(JSON.parse(await fs.readFile(path.join(canary, 'app/discord-dccon-install.json'), 'utf8')).channel, 'Canary');
  assert.equal(await fs.readFile(path.join(dir, 'Discord/app-1.0.1/resources/app.asar'), 'utf8'), 'Discord');
  env.DCCON_TEST_PROCESS = path.join(dir, 'DiscordCanary/app-1.0.1/DiscordCanary.exe');
  for (const args of [['-Remove'], ['-Remove', '-ShortPath']]) {
    const result = invoke(args, false);
    assert.match(result.stderr, /Fully quit Discord Canary/);
    await fs.access(path.join(canary, 'app/index.js'));
  }
  env.DCCON_TEST_PROCESS = '';
  invoke(['-Remove']);
  assert.equal(await fs.readFile(path.join(canary, 'app.asar'), 'utf8'), 'DiscordCanary');
});

test('BetterDiscord package changes only the plugin and retains previous plugin', {skip: process.platform !== 'win32'}, async t => {
  const context = await fixture(t), {dir, plugins, run} = context;
  await installBetterDiscordFixture(context);
  await fs.writeFile(path.join(plugins, 'discord-dccon.plugin.js'), 'old plugin');
  await fs.writeFile(path.join(plugins, 'discord-dccon.config.json'), '{"favorites":[1]}');
  run(['-DiscordRoot', dir, '-PluginsDirectory', plugins]);
  run(['-DiscordRoot', dir, '-PluginsDirectory', plugins]);
  assert.equal(await fs.readFile(path.join(plugins, 'discord-dccon.config.json'), 'utf8'), '{"favorites":[1]}');
  const backups = (await fs.readdir(plugins)).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(plugins, backups[0]), 'utf8'), 'old plugin');
  assert.equal(await fs.readFile(path.join(plugins, 'discord-dccon.plugin.js'), 'utf8'), await fs.readFile(path.join(repo, 'discord-dccon.plugin.js'), 'utf8'));
});

test('online command installs both modes on Windows PowerShell 5.1 and rejects corrupt downloads', {skip: process.platform !== 'win32'}, async t => {
  const standalone = await fixture(t), bd = await fixture(t);
  const {dir, resources} = standalone, {plugins} = bd;
  await installBetterDiscordFixture(bd);
  await fs.writeFile(path.join(plugins, 'discord-dccon.config.json'), '{"preserved":true}');
  const online = (mode, args = [], success = true) => {
    const context = mode === 'BetterDiscord' ? bd : standalone;
    return context.run(['-Mode', mode, '-DiscordRoot', context.dir, '-PluginsDirectory', context.plugins, ...args], success, 'powershell.exe');
  };
  assert.match(online('Standalone', ['-Missing'], false).stderr, /missing/);
  assert.match(online('Standalone', ['-Corrupt'], false).stderr, /checksum mismatch/);
  assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), 'original Discord archive');
  assert.match(standalone.run(['-DiscordRoot', dir, '-Mode', 'BetterDiscord'], false).stderr, /Detected Standalone; requested BetterDiscord/);
  assert.match(bd.run(['-DiscordRoot', bd.dir, '-Mode', 'Standalone'], false).stderr, /Detected BetterDiscord; requested Standalone/);
  online('BetterDiscord');
  online('BetterDiscord'); // An already-installed child exits successfully without skipping cleanup.
  assert.equal(await fs.readFile(path.join(plugins, 'discord-dccon.config.json'), 'utf8'), '{"preserved":true}');
  online('Standalone');
  await fs.access(path.join(resources, 'app/runtime/bootstrap.js'));
  await fs.access(path.join(resources, 'app/runtime/shared-storage.cjs'));
  online('Standalone', ['-Remove']);
  online('Standalone', ['-Channel', 'Canary']);
  assert.equal(JSON.parse(await fs.readFile(path.join(resources, 'app/runtime/channel.json'), 'utf8')).channel, 'Canary');
  online('Standalone', ['-Channel', 'Canary', '-Restore']);
  assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), 'original Discord archive');
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('discord-dccon-install-')).length, 0);
  assert.equal((await fs.readdir(bd.dir)).filter(name => name.startsWith('discord-dccon-install-')).length, 0);
});
