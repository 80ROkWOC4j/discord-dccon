const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const repo=path.resolve(__dirname,'..');
async function put(file,text=''){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('unified Mac installer: three channels, both modes and offline removal',{skip:process.platform!=='darwin'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dccon-mac-install-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const data=path.join(dir,'data'),apps=path.join(dir,'apps'),bin=path.join(dir,'bin'),packages=path.join(dir,'packages');
 const source=(await fs.readFile(path.join(repo,'install.sh'),'utf8')).replaceAll('/Applications',apps).replaceAll('$HOME/Library/Application Support','${DCCON_DATA}');
 const script=path.join(dir,'install.sh');await put(script,source);
 const checksums={};
 for(const mode of ['betterdiscord','standalone']) {
  const folder=path.join(packages,mode);
  if(mode==='betterdiscord') await put(path.join(folder,'discord-dccon.plugin.js'),'plugin fixture');
  else for(const name of ['main.cjs','bootstrap.js','preload.cjs','native.js','shared-storage.cjs']) await put(path.join(folder,'runtime',name),'runtime fixture');
  if(mode==='standalone') await put(path.join(folder,'shelter-version.json'),'{"installLayout":"desktop_core","channels":["Stable","PTB","Canary"],"hostMods":["shelter"]}');
  const asset='discord-dccon-'+mode+'.zip',archive=path.join(packages,asset);
  assert.equal(spawnSync('/usr/bin/ditto',['-c','-k',folder,archive]).status,0);
  checksums[asset]=hash(await fs.readFile(archive));
 }
 await put(path.join(packages,'checksums.json'),JSON.stringify(checksums));
 await put(path.join(packages,'release.json'),JSON.stringify({assets:[...Object.keys(checksums),'checksums.json'].map(name=>({name,browser_download_url:'https://github.com/80ROkWOC4j/discord-dccon/releases/download/v3.5.1/'+name}))}));
 await put(path.join(bin,'codesign'),'#!/bin/bash\nexit 0\n');
 await put(path.join(bin,'pgrep'),'#!/bin/bash\n[[ "${DCCON_RUNNING:-}" == "$2" ]]\n');
 await put(path.join(bin,'curl'),`#!/bin/bash
set -eu
[[ -z "\${DCCON_OFFLINE:-}" ]] || { echo 'unexpected network request' >&2; exit 88; }
url=;out=
while [[ $# -gt 0 ]]; do
 case "$1" in -o) out=$2;shift 2;; https://*) url=$1;shift;; *) shift;; esac
done
case "$url" in
 https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases/latest) name=release.json;;
 https://github.com/80ROkWOC4j/discord-dccon/releases/download/v3.5.1/*) name=\${url##*/};;
 *) exit 99;;
esac
cp "$DCCON_PACKAGES/$name" "$out"
if [[ -n "\${DCCON_CORRUPT:-}" && $name == *.zip ]]; then printf corrupt >> "$out"; fi
`);
 for(const command of ['cp','mv']) await put(path.join(bin,command),`#!/bin/bash
source=$1
for destination in "$@"; do :; done
case "${command}:\${DCCON_FAIL_STEP:-}:$source:$destination" in
 cp:install-copy:*:*/index.js.installing|cp:remove-copy:*:*/index.js.restoring|mv:install-rename:*/index.js.installing:*|mv:remove-rename:*/index.js.restoring:*) echo "injected \${DCCON_FAIL_STEP}" >&2; exit 88;;
esac
exec /bin/${command} "$@"
`);
 for(const name of ['codesign','pgrep','curl','cp','mv']) await fs.chmod(path.join(bin,name),0o755);
 const env={...process.env,PATH:bin+':'+process.env.PATH,DCCON_DATA:data,DCCON_PACKAGES:packages};
 const run=(args=[],ok=true)=>{
  const r=spawnSync('/bin/bash',[script,...args],{env,encoding:'utf8'});
  if(ok) assert.equal(r.status,0,r.stderr);else assert.notEqual(r.status,0,r.stdout);
  return r;
 };
 async function checkFailures(core,args,removal=false) {
  const installed=path.join(core,'discord-dccon'),before=await fs.readFile(path.join(core,'index.js'));
  const existed=await fs.access(installed).then(()=>true,()=>false);
  if(existed)await put(path.join(installed,'keep-before-failure.txt'),'keep');
  for(const step of removal?['remove-copy','remove-rename']:['install-copy','install-rename']) {
   env.DCCON_FAIL_STEP=step;
   assert.match(run(removal?[...args,'--remove']:args,false).stderr,new RegExp('injected '+step));delete env.DCCON_FAIL_STEP;
   assert.deepEqual(await fs.readFile(path.join(core,'index.js')),before);
   if(existed)assert.equal(await fs.readFile(path.join(installed,'keep-before-failure.txt'),'utf8'),'keep');
   else await assert.rejects(fs.access(installed));
   assert.equal((await fs.readdir(core)).some(n=>n.startsWith('.discord-dccon-stage.')||n==='index.js.installing'||n==='index.js.restoring'),false);
  }
 }
 const original='module.exports = require("./core.asar");\n';
 const cores={};
 for(const channel of ['Stable','PTB','Canary']) {
  const appName=channel==='Stable'?'Discord':'Discord '+channel;
  const support=path.join(data,channel==='Stable'?'discord':'discord'+channel.toLowerCase());
  const app=path.join(apps,appName+'.app');await put(path.join(app,'Contents/Resources/build_info.json'),'{"version":"0.0.415"}');await put(path.join(app,'Contents/Resources/app.asar'),'vendor');
  const core=path.join(support,'app-0.0.415/modules/discord_desktop_core-1/discord_desktop_core');cores[channel]=core;
  await put(path.join(core,'core.asar'),'vendor core');await put(path.join(core,'index.js'),original);await put(path.join(support,'settings.json'),'{"UPDATE_ENDPOINT":null}');
  const args=['--channel',channel];env.DCCON_RUNNING=appName;assert.match(run(args,false).stderr,/Fully quit/);delete env.DCCON_RUNNING;
  env.DCCON_CORRUPT='1';assert.match(run(args,false).stderr,/checksum mismatch/);delete env.DCCON_CORRUPT;
  assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
  if(channel==='Stable')await checkFailures(core,args);
  run(args);
  await fs.writeFile(path.join(core,'index.js'),original);run(args);
  if(channel==='Stable')await checkFailures(core,args);
  assert.equal(JSON.parse(await fs.readFile(path.join(core,'discord-dccon/runtime/channel.json'),'utf8')).channel,channel);
  const loader=await fs.readFile(path.join(core,'index.js'),'utf8');await fs.appendFile(path.join(core,'index.js'),'//modified');
  run([...args,'--remove'],false);await fs.writeFile(path.join(core,'index.js'),loader);
  if(channel==='Stable')await checkFailures(core,args,true);
  await fs.writeFile(path.join(core,'index.js'),original);
  env.DCCON_OFFLINE='1';run([...args,'--remove']);delete env.DCCON_OFFLINE;
  assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
 }
 // Vencord uses the same public installer entry point, including offline removal.
 const patcher=path.join(data,'Vencord/dist/patcher.js'),settings=path.join(data,'Vencord/settings/native-settings.json');
 await put(patcher,'Vencord fixture');await put(settings,'{"customCspRules":{"keep.example":["img-src"]},"keep":true}');
 await put(path.join(bin,'codesign'),'#!/bin/bash\nfor target in "$@"; do :; done\n[[ ! -e "$target/Contents/Resources/_app.asar" ]] || { echo "Vencord must not use vanilla signature verification" >&2; exit 99; }\n');
 const patcherJSON=JSON.stringify(patcher).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
 const stub=Buffer.concat([Buffer.from([0,255,0]),Buffer.from('require('+patcherJSON+')')]);
 for(const channel of ['Stable','PTB','Canary']) {
  const appName=channel==='Stable'?'Discord':'Discord '+channel,app=path.join(apps,appName+'.app');
  const resources=path.join(app,'Contents/Resources'),binary=path.join(app,'Contents/MacOS',appName);
  await put(path.join(app,'Contents/Info.plist'),JSON.stringify({CFBundleExecutable:appName}));await put(binary,'vendor executable');
  await fs.rename(path.join(resources,'app.asar'),path.join(resources,'_app.asar'));await put(path.join(resources,'app.asar'),stub);
  if(channel==='Canary') {
   const alternate=path.join(data,'discordcanary/0.0.415/modules/discord_desktop_core');
   await fs.mkdir(path.dirname(alternate),{recursive:true});await fs.rename(cores[channel],alternate);cores[channel]=alternate;
  }
  const core=cores[channel],args=['--channel',channel];
  const protectedFiles=[path.join(resources,'app.asar'),path.join(resources,'_app.asar'),binary,patcher,settings];
  const before=await Promise.all(protectedFiles.map(file=>fs.readFile(file)));
  if(channel==='Stable') {
   await fs.rename(patcher,patcher+'.held');assert.match(run(args,false).stderr,/Incomplete Vencord/);await fs.rename(patcher+'.held',patcher);
   await put(path.join(resources,'app.asar'),'unknown loader');assert.match(run(args,false).stderr,/Unknown Vencord/);await put(path.join(resources,'app.asar'),stub);
   await put(path.join(core,'index.js'),'require("BetterDiscord/data/betterdiscord.asar");\n'+original);
   await put(path.join(data,'BetterDiscord/data/betterdiscord.asar'),'runtime');await fs.mkdir(path.join(data,'BetterDiscord/plugins'),{recursive:true});
   assert.match(run(args,false).stderr,/Multiple client mod loaders/);await put(path.join(core,'index.js'),original);
   const oldPackages=path.join(dir,'old-packages');await fs.cp(packages,oldPackages,{recursive:true});
   await put(path.join(oldPackages,'standalone/shelter-version.json'),'{"channels":["Stable","PTB","Canary"]}');
   const zip=path.join(oldPackages,'discord-dccon-standalone.zip');await fs.rm(zip);
   assert.equal(spawnSync('/usr/bin/ditto',['-c','-k',path.join(oldPackages,'standalone'),zip]).status,0);
   await put(path.join(oldPackages,'checksums.json'),JSON.stringify({...checksums,'discord-dccon-standalone.zip':hash(await fs.readFile(zip))}));
   env.DCCON_PACKAGES=oldPackages;assert.match(run(args,false).stderr,/desktop_core layout/);env.DCCON_PACKAGES=packages;
   assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
  }
  if(channel==='Stable')await checkFailures(core,args);
  run(args);
  await fs.writeFile(path.join(core,'index.js'),original);run([...args,'--mode','standalone']);
  if(channel==='Stable')await checkFailures(core,args);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(core,'discord-dccon/runtime/channel.json'))),{channel,hostMod:'vencord'});
  await fs.access(path.join(core,'discord-dccon/runtime/shared-storage.cjs'));
  assert.match(run([...args,'--mode','betterdiscord'],false).stderr,/Detected Standalone/);
  const loader=await fs.readFile(path.join(core,'index.js'));await fs.appendFile(path.join(core,'index.js'),'//modified');
  run([...args,'--remove'],false);await fs.writeFile(path.join(core,'index.js'),loader);
  if(channel==='Stable')await checkFailures(core,args,true);
  await fs.writeFile(path.join(core,'index.js'),original);
  env.DCCON_OFFLINE='1';run([...args,'--remove']);delete env.DCCON_OFFLINE;
  assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),original);
  for(let i=0;i<protectedFiles.length;i++)assert.deepEqual(await fs.readFile(protectedFiles[i]),before[i]);
  await fs.rm(path.join(resources,'app.asar'));await fs.rename(path.join(resources,'_app.asar'),path.join(resources,'app.asar'));
 }
 // Official sheltupdate keeps its core source, preload, updater settings and app archive.
 for(const channel of ['Stable','PTB','Canary']) {
  const core=cores[channel],support=path.join(data,channel==='Stable'?'discord':'discord'+channel.toLowerCase());
  const settings=path.join(support,'settings.json');
  const host='// SHELTUPDATE_FRAMEWORK_ORIGINAL_PRELOAD SHELTER_BUNDLE_FETCH\n'+original;
  await put(path.join(core,'index.js'),host);
  await put(path.join(core,'preload.js'),'// SHELTER_BUNDLE_FETCH');
  await put(path.join(core,'branches.json'),'[{"name":"shelter"}]');
  await put(settings,'{"UPDATE_ENDPOINT":"https://inject.shelter.uwu.network/shelter","NEW_UPDATE_ENDPOINT":"https://inject.shelter.uwu.network/shelter/","keep":true}');
  const files=[settings,path.join(core,'preload.js'),path.join(core,'branches.json')];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  const args=['--channel',channel];
  if(channel==='Stable')await checkFailures(core,args);
  run(args);run(args);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(core,'discord-dccon/runtime/channel.json'))),{channel,hostMod:'shelter'});
  assert.equal(await fs.readFile(path.join(core,'discord-dccon/original.js'),'utf8'),host);
  assert.ok((await fs.readFile(path.join(core,'index.js'),'utf8')).endsWith(host));
  if(channel==='Stable')await checkFailures(core,args,true);
  env.DCCON_OFFLINE='1';run([...args,'--remove']);delete env.DCCON_OFFLINE;
  assert.equal(await fs.readFile(path.join(core,'index.js'),'utf8'),host);
  for(let i=0;i<files.length;i++)assert.deepEqual(await fs.readFile(files[i]),before[i]);
  await put(path.join(core,'index.js'),original);await put(settings,'{}');
 }
 const plugins=path.join(data,'BetterDiscord/plugins');await fs.mkdir(plugins,{recursive:true});
 await put(path.join(data,'BetterDiscord/data/betterdiscord.asar'),'runtime');
 await put(path.join(cores.Stable,'index.js'),'require("BetterDiscord/data/betterdiscord.asar");\n'+original);
 await put(path.join(plugins,'discord-dccon.config.json'),'keep');run();run();
 assert.equal(await fs.readFile(path.join(plugins,'discord-dccon.plugin.js'),'utf8'),'plugin fixture');
 assert.match(run(['--mode','Standalone'],false).stderr,/Detected BetterDiscord/);
 env.DCCON_OFFLINE='1';run(['--remove']);
 await assert.rejects(fs.access(path.join(plugins,'discord-dccon.plugin.js')));
 assert.equal(await fs.readFile(path.join(plugins,'discord-dccon.config.json'),'utf8'),'keep');
 const options=require('../shelter/native').channelOptions('PTB');
 assert.deepEqual(options,{origin:'https://ptb.discord.com',directory:'discord-dccon-ptb'});
});
