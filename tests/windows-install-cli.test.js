const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const pwsh = process.env.DCCON_TEST_PWSH || 'pwsh';
const available = spawnSync(pwsh, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const shells = available ? [pwsh] : [];
if (process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0) shells.push('powershell.exe');
async function put(file, text='') {await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file,text);}
let distribution;
before(async () => {
  if (!available) return;
  // Keep installer fixtures isolated from builds performed by other test files.
  distribution = await fs.mkdtemp(path.join(os.tmpdir(),'dccon-release-fixture-'));
  await put(path.join(distribution,'betterdiscord/discord-dccon.plugin.js'),await fs.readFile(require('../scripts/build.cjs').pluginPath));
  const runtime=path.join(distribution,'standalone/runtime');
  await put(path.join(runtime,'bootstrap.js'),'// hostMod: fixture runtime; installation does not execute it');
  for(const name of ['main.cjs','preload.cjs','native.js']) await put(path.join(runtime,name),await fs.readFile(path.join(repo,'shelter',name)));
  await put(path.join(runtime,'shared-storage.cjs'),require('../scripts/build.cjs').buildStorage());
  await put(path.join(distribution,'standalone/shelter-version.json'),JSON.stringify({installLayout:'desktop_core',channels:['Stable','PTB','Canary']}));
  const pack=path.join(distribution,'pack.ps1');
  await put(pack,`$ErrorActionPreference='Stop'
$checksums=@{}
foreach($mode in @('betterdiscord','standalone')) {
 $name="discord-dccon-$mode.zip"; $archive=Join-Path $PSScriptRoot $name
 Compress-Archive -Path (Join-Path $PSScriptRoot "$mode/*") -DestinationPath $archive -Force
 $checksums[$name]=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant()
}
$checksums | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'checksums.json') -Encoding utf8
`);
  const result=spawnSync(pwsh,['-NoProfile','-File',pack],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
after(async()=>{if(distribution)await fs.rm(distribution,{recursive:true,force:true});});
async function packageRelease(fixture, packageDirectory) {
  const release=await fs.mkdtemp(path.join(fixture.dir,'release-'));
  await fs.cp(distribution,release,{recursive:true});
  await fs.rm(path.join(release,'standalone'),{recursive:true,force:true});
  await fs.cp(packageDirectory,path.join(release,'standalone'),{recursive:true});
  const result=spawnSync(pwsh,['-NoProfile','-File',path.join(release,'pack.ps1')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return release;
}
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dccon-installer-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=await fs.readFile(path.join(repo,'install.ps1'),'utf8');
  const split=source.indexOf('$Channel = switch ($Channel)');
  const mocks=`
function Get-Process { param($Name,$ErrorAction) if ($env:DCCON_RUNNING) { [pscustomobject]@{Path=$env:DCCON_RUNNING} } }
function Copy-Item {
 param($LiteralPath,$Destination)
 if ($env:DCCON_FAIL_ENTRY_COPY -and $Destination -match 'dccon-entry-.*\\.tmp$') {throw 'Injected entry copy failure'}
 Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination
}

function Move-Item {
 param($LiteralPath,$Destination)
 if ($env:DCCON_FAIL_LEGACY_RESTORE -and $LiteralPath -like '*discord-dccon-original.asar' -and $Destination -like '*app.asar') {throw 'Injected legacy restore failure'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}

function Invoke-RestMethod {
 param($Uri,$Headers)
 if ($env:DCCON_OFFLINE) {throw 'Download attempted while removing'}
 $names=@('discord-dccon-betterdiscord.zip','discord-dccon-standalone.zip','checksums.json')
 return @{tag_name='v3.5.1';assets=@($names | ForEach-Object {@{name=$_;browser_download_url="https://github.com/80ROkWOC4j/discord-dccon/releases/download/v3.5.1/$_"}})}
}
function Invoke-WebRequest {
 param([switch]$UseBasicParsing,$Uri,$Headers,$OutFile)
 $name=([uri]$Uri).Segments[-1]
 Copy-Item -LiteralPath (Join-Path $env:DCCON_DIST $name) -Destination $OutFile
 if ($env:DCCON_CORRUPT -and $name.EndsWith('.zip')) {Add-Content -LiteralPath $OutFile -Value corrupt}
}
`;
  const script=path.join(dir,'install.ps1');await put(script,source.slice(0,split)+mocks+source.slice(split));
  const env={...process.env,LOCALAPPDATA:path.join(dir,'Local'),APPDATA:path.join(dir,"Roaming O'Brien"),DCCON_DIST:distribution,TEMP:dir,TMP:dir};
  for(const key of Object.keys(env)) if(key.toLowerCase()==='psmodulepath') delete env[key];
  const plugins=path.join(env.APPDATA,'BetterDiscord/plugins');await fs.mkdir(plugins,{recursive:true});
  const roots={};
  for(const channel of ['Stable','PTB','Canary']) {
    const root=path.join(env.LOCALAPPDATA,channel==='Stable'?'Discord':'Discord'+channel);
    const resources=path.join(root,'app-1.0.1/resources');await put(path.join(resources,'app.asar'),'vendor '+channel);
    const core=path.join(root,'app-1.0.1/modules/discord_desktop_core');
    await put(path.join(core,'index.js'),'module.exports = require("./core.asar");\n');await put(path.join(core,'core.asar'),'vendor core');
    roots[channel]={root,resources,core};
  }
  return {dir,env,script,plugins,roots};
}
for(const shell of shells) test(`unified Windows installer: channels, modes, rollback and offline removal (${path.basename(shell)})`,async t=>{
 const f=await fixture(t);
 const run=(args=[],ok=true,release=distribution)=>{
  const r=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',f.script,...args],{cwd:repo,env:{...f.env,DCCON_DIST:release},encoding:'utf8'});
  if(ok) assert.equal(r.status,0,r.stderr); else assert.notEqual(r.status,0,r.stdout);
  return r;
 };
 for(const channel of ['Stable','PTB','Canary']) {
  const {root,resources,core}=f.roots[channel]; const args=['-Channel',channel];
  f.env.DCCON_RUNNING=path.join(root,'app-1.0.1','Discord'+(channel==='Stable'?'':channel)+'.exe');
  assert.match(run(args,false).stderr,/Fully quit/);delete f.env.DCCON_RUNNING;
  f.env.DCCON_CORRUPT='1';assert.match(run(args,false).stderr,/checksum mismatch/);delete f.env.DCCON_CORRUPT;
  assert.equal(await fs.readFile(path.join(resources,'app.asar'),'utf8'),'vendor '+channel);
  if (channel==='PTB') {
   const unsupported=path.join(f.dir,'unsupported-vanilla-ptb');
   await fs.cp(path.join(distribution,'standalone'),unsupported,{recursive:true});
   await put(path.join(unsupported,'shelter-version.json'),JSON.stringify({installLayout:'desktop_core',channels:['Stable','Canary']}));
   assert.match(run(args,false,await packageRelease(f,unsupported)).stderr,/does not support standalone PTB/);
   await fs.rm(path.join(unsupported,'shelter-version.json'));
   assert.match(run(args,false,await packageRelease(f,unsupported)).stderr,/does not support standalone PTB/);
   assert.equal(await fs.readFile(path.join(resources,'app.asar'),'utf8'),'vendor '+channel);
   await assert.rejects(fs.access(path.join(resources,'app')));
  }
  run(args);run(args);
  assert.equal(JSON.parse(await fs.readFile(path.join(core,'discord-dccon/runtime/channel.json'),'utf8')).channel,channel);
  const loader=path.join(core,'index.js'), saved=await fs.readFile(loader,'utf8');
  await fs.appendFile(loader,'\n// modified');assert.match(run([...args,'-Remove'],false).stderr,/modified desktop_core/i);await fs.writeFile(loader,saved);
  f.env.DCCON_OFFLINE='1';run([...args,'-Remove']);delete f.env.DCCON_OFFLINE;
  assert.equal(await fs.readFile(path.join(resources,'app.asar'),'utf8'),'vendor '+channel);
 }
 const {resources,root}=f.roots.Stable;
 const core=path.join(root,'app-1.0.1/modules/discord_desktop_core/index.js');
 await put(core,'require("BetterDiscord/data/betterdiscord.asar"); module.exports = require("./core.asar");');
 await put(path.join(f.env.APPDATA,'BetterDiscord/data/betterdiscord.asar'),'bd runtime');
 const config=path.join(f.plugins,'discord-dccon.config.json');await put(config,'{"keep":true}');
 run();run();assert.match(run(['-Mode','Standalone'],false).stderr,/Detected BetterDiscord/);
 assert.equal(await fs.readFile(path.join(f.plugins,'discord-dccon.plugin.js'),'utf8'),await fs.readFile(require('../scripts/build.cjs').pluginPath,'utf8'));
 f.env.DCCON_OFFLINE='1';run(['-Remove']);delete f.env.DCCON_OFFLINE;
 await assert.rejects(fs.access(path.join(f.plugins,'discord-dccon.plugin.js')));
 assert.equal(await fs.readFile(config,'utf8'),'{"keep":true}');
 assert.equal(await fs.readFile(path.join(resources,'app.asar'),'utf8'),'vendor Stable');
 assert.equal((await fs.readdir(f.dir)).filter(n=>n.startsWith('discord-dccon-install-')).length,0);
});
if(!shells.length) test('Windows installer requires PowerShell',{skip:true},()=>{});

for (const shell of shells) for (const hostMod of ['', 'vencord']) test(`desktop_core ${hostMod || 'vanilla'}: install, update, rollback and remove preserve host files (${path.basename(shell)})`, async t => {
  const f = await fixture(t);
  const run = (args, ok = true, release = distribution) => {
    const r = spawnSync(shell, ['-NoProfile','-ExecutionPolicy','Bypass','-File',f.script,...args], {cwd:repo,env:{...f.env,DCCON_DIST:release},encoding:'utf8'});
    if (ok) assert.equal(r.status,0,r.stderr); else assert.notEqual(r.status,0,r.stdout);
    return r;
  };
  const patcher = path.join(f.env.APPDATA,'Vencord/dist/patcher.js');
  const settings = path.join(f.env.APPDATA,'Vencord/settings/native-settings.json');
  await put(patcher,'// Vencord patcher fixture'); await put(settings,'{"customCspRules":{"example.com":["img-src"]},"keep":true}');
  // Same ASAR layout as Vencord/Installer app_asar.go; no Vencord execution in fixture tests.
  const index = Buffer.from('require('+JSON.stringify(patcher)+')'), pkg = Buffer.from('{"name":"discord","main":"index.js"}');
  const header = Buffer.from(JSON.stringify({files:{'index.js':{size:index.length,offset:'0'},'package.json':{size:pkg.length,offset:String(index.length)}}}));
  const aligned = (header.length + 3) & ~3, prefix = Buffer.alloc(16);
  [4,aligned+8,aligned+4,header.length].forEach((n,i)=>prefix.writeUInt32LE(n,i*4));
  const vencord = Buffer.concat([prefix,header,Buffer.alloc(aligned-header.length),index,pkg]);
  for (const [i,channel] of ['Stable','PTB','Canary'].entries()) {
    const {root,resources} = f.roots[channel];
    const data = path.join(f.env.APPDATA,channel==='Stable'?'discord':'discord'+channel.toLowerCase());
    const core = [path.join(root,'app-1.0.1/modules/discord_desktop_core'),path.join(data,'app-1.0.1/modules/discord_desktop_core-1/discord_desktop_core'),path.join(data,'1.0.1/modules/discord_desktop_core')][i];
    if(core!==f.roots[channel].core)await fs.rm(f.roots[channel].core,{recursive:true});
    const original = 'module.exports = require("./core.asar");\n';
    await put(path.join(core,'index.js'),original); await put(path.join(core,'core.asar'),'vendor core');
    if(hostMod) {await put(path.join(resources,'_app.asar'),'vendor archive'); await put(path.join(resources,'app.asar'),vencord);}
    const preserved = [path.join(resources,'app.asar'),patcher,settings,...(hostMod?[path.join(resources,'_app.asar')]:[])];
    const before = await Promise.all(preserved.map(file=>fs.readFile(file)));
    const args = ['-Channel',channel];
    const installed = path.join(core,'discord-dccon');
    if (i===0) {
      const oldPackage=path.join(f.dir,'old-package');
      await fs.cp(path.join(distribution,'standalone'),oldPackage,{recursive:true});
      await put(path.join(oldPackage,'shelter-version.json'),JSON.stringify({channels:['Stable','PTB','Canary']}));
      assert.match(run(args,false,await packageRelease(f,oldPackage)).stderr,/does not use the desktop_core/);
      assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
      if(hostMod) {
        await put(path.join(resources,'app.asar'),'unknown loader');
        assert.match(run(args,false).stderr,/Unknown app.asar/);
        await put(path.join(resources,'app.asar'),vencord);
      }
      await put(path.join(core,'index.js'),'require("other-mod");'+original);
      assert.match(run(args,false).stderr,/Unknown core loader/);
      await put(path.join(core,'index.js'),original);
      const extra = path.join(data,'app-1.0.1/modules/discord_desktop_core-2/discord_desktop_core/index.js');
      await put(extra,original); assert.match(run(args,false).stderr,/exactly one/); await fs.rm(path.dirname(path.dirname(extra)),{recursive:true});
      f.env.DCCON_FAIL_ENTRY_COPY='1';assert.match(run(args,false).stderr,/Injected entry copy failure/);delete f.env.DCCON_FAIL_ENTRY_COPY;
      assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
      await assert.rejects(fs.access(installed));
    }
    let nonPtbRelease;
    if (channel==='PTB') {
      const nonPtbPackage=path.join(f.dir,'non-ptb-package');
      await fs.cp(path.join(distribution,'standalone'),nonPtbPackage,{recursive:true});
      await put(path.join(nonPtbPackage,'shelter-version.json'),JSON.stringify({installLayout:'desktop_core',channels:['Stable','Canary']}));
      nonPtbRelease=await packageRelease(f,nonPtbPackage);
      assert.match(run(args,false,nonPtbRelease).stderr,/does not support standalone PTB/);
      await fs.rm(path.join(nonPtbPackage,'shelter-version.json'));
      nonPtbRelease=await packageRelease(f,nonPtbPackage);
      assert.match(run(args,false,nonPtbRelease).stderr,/does not support standalone PTB/);
      assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
      await assert.rejects(fs.access(installed));
    }
    run(args);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed,'runtime/channel.json'))),{channel,...(hostMod?{hostMod}:{})});
    assert.equal(await fs.readFile(path.join(installed,'original.js'),'utf8'),original);
    // Windows PowerShell 5.1 writes UTF-8 with a BOM; this manifest is read by PowerShell.
    assert.equal(JSON.parse((await fs.readFile(path.join(installed,'discord-dccon-install.json'),'utf8')).replace(/^\uFEFF/, '')).kind,'discord-dccon-core');
    await fs.access(path.join(installed,'runtime/shared-storage.cjs'));
    const loader=await fs.readFile(path.join(core,'index.js'),'utf8');
    await put(path.join(core,'index.js'),original);run(args);
    assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),loader);
    if (nonPtbRelease) {
      const manifestBefore=await fs.readFile(path.join(installed,'discord-dccon-install.json'));
      assert.match(run(args,false,nonPtbRelease).stderr,/does not support standalone PTB/);
      assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),loader);
      assert.deepEqual(await fs.readFile(path.join(installed,'discord-dccon-install.json')),manifestBefore);
    }
    if (i===0) {
      await put(path.join(core,'index.js'),original);
      f.env.DCCON_FAIL_ENTRY_COPY='1';assert.match(run(args,false).stderr,/Injected entry copy failure/);delete f.env.DCCON_FAIL_ENTRY_COPY;
      assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
      assert.equal(await fs.readFile(path.join(installed,'original.js'),'utf8'),original);
    }
    run(args);
    if(!hostMod && channel==='Stable') {
      // Installing/removing Vencord changes host integration, not our installation layout.
      const appFile=path.join(resources,'app.asar'),vendor=await fs.readFile(appFile);
      await put(path.join(resources,'_app.asar'),vendor);await put(appFile,vencord);
      run(args);
      assert.equal(JSON.parse(await fs.readFile(path.join(installed,'runtime/channel.json'))).hostMod,'vencord');
      await put(appFile,vendor);await fs.rm(path.join(resources,'_app.asar'));
      run(args);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed,'runtime/channel.json'))),{channel});
    }
    const userData=path.join(f.env.APPDATA,'discord-dccon/config.json');await put(userData,'{"keep":true}');
    f.env.DCCON_OFFLINE='1';
    await put(path.join(core,'index.js'),loader+'// changed');assert.match(run(['-Channel',channel,'-Remove'],false).stderr,/modified desktop_core/i);await put(path.join(core,'index.js'),loader);
    await put(path.join(installed,'original.js'),original+'// changed');assert.match(run(['-Channel',channel,'-Remove'],false).stderr,/Modified desktop_core/);await put(path.join(installed,'original.js'),original);
    await put(path.join(core,'index.js'),original);
    run(['-Channel',channel,'-Remove']);delete f.env.DCCON_OFFLINE;
    assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
    assert.equal(await fs.readFile(userData,'utf8'),'{"keep":true}');
    await assert.rejects(fs.access(installed));
    for (let j=0;j<preserved.length;j++) assert.deepEqual(await fs.readFile(preserved[j]),before[j]);
    assert.equal((await fs.readdir(core)).some(n=>n.startsWith('discord-dccon-stage-')||n.startsWith('dccon-entry-')),false);
  }
});

async function legacyFixture(f, channel='Stable', vencord=false) {
  const {resources,core}=f.roots[channel],app=path.join(resources,'app');
  const asar=path.join(resources,'app.asar'),original=path.join(resources,'discord-dccon-original.asar');
  const hostFiles=[];
  if(vencord) {
    const patcher=path.join(f.env.APPDATA,'Vencord/dist/patcher.js');
    const settings=path.join(f.env.APPDATA,'Vencord/settings/native-settings.json');
    await put(patcher,'Vencord fixture');await put(settings,'{"keep":true}');
    await put(path.join(resources,'_app.asar'),'vendor archive');
    await put(asar,'require('+JSON.stringify(patcher)+')');
    hostFiles.push(patcher,settings,path.join(resources,'_app.asar'));
  }
  await fs.rename(asar,original);
  await put(path.join(app,'index.js'),'old loader');await put(path.join(app,'package.json'),'{"main":"index.js"}');
  await put(path.join(app,'keep-me.txt'),'preserve this too');
  const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const record={kind:'discord-dccon-standalone',...(channel==='Stable'?{}:{channel}),originalHash:await digest(original)};
  for(const file of ['index.js','package.json'])record[file]=await digest(path.join(app,file));
  const manifest=path.join(app,'discord-dccon-install.json');await put(manifest,JSON.stringify(record));
  const config=path.join(f.env.APPDATA,'discord-dccon/config.json');await put(config,'{"version":2,"settings":{"favorites":["keep"]}}');
  const files=[original,manifest,path.join(app,'index.js'),path.join(app,'package.json'),path.join(core,'index.js'),config,...hostFiles];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  return {resources,core,app,asar,original,manifest,config,files,before};
}
function legacyRun(shell,f,args=[],ok=true,release=distribution) {
  const r=spawnSync(shell,['-NoProfile','-File',f.script,...args],{cwd:repo,env:{...f.env,DCCON_DIST:release},encoding:'utf8'});
  if(ok)assert.equal(r.status,0,r.stderr);else assert.notEqual(r.status,0,r.stdout);return r;
}
async function unchangedLegacy(state) {
  for(let i=0;i<state.files.length;i++)assert.deepEqual(await fs.readFile(state.files[i]),state.before[i]);
  await assert.rejects(fs.access(state.asar));
  await assert.rejects(fs.access(path.join(state.core,'discord-dccon')));
  assert.equal((await fs.readdir(state.core)).some(n=>n.startsWith('discord-dccon-stage-')||n.startsWith('dccon-entry-')),false);
  assert.equal((await fs.readdir(state.resources)).some(n=>n.startsWith('discord-dccon-removed-')),false);
}
for(const shell of shells) test(`legacy app-loader is restored and reinstalled into desktop_core (${path.basename(shell)})`,async t=>{
  for(const channel of ['Stable','PTB','Canary'])for(const vencord of [false,true]) {
    const f=await fixture(t),state=await legacyFixture(f,channel,vencord);
    legacyRun(shell,f,['-Channel',channel]);
    assert.deepEqual(await fs.readFile(state.asar),state.before[0]);
    await assert.rejects(fs.access(state.original));await assert.rejects(fs.access(state.app));
    const installed=path.join(state.core,'discord-dccon');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed,'runtime/channel.json'))),{channel,...(vencord?{hostMod:'vencord'}:{})});
    assert.deepEqual(await fs.readFile(state.config),state.before[5]);
    for(let i=6;i<state.files.length;i++)assert.deepEqual(await fs.readFile(state.files[i]),state.before[i]);
    const backups=(await fs.readdir(state.resources)).filter(n=>n.startsWith('discord-dccon-removed-'));assert.equal(backups.length,1);
    assert.equal(await fs.readFile(path.join(state.resources,backups[0],'keep-me.txt'),'utf8'),'preserve this too');
    f.env.DCCON_OFFLINE='1';legacyRun(shell,f,['-Channel',channel,'-Remove']);
    assert.deepEqual(await fs.readFile(path.join(state.core,'index.js')),state.before[4]);
    assert.deepEqual(await fs.readFile(state.asar),state.before[0]);
  }
});
for(const shell of shells) test(`legacy transition rejects tampering and invalid packages, and rolls back install failures (${path.basename(shell)})`,async t=>{
  const f=await fixture(t),state=await legacyFixture(f);
  f.env.DCCON_OFFLINE='1';
  for(const file of [state.original,state.manifest]) {
    const held=file+'.held';await fs.rename(file,held);
    assert.match(legacyRun(shell,f,[],false).stderr,/Incomplete or conflicting legacy/);
    await fs.rename(held,file);await unchangedLegacy(state);
  }
  await put(state.manifest,JSON.stringify({kind:'another-mod'}));
  assert.match(legacyRun(shell,f,[],false).stderr,/record or original archive changed/);
  await fs.writeFile(state.manifest,state.before[1]);await unchangedLegacy(state);
  for(const i of [0,2,3]) {
    await fs.appendFile(state.files[i],'tampered');
    assert.match(legacyRun(shell,f,[],false).stderr,/changed|Modified legacy/);
    await fs.writeFile(state.files[i],state.before[i]);await unchangedLegacy(state);
  }
  await put(state.asar,'unexpected existing app');
  assert.match(legacyRun(shell,f,[],false).stderr,/conflicting legacy/);await fs.rm(state.asar);await unchangedLegacy(state);
  delete f.env.DCCON_OFFLINE;
  f.env.DCCON_CORRUPT='1';assert.match(legacyRun(shell,f,[],false).stderr,/checksum mismatch/);delete f.env.DCCON_CORRUPT;await unchangedLegacy(state);
  const incomplete=path.join(f.dir,'incomplete');await fs.cp(path.join(distribution,'standalone'),incomplete,{recursive:true});
  await fs.rm(path.join(incomplete,'runtime/preload.cjs'));
  assert.match(legacyRun(shell,f,[],false,await packageRelease(f,incomplete)).stderr,/missing runtime/);await unchangedLegacy(state);
  for(const failure of ['DCCON_FAIL_LEGACY_RESTORE','DCCON_FAIL_ENTRY_COPY']) {
    f.env[failure]='1';assert.match(legacyRun(shell,f,[],false).stderr,/Injected/);delete f.env[failure];await unchangedLegacy(state);
  }
  legacyRun(shell,f);
  assert.deepEqual(await fs.readFile(state.asar),state.before[0]);
});
for(const shell of shells) test(`legacy removal is offline and does not require a desktop_core module (${path.basename(shell)})`,async t=>{
  for(const channel of ['Stable','PTB','Canary']) {
    const f=await fixture(t),state=await legacyFixture(f,channel);
    await fs.rm(state.core,{recursive:true});f.env.DCCON_OFFLINE='1';
    legacyRun(shell,f,['-Channel',channel,'-Remove']);
    assert.deepEqual(await fs.readFile(state.asar),state.before[0]);
    assert.deepEqual(await fs.readFile(state.config),state.before[5]);
    await assert.rejects(fs.access(state.app));await assert.rejects(fs.access(state.original));
  }
});
