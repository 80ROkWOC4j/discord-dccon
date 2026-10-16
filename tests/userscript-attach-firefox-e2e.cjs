// Manual setup: install Attach PoC in the isolated Firefox session, disable the old script,
// log in, and bring Firefox to the foreground. This test stages files but never sends.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../artifacts/firefox-userscript');
const {id} = JSON.parse(fs.readFileSync(path.join(output, 'session.json')));
const target = JSON.parse(fs.readFileSync(path.join(output, '../mac-vm/target.json')));
const base = 'http://127.0.0.1:4445/session/' + id;
async function command(method, route, body) {
  const response = await fetch(base + route, {method, headers:{'content-type':'application/json'}, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(30000)});
  const {value} = await response.json(); if (value?.error) throw Error(value.message); return value;
}
const evaluate = (fn, ...args) => command('POST', '/execute/sync', {script:`return (${fn})(...arguments);`, args});
async function wait(fn, ...args) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {const result = await evaluate(fn, ...args); if (result) return result; await new Promise(r=>setTimeout(r,250));}
  throw Error('Timed out: ' + String(fn).slice(0,180));
}
async function click(selector) {
  const element = await evaluate(s => document.querySelector(s), selector);
  await command('POST', '/element/' + element['element-6066-11e4-a52e-4f735466cecf'] + '/click', {});
}
async function button(text) {
  const element = await command('POST','/element',{using:'xpath',value:`//*[@role='dialog']//button[normalize-space(.)='${text}' or @aria-label='${text}']`});
  await command('POST','/element/'+element['element-6066-11e4-a52e-4f735466cecf']+'/click',{});
}
async function typeKeys(text) {
  for (const value of text) {
    await command('POST','/actions',{actions:[{type:'key',id:'typing',actions:[{type:'keyDown',value},{type:'keyUp',value}]}]});
    assert.equal(await evaluate(()=>document.activeElement?.matches('.dccon-search-bar input')),true,'Discord stole keyboard focus');
  }
}
async function queue(index, count) {
  const element = await evaluate(i=>document.querySelectorAll('.dccon-item')[i],index);
  await command('POST','/actions',{actions:[
    {type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE008'},{type:'pause',duration:0},{type:'pause',duration:0},{type:'keyUp',value:'\uE008'}]},
    {type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',origin:element,x:0,y:0},{type:'pointerDown',button:0},{type:'pointerUp',button:0},{type:'pause',duration:0}]},
  ]});
  await wait(n=>document.querySelector('.dccon-buffer-items')?.dataset.count===String(n),count);
}
const results = [];
async function check(name, action) {const details = await action();results.push({name,passed:true,details});console.log('PASS',name);}
async function main() {
  await command('POST','/window',JSON.parse(fs.readFileSync(path.join(output,'discord-window.json'))));
  await wait(()=>document.documentElement.dataset.dcconAttachPoc==='started'&&!!document.querySelector('.dccon-trigger'));
  await check('shared picker without shelter or Discord module access',async()=>{
    const state=await evaluate(()=>({path:location.pathname,shelter:typeof shelter,native:typeof DiscordNative,old:typeof DCConUserscriptNative,visible:document.visibilityState,oldUI:!!document.getElementById('dccon-attach-poc')}));
    assert.equal(state.path,`/channels/${target.guildId}/${target.channelId}`);assert.equal(state.shelter,'undefined');assert.equal(state.old,'undefined');assert.equal(state.native,'undefined');assert.equal(state.oldUI,false);assert.equal(state.visible,'visible');return state;
  });
  if(await evaluate(()=>!!document.querySelector('.dccon-popover')))await button('닫기');
  const before=await evaluate(()=>({messages:[...document.querySelectorAll('[id^="chat-messages-"]')].map(e=>e.id),draft:document.querySelector('[role="textbox"][contenteditable=true]').textContent,attachments:document.querySelector('[role="textbox"][contenteditable=true]').closest('form').querySelectorAll('img[src^="blob:"]').length}));
  async function attached(extra) {
    return wait(n=>{const imgs=[...document.querySelector('[role="textbox"][contenteditable=true]').closest('form').querySelectorAll('img[src^="blob:"]')];return imgs.length===n&&imgs.every(i=>i.complete&&i.naturalWidth>0)&&{attachments:imgs.length};},before.attachments+extra);
  }
  async function removeAdded() {
    await evaluate(n=>{const f=document.querySelector('[role="textbox"][contenteditable=true]').closest('form');[...f.querySelectorAll('[aria-label="첨부 파일 제거"]')].slice(n).forEach(e=>e.click());},before.attachments);
    await attached(0);
  }
  async function openPack() {
    await click('.dccon-trigger');
    await click('.dccon-rail [aria-label="슬픈 고양이콘"]');
    await wait(()=>document.querySelector('.dccon-item img')?.naturalWidth>0);
  }
  await check('real keyboard focus, Korean text, cursor editing and Enter search',async()=>{
    await click('.dccon-trigger');await button('팩 추가 / 관리');await button('디시콘샵');await click('.dccon-search-bar input');
    await typeKeys('cat');await typeKeys('\uE003\uE003\uE003');await typeKeys('고양이');
    await typeKeys('\uE012\uE003양\uE010');
    assert.equal(await evaluate(()=>document.querySelector('.dccon-search-bar input').value),'고양이');
    await typeKeys('\uE007');
    const result=await wait(()=>{const cards=[...document.querySelectorAll('.dccon-card')];return cards.length>0&&cards[0].querySelector('img')?.naturalWidth>0&&{cards:cards.length};});
    assert.equal(await evaluate(()=>document.querySelector('[role="textbox"][contenteditable=true]').textContent),before.draft);
    fs.writeFileSync(path.join(output,'attach-shared-search.png'),Buffer.from(await command('GET','/screenshot'),'base64'));
    await button('닫기');return result;
  });
  await check('existing PoC pack migrates and shared picker stages a single image',async()=>{await openPack();await click('.dccon-item');const result=await attached(1);await removeAdded();return result;});
  await check('shared Shift buffer stages two images without sending',async()=>{await openPack();await queue(0,1);await queue(1,2);await click('.dccon-buffer-send');const result=await attached(2);await removeAdded();return result;});
  await check('shared nine-tile conversion stages nine decoded images',async()=>{await openPack();await queue(0,1);await click('.dccon-buffer-split');const result=await attached(9);await removeAdded();return result;});
  await check('full native attachment list preserves the addon queue',async()=>{
    await evaluate(n=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=2;
      const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();for(let i=n;i<10;i++)transfer.items.add(new File([bytes],'dccon-capacity-'+i+'.png',{type:'image/png'}));
      const input=document.querySelector('[role="textbox"][contenteditable=true]').closest('form').querySelector('input[type=file]');
      input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    },before.attachments);
    await attached(10-before.attachments);await openPack();await queue(0,1);await click('.dccon-buffer-send');
    await wait(()=>document.querySelector('.dccon-buffer-items')?.dataset.count==='1'&&!document.querySelector('.dccon-buffer-send').disabled&&[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('최대 10개')));
    await attached(10-before.attachments);await button('전체 비우기');await button('닫기');await removeAdded();
    return {nativeAttachments:10,queueRetained:true};
  });
  await check('real IndexedDB concurrent connections preserve independent settings',async()=>{
    const configBundle=require('esbuild').buildSync({entryPoints:[path.resolve(__dirname,'../src/storage/indexeddb.ts')],
      bundle:true,write:false,format:'iife',globalName:'DCConConfig',platform:'browser',target:'es2022',tsconfigRaw:{}}).outputFiles[0].text;
    const result=await command('POST','/execute/async',{script:`const done=arguments[arguments.length-1];${configBundle}(async()=>{
      const name='dccon-review-'+crypto.randomUUID(),factory={open:(_,version)=>indexedDB.open(name,version)};
      const a=DCConConfig.createConfig(factory),b=DCConConfig.createConfig(factory);
      try{
        await Promise.all([a.config('open',[{dccons:[]}]),b.config('open',[{dccons:[]}])]);
        await Promise.all([a.config('save',['dccons',[{info:{package_idx:'1'}}],[]]),b.config('save',['favorites',[{path:'test',ext:'gif'}],[]])]);
        await b.config('save',['dccons',[{info:{package_idx:'2'}}],[]]);
        const data=await a.config('open',[{}]);return {packs:data.settings.dccons.length,favorites:data.settings.favorites.length};
      }finally{a.dispose();b.dispose();await Promise.resolve();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});}
    })().then(done,e=>done({error:e.message}));`,args:[]});
    assert.deepEqual(result,{packs:2,favorites:1});return result;
  });
  await check('no message was sent and composer draft is preserved',async()=>{
    const after=await evaluate(()=>({messages:[...document.querySelectorAll('[id^="chat-messages-"]')].map(e=>e.id),draft:document.querySelector('[role="textbox"][contenteditable=true]').textContent}));
    assert.deepEqual(after.messages.filter(id=>!before.messages.includes(id)),[]);assert.equal(after.draft,before.draft);return {newMessages:0,draftPreserved:true};
  });
  await openPack();
  fs.writeFileSync(path.join(output,'attach-shared-picker.png'),Buffer.from(await command('GET','/screenshot'),'base64'));
}
main().catch(error=>{results.push({passed:false,error:error.message});console.error(error);process.exitCode=1;}).finally(()=>fs.writeFileSync(path.join(output,'attach-shared-e2e.json'),JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n'));
