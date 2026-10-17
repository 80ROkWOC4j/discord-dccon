const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const original = 'module.exports = require("./core.asar");\n';
const loader = 'require("./discord-dccon/runtime/main.cjs");\n' + original;
const uuid = '12345678-1234-1234-1234-123456789abc';
async function put(file, value = 'fixture') {await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, value);}
async function exists(file) {return fs.access(file).then(() => true, () => false);}
async function temp(t) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dccon-purge-')); t.after(() => fs.rm(dir, {recursive: true, force: true})); return dir;}
async function dataFixtures(support) {
  const targets = ['discord-dccon', 'discord-dccon-canary', 'DCCon-shelter', 'DCCon-shelter-poc',
    'BetterDiscord/plugins/discord-dccon-cache', 'BetterDiscord/plugins/discord-dccon-library', 'BetterDiscord/plugins/DCCon-cache'];
  for (const name of targets) await put(path.join(support, name, 'keep-until-purge'));
  for (const name of ['DCCon.plugin.js', 'DCCon.config.json', 'discord-dccon.plugin.js', 'discord-dccon.config.json']) {
    targets.push('BetterDiscord/plugins/' + name); await put(path.join(support, targets.at(-1)));
  }
  const preserved = ['BetterDiscord/plugins/other.plugin.js', 'BetterDiscord/data/betterdiscord.asar', 'discord/settings.json',
    'discord/IndexedDB/other-data', 'Vencord/settings/settings.json', 'BetterDiscord/plugins/discord-dccon-not-ours'];
  for (const name of preserved) await put(path.join(support, name));
  return {targets, preserved};
}
async function coreFixture(core, channel, mac = false) {
  const addon = path.join(core, 'discord-dccon');
  await put(path.join(core, 'index.js'), loader); await put(path.join(core, 'core.asar'), 'vendor');
  await put(path.join(addon, 'original.js'), original); await put(path.join(addon, 'index.js'), loader);
  await put(path.join(addon, 'runtime/bootstrap.js'));
  if (mac) {
    await put(path.join(addon, 'original.sha256'), hash(original)); await put(path.join(addon, 'loader.sha256'), hash(loader));
  } else await put(path.join(addon, 'discord-dccon-install.json'), JSON.stringify({kind: 'discord-dccon-core', channel, originalHash: hash(original), loaderHash: hash(loader)}));
  return addon;
}
for (const shell of (process.platform === 'win32' ? ['pwsh', 'powershell.exe'] : ['pwsh'])) {
  const available = spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`Windows purge previews, restores all versions, preserves unrelated data and rejects unsafe targets (${shell})`, {skip: !available}, async t => {
    const dir = await temp(t), support = path.join(dir, "Roaming O'Brien"), local = path.join(dir, 'Local');
    const source = await fs.readFile(path.join(repo, 'install.ps1'), 'utf8'), split = source.indexOf('$Mode = switch ($Mode)');
    const script = path.join(dir, 'install.ps1');
    await put(script, source.slice(0, split) + `
function Get-Process { param($Name,$ErrorAction) if ($env:DCCON_RUNNING) { [pscustomobject]@{Path='fixture'} } }
function Read-Host { param($Prompt) return $env:DCCON_ANSWER }
function Invoke-RestMethod { throw 'Purge must be offline' }
function Move-Item {
 param($LiteralPath,$Destination)
 if ($env:DCCON_FAIL_RESTORE -and $LiteralPath -like '*original.asar') {throw 'Injected restore failure'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
function Remove-Item {
 param($LiteralPath,[switch]$Recurse,[switch]$Force)
 if ($env:DCCON_FAIL_DELETE -and $LiteralPath -like '*DCCon-shelter') {throw 'Injected delete failure'}
 Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}
` + source.slice(split));
    const env = {...process.env, APPDATA: support, LOCALAPPDATA: local, DCCON_ANSWER: 'no'};
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const customPlugins = path.join(dir, 'Custom [plugins]');
    await put(path.join(customPlugins, 'discord-dccon.config.json')); await put(path.join(customPlugins, 'other.plugin.js'));
    const run = (args, ok = true) => {
      const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-pluginsdirectory', customPlugins, ...args], {env, encoding: 'utf8'});
      assert.equal(result.status === 0, ok, result.stdout + result.stderr); return result.stdout + result.stderr;
    };
    const {targets, preserved} = await dataFixtures(support), cores = [];
    for (const [client, channel] of [['Discord', 'Stable'], ['DiscordPTB', 'PTB'], ['DiscordCanary', 'Canary']]) {
      for (const version of ['app-1.0.1', 'app-1.0.2']) {
        const base = version.endsWith('1') ? path.join(local, client) : path.join(support, client.toLowerCase());
        const core = path.join(base, version, 'modules/discord_desktop_core-1/discord_desktop_core');
        cores.push(core); const addon = await coreFixture(core, channel);
        await fs.cp(addon, path.join(core, 'discord-dccon-previous-' + uuid.replaceAll('-', '')), {recursive: true});
      }
    }
    const resources = path.join(local, 'Discord/app-0.0.9/resources'), legacy = path.join(resources, 'app');
    await put(path.join(legacy, 'index.js'), 'legacy loader'); await put(path.join(legacy, 'package.json'), '{}');
    await put(path.join(resources, 'dccon-original.asar'), 'old vendor');
    await put(path.join(legacy, 'dccon-install.json'), JSON.stringify({kind: 'dccon-standalone', originalHash: hash('old vendor'), 'index.js': hash('legacy loader'), 'package.json': hash('{}')}));
    const backup = path.join(support, 'BetterDiscord/plugins/DCCon.plugin.js.backup-' + uuid.replaceAll('-', ''));
    await put(backup);
    const preview = run(['-purge', '-dryrun']); assert.match(preview, /Dry run/); assert.match(preview, /dccon-original|resources[\\/]app/);
    const archivedEntry = path.join(cores[0], 'discord-dccon-previous-' + uuid.replaceAll('-', ''), 'index.js');
    await fs.appendFile(archivedEntry, 'modified'); assert.match(run(['-purge', '-yes'], false), /Modified runtime archive/); await put(archivedEntry, loader);
    assert.match(run(['-purge']), /Cancelled/); assert.equal(await exists(backup), true);
    for (const core of cores) assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), loader);
    run(['-purge', '-channel', 'stable', '-yes'], false);
    env.DCCON_RUNNING = '1'; assert.match(run(['-purge', '-yes'], false), /Fully quit all/); delete env.DCCON_RUNNING;
    await fs.appendFile(path.join(cores[0], 'index.js'), 'modified');
    assert.match(run(['-purge', '-yes'], false), /Modified desktop_core/);
    assert.equal(await exists(path.join(support, targets[0])), true); await put(path.join(cores[0], 'index.js'), loader);
    const missingAddon = path.join(cores[0], 'discord-dccon'), savedAddon = path.join(dir, 'saved-addon');
    await fs.rename(missingAddon, savedAddon); assert.match(run(['-purge', '-yes'], false), /Missing standalone backup/); await fs.rename(savedAddon, missingAddon);
    const outside = path.join(dir, 'outside'), link = path.join(support, 'discord-dccon/cache-link');
    await put(path.join(outside, 'important'));
    await fs.symlink(outside, link, 'junction');
    assert.match(run(['-purge', '-yes'], false), /Linked path/);
    assert.equal(await exists(path.join(outside, 'important')), true); await fs.rm(link);
    env.DCCON_FAIL_RESTORE = '1'; assert.match(run(['-purge', '-yes'], false), /Injected restore failure/); delete env.DCCON_FAIL_RESTORE;
    assert.equal(await exists(legacy), true); assert.equal(await exists(path.join(resources, 'dccon-original.asar')), true);
    assert.equal(await exists(path.join(support, targets[0])), true);
    env.DCCON_FAIL_DELETE = '1'; assert.match(run(['-purge', '-yes'], false), /Injected delete failure/); delete env.DCCON_FAIL_DELETE;
    assert.equal(await exists(path.join(support, 'DCCon-shelter')), true);
    assert.equal(await exists(path.join(support, 'discord-dccon')), false);
    run(['-purge', '-yes']);
    for (const core of cores) {
      assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
      assert.equal(await fs.readFile(path.join(core, 'core.asar'), 'utf8'), 'vendor');
      assert.deepEqual((await fs.readdir(core)).sort(), ['core.asar', 'index.js']);
    }
    assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), 'old vendor');
    assert.deepEqual(await fs.readdir(resources), ['app.asar']);
    for (const name of targets) assert.equal(await exists(path.join(support, name)), false, name);
    assert.equal(await exists(backup), false);
    assert.equal(await exists(path.join(customPlugins, 'discord-dccon.config.json')), false);
    assert.equal(await fs.readFile(path.join(customPlugins, 'other.plugin.js'), 'utf8'), 'fixture');
    for (const name of preserved) assert.equal(await fs.readFile(path.join(support, name), 'utf8'), 'fixture', name);
    assert.match(run(['-purge', '-yes']), /No known filesystem/);
  });
}

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const hasBash = spawnSync(bash, ['-c', 'exit 0']).status === 0;
const unixPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
test('macOS purge shell restores historical cores and removes only its own paths', {skip: !hasBash}, async t => {
  const dir = await temp(t), home = path.join(dir, 'home'), support = path.join(home, 'Library/Application Support');
  const {targets, preserved} = await dataFixtures(support), cores = [];
  for (const client of ['discord', 'discordptb', 'discordcanary']) for (const version of ['app-1.0.1', '1.0.2']) {
    const core = path.join(support, client, version, 'modules/discord_desktop_core'); cores.push(core);
    const addon = await coreFixture(core, 'Stable', true);
    await fs.cp(addon, path.join(core, 'discord-dccon-previous-' + uuid), {recursive: true});
  }
  const backup = path.join(support, 'BetterDiscord/plugins/discord-dccon.plugin.js.removed-' + uuid); await put(backup);
  // Exercise the actual shell CLI in temporary roots. Only platform services are
  // substituted when running on Windows/Linux; no user's installation is accessed.
  const source = await fs.readFile(path.join(repo, 'install.sh'), 'utf8'), split = source.indexOf('# Online entry point.');
  const script = path.join(dir, 'install.sh');
  await put(script, source.slice(0, split) + `
uname() { printf 'Darwin\\n'; }
pgrep() { [[ -n "\${DCCON_RUNNING:-}" ]]; }
uuidgen() { printf '${uuid}\\n'; }
hash() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
curl() { echo 'Purge must be offline' >&2; return 99; }
` + source.slice(split));
  const env = {...process.env, HOME: unixPath(home)};
  const run = (args, ok = true) => {
    const result = spawnSync(bash, [unixPath(script), ...args], {env, encoding: 'utf8'});
    assert.equal(result.status === 0, ok, result.stdout + result.stderr); return result.stdout + result.stderr;
  };
  assert.match(run(['--purge', '--dry-run']), /Dry run/);
  for (const core of cores) assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), loader);
  run(['--purge', '--channel', 'stable', '--yes'], false);
  env.DCCON_RUNNING = '1'; assert.match(run(['--purge', '--yes'], false), /Fully quit all/); delete env.DCCON_RUNNING;
  await fs.appendFile(path.join(cores[0], 'index.js'), 'modified');
  assert.match(run(['--purge', '--yes'], false), /modified/); await put(path.join(cores[0], 'index.js'), loader);
  const missingAddon = path.join(cores[0], 'discord-dccon'), savedAddon = path.join(dir, 'saved-addon');
  await fs.rename(missingAddon, savedAddon); assert.match(run(['--purge', '--yes'], false), /Missing standalone backup/); await fs.rename(savedAddon, missingAddon);
  const outside = path.join(dir, 'outside'), link = path.join(support, 'discord-dccon/cache-link');
  await put(path.join(outside, 'important')); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(run(['--purge', '--yes'], false), /Linked path/);
  assert.equal(await exists(path.join(outside, 'important')), true); await fs.rm(link);
  run(['--purge', '--yes']);
  for (const core of cores) {
    assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
    assert.deepEqual((await fs.readdir(core)).sort(), ['core.asar', 'index.js']);
  }
  for (const name of targets) assert.equal(await exists(path.join(support, name)), false, name);
  assert.equal(await exists(backup), false);
  for (const name of preserved) assert.equal(await fs.readFile(path.join(support, name), 'utf8'), 'fixture', name);
  assert.match(run(['--purge', '--yes']), /No known filesystem/);
});
