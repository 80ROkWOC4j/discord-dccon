const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const original = 'module.exports = require("./core.asar");\n';
const channels = {Stable: ['discord', 'Discord'], PTB: ['discordptb', 'DiscordPTB'], Canary: ['discordcanary', 'DiscordCanary']};
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = file => fs.access(file).then(() => true, () => false);
async function put(file, value = '') {await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, value);}
async function fixture(t, xdg = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dccon-linux-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const home = path.join(dir, "home O'Brien 한글"), support = xdg ? path.join(dir, 'custom config') : path.join(home, '.config');
  const bin = path.join(dir, 'bin'), packages = path.join(dir, 'packages');
  const checksums = {};
  for (const mode of ['betterdiscord', 'standalone']) {
    const folder = path.join(packages, mode);
    if (mode === 'betterdiscord') await put(path.join(folder, 'discord-dccon.plugin.js'), 'plugin fixture');
    else {
      for (const name of ['main.cjs', 'bootstrap.js', 'preload.cjs', 'native.js', 'shared-storage.cjs'])
        await put(path.join(folder, 'runtime', name), 'runtime fixture');
      await put(path.join(folder, 'shelter-version.json'), JSON.stringify({installLayout: 'desktop_core', channels: Object.keys(channels), hostMods: ['shelter']}));
    }
    const asset = `discord-dccon-${mode}.zip`, archive = path.join(packages, asset);
    const zipped = spawnSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[2], "zip", sys.argv[1])', folder, archive.slice(0, -4)], {encoding: 'utf8'});
    assert.equal(zipped.status, 0, zipped.stderr);
    checksums[asset] = hash(await fs.readFile(archive));
  }
  // PowerShell-authored release metadata can have a UTF-8 BOM.
  await put(path.join(packages, 'checksums.json'), '\uFEFF' + JSON.stringify(checksums));
  await put(path.join(bin, 'pgrep'), '#!/bin/bash\n[[ -n "${DCCON_RUNNING:-}" && "$2" == "$DCCON_RUNNING" ]]\n');
  await put(path.join(bin, 'curl'), `#!/bin/bash
set -eu
[[ -z "\${DCCON_OFFLINE:-}" ]] || { echo 'unexpected network request' >&2; exit 88; }
url=;out=
while [[ $# -gt 0 ]]; do
 case "$1" in -o) out=$2;shift 2;; https://*) url=$1;shift;; *) shift;; esac
done
case "$url" in
 https://github.com/80ROkWOC4j/discord-dccon/releases/latest/download/*|https://github.com/80ROkWOC4j/discord-dccon/releases/download/v4.0.1/*) name=\${url##*/};;
 *) echo "unexpected URL: $url" >&2; exit 99;;
esac
printf '%s\\n' "$url" >> "$DCCON_PACKAGES/requests.log"
cp "$DCCON_PACKAGES/$name" "$out"
if [[ -n "\${DCCON_CORRUPT:-}" && $name == *.zip ]]; then printf corrupt >> "$out"; fi
`);
  for (const command of ['cp', 'mv']) await put(path.join(bin, command), `#!/bin/bash
source=$1
for destination in "$@"; do :; done
case "${command}:\${DCCON_FAIL_STEP:-}:$source:$destination" in
 cp:install-copy:*:*/index.js.installing|cp:remove-copy:*:*/index.js.restoring|mv:install-rename:*/index.js.installing:*|mv:remove-rename:*/index.js.restoring:*) echo "injected \${DCCON_FAIL_STEP}" >&2; exit 88;;
esac
exec /bin/${command} "$@"
`);
  for (const name of ['pgrep', 'curl', 'cp', 'mv']) await fs.chmod(path.join(bin, name), 0o755);
  const env = {...process.env, HOME: home, XDG_CONFIG_HOME: xdg ? support : '', PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: dir, DCCON_PACKAGES: packages, DCCON_RUNNING: '', DCCON_OFFLINE: '', DCCON_CORRUPT: '', DCCON_FAIL_STEP: ''};
  const roots = {};
  for (const [channel, [client, binary]] of Object.entries(channels)) {
    const data = path.join(support, client), app = path.join(data, 'app-1.0.1'), resources = path.join(app, 'resources');
    await put(path.join(resources, 'build_info.json'), JSON.stringify({version: '1.0.1', releaseChannel: channel.toLowerCase()}));
    await put(path.join(resources, 'app.asar'), `vendor ${channel}`);
    await put(path.join(app, binary), 'executable fixture');
    await fs.chmod(path.join(app, binary), 0o755);
    await fs.symlink(path.join(app, binary), path.join(data, binary));
    const core = path.join(app, 'modules/discord_desktop_core-1/discord_desktop_core');
    await put(path.join(core, 'index.js'), original); await put(path.join(core, 'core.asar'), 'vendor core');
    await put(path.join(data, 'settings.json'), '{"UPDATE_ENDPOINT":null}');
    roots[channel] = {app, resources, core, data};
  }
  const run = (args = [], ok = true) => {
    require('node:fs').writeFileSync(path.join(packages, 'requests.log'), '');
    const result = spawnSync('/bin/bash', [path.join(repo, 'install.sh'), ...args], {env, encoding: 'utf8'});
    assert.equal(result.status === 0, ok, result.stdout + result.stderr);
    if (ok) {
      const requests = require('node:fs').readFileSync(path.join(packages, 'requests.log'), 'utf8').trim().split('\n').filter(Boolean);
      const tagIndex = args.indexOf('--version');
      const base = 'https://github.com/80ROkWOC4j/discord-dccon/releases/' +
        (tagIndex < 0 ? 'latest/download' : 'download/' + args[tagIndex + 1]);
      const asset = result.stdout.includes('Selected BetterDiscord') ? 'betterdiscord' : 'standalone';
      assert.deepEqual(requests, args.includes('--remove') || args.includes('--purge') ? [] :
        [`${base}/discord-dccon-${asset}.zip`, `${base}/checksums.json`]);
    }
    return result.stdout + result.stderr;
  };
  return {dir, home, support, bin, packages, env, roots, run};
}

test('Linux native installer: channels, checksums, updates, modified loaders and offline removal', {skip: process.platform !== 'linux'}, async t => {
  const {roots, env, run} = await fixture(t);
  for (const [channel, [, binary]] of Object.entries(channels)) {
    const {core, resources} = roots[channel], args = ['--channel', channel];
    for (const processName of [binary, channels[channel][0]]) {
      env.DCCON_RUNNING = processName; assert.match(run(args, false), /Fully quit/);
    }
    env.DCCON_RUNNING = '';
    env.DCCON_CORRUPT = '1'; assert.match(run(args, false), /checksum mismatch/); env.DCCON_CORRUPT = '';
    assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
    run([...args, '--version', 'v4.0.1']);
    const installed = path.join(core, 'discord-dccon');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed, 'runtime/channel.json'))), {channel});
    await put(path.join(installed, 'keep-before-update'), 'keep'); run(args);
    const previous = (await fs.readdir(core)).find(name => name.startsWith('discord-dccon-previous-'));
    assert.equal(await fs.readFile(path.join(core, previous, 'keep-before-update'), 'utf8'), 'keep');
    const loader = await fs.readFile(path.join(core, 'index.js'), 'utf8');
    await fs.appendFile(path.join(core, 'index.js'), '// external change');
    assert.match(run([...args, '--remove'], false), /modified/); await put(path.join(core, 'index.js'), loader);
    env.DCCON_OFFLINE = '1'; run([...args, '--remove']); env.DCCON_OFFLINE = '';
    assert.equal(await exists(installed), false);
    assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), `vendor ${channel}`);
  }
});

test('Linux installer preserves the core and runtime on failed activation or removal', {skip: process.platform !== 'linux'}, async t => {
  const {roots: {Stable: {core}}, env, run} = await fixture(t);
  for (const installed of [false, true]) {
    if (installed) run();
    const before = await fs.readFile(path.join(core, 'index.js'));
    if (installed) await put(path.join(core, 'discord-dccon/keep'), 'keep');
    for (const step of ['install-copy', 'install-rename', ...(installed ? ['remove-copy', 'remove-rename'] : [])]) {
      env.DCCON_FAIL_STEP = step;
      assert.match(run(step.startsWith('remove') ? ['--remove'] : [], false), new RegExp('injected ' + step));
      env.DCCON_FAIL_STEP = '';
      assert.deepEqual(await fs.readFile(path.join(core, 'index.js')), before);
      assert.equal(await exists(path.join(core, 'discord-dccon')), installed);
      if (installed) assert.equal(await fs.readFile(path.join(core, 'discord-dccon/keep'), 'utf8'), 'keep');
      assert.equal((await fs.readdir(core)).some(name => name.startsWith('.discord-dccon-stage.') || /index.js\.(installing|restoring)$/.test(name)), false);
    }
  }
});

test('Linux installer discovers executable paths and custom roots, respects XDG and rejects unsupported installs', {skip: process.platform !== 'linux'}, async t => {
  const {dir, bin, support, roots: {Stable: {app, core, data}}, run} = await fixture(t, true);
  await fs.unlink(path.join(data, 'Discord'));
  // A tarball linked from PATH need not live in a system directory.
  await fs.symlink(path.join(app, 'Discord'), path.join(bin, 'discord'));
  run(); run(['--remove']);
  await fs.unlink(path.join(bin, 'discord'));
  assert.match(run(['--discord-root', app], true), /Standalone installed/);
  run(['--discord-root', app, '--remove']);
  assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
  const flatpak = path.join(dir, '.var/app/com.discordapp.Discord'); await fs.mkdir(flatpak, {recursive: true});
  const snap = path.join(dir, 'snap/discord/current'); await fs.mkdir(snap, {recursive: true});
  for (const root of [flatpak, snap]) assert.match(run(['--discord-root', root], false), /Flatpak and Snap.*not supported/);
  assert.match(run(['--discord-root', ''], false), /Missing value/);
  assert.match(run(['--purge', '--discord-root', app], false), /do not combine/);
  assert.match(run(['--discord-root', path.join(dir, 'missing')], false), /Discord not found/);
  assert.equal(data, path.join(support, 'discord'));
});

test('Linux BetterDiscord installs only its plugin and refuses unknown or conflicting loaders', {skip: process.platform !== 'linux'}, async t => {
  const {support, roots: {Stable: {core, resources}}, env, run} = await fixture(t, true);
  const plugins = path.join(support, 'BetterDiscord/plugins');
  await fs.mkdir(plugins, {recursive: true}); // Leftovers must not select BetterDiscord.
  assert.match(run(['--mode', 'betterdiscord'], false), /Detected Standalone/);
  await put(path.join(core, 'index.js'), 'require("./unknown-mod");\n' + original);
  assert.match(run([], false), /Unknown Discord core loader/);
  const bdCore = 'require("BetterDiscord/data/betterdiscord.asar");\n' + original;
  await put(path.join(core, 'index.js'), bdCore);
  assert.match(run([], false), /Repair BetterDiscord/);
  await put(path.join(support, 'BetterDiscord/data/betterdiscord.asar'), 'runtime');
  await put(path.join(plugins, 'discord-dccon.plugin.js'), 'old plugin');
  await put(path.join(plugins, 'discord-dccon.config.json'), 'keep config');
  run(); run();
  assert.equal(await fs.readFile(path.join(plugins, 'discord-dccon.plugin.js'), 'utf8'), 'plugin fixture');
  assert.equal((await fs.readdir(plugins)).filter(name => name.includes('.backup-')).length, 1);
  assert.match(run(['--mode', 'standalone'], false), /Detected BetterDiscord/);
  env.DCCON_OFFLINE = '1'; run(['--remove']);
  assert.equal(await fs.readFile(path.join(plugins, 'discord-dccon.config.json'), 'utf8'), 'keep config');
  assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), bdCore);
  assert.equal(await fs.readFile(path.join(resources, 'app.asar'), 'utf8'), 'vendor Stable');
});

test('Linux standalone coexists with Vencord and Shelter without modifying their files', {skip: process.platform !== 'linux'}, async t => {
  const {support, roots: {Stable: {resources, core, data}}, env, run} = await fixture(t, true);
  const patcher = path.join(support, 'Vencord/dist/patcher.js'); await put(patcher, 'Vencord fixture');
  await fs.rename(path.join(resources, 'app.asar'), path.join(resources, '_app.asar'));
  const stub = Buffer.concat([Buffer.from([0, 255]), Buffer.from('require(' + JSON.stringify(patcher) + ')')]);
  await put(path.join(resources, 'app.asar'), stub);
  run(); run();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(core, 'discord-dccon/runtime/channel.json'))), {channel: 'Stable', hostMod: 'vencord'});
  env.DCCON_OFFLINE = '1'; run(['--remove']); env.DCCON_OFFLINE = '';
  assert.deepEqual(await fs.readFile(path.join(resources, 'app.asar')), stub);
  await fs.rm(path.join(resources, 'app.asar')); await fs.rename(path.join(resources, '_app.asar'), path.join(resources, 'app.asar'));
  const host = '// SHELTUPDATE_FRAMEWORK_ORIGINAL_PRELOAD SHELTER_BUNDLE_FETCH\n' + original;
  await put(path.join(core, 'index.js'), host); await put(path.join(core, 'preload.js'), '// SHELTER_BUNDLE_FETCH');
  await put(path.join(core, 'branches.json'), '[]');
  const settings = '{"UPDATE_ENDPOINT":"https://inject.shelter.uwu.network/shelter"}';
  await put(path.join(data, 'settings.json'), settings);
  run(); run();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(core, 'discord-dccon/runtime/channel.json'))), {channel: 'Stable', hostMod: 'shelter'});
  assert.ok((await fs.readFile(path.join(core, 'index.js'), 'utf8')).endsWith(host));
  env.DCCON_OFFLINE = '1'; run(['--remove']);
  assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), host);
  assert.equal(await fs.readFile(path.join(data, 'settings.json'), 'utf8'), settings);
});

test('Linux purge restores every channel and clears shared settings with custom XDG, preserving other data', {skip: process.platform !== 'linux'}, async t => {
  const {home, support, roots, env, run} = await fixture(t, true);
  for (const channel of Object.keys(channels)) run(['--channel', channel]);
  const shared = path.join(home, '.config/discord-dccon');
  await put(path.join(shared, 'config.json'), '{}');
  await put(path.join(support, 'BetterDiscord/plugins/other.plugin.js'), 'keep');
  await put(path.join(support, 'discord-dccon-ptb/legacy'), 'old');
  env.DCCON_OFFLINE = '1';
  assert.match(run(['--purge', '--dry-run']), /Dry run/);
  assert.equal(await exists(shared), true);
  env.DCCON_RUNNING = 'DiscordCanary'; assert.match(run(['--purge', '--yes'], false), /Fully quit all/); env.DCCON_RUNNING = '';
  const outside = path.join(home, 'outside'); await put(path.join(outside, 'keep'), 'keep');
  await fs.symlink(outside, path.join(shared, 'linked'));
  assert.match(run(['--purge', '--yes'], false), /Linked path/); await fs.unlink(path.join(shared, 'linked'));
  run(['--purge', '--yes']);
  for (const {core} of Object.values(roots)) {
    assert.equal(await fs.readFile(path.join(core, 'index.js'), 'utf8'), original);
    assert.deepEqual((await fs.readdir(core)).sort(), ['core.asar', 'index.js']);
  }
  assert.equal(await exists(shared), false);
  assert.equal(await exists(path.join(support, 'discord-dccon-ptb')), false);
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(support, 'BetterDiscord/plugins/other.plugin.js'), 'utf8'), 'keep');
  assert.match(run(['--purge', '--yes']), /No known filesystem/);
});
