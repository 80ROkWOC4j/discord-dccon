const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {IDBFactory}=require('fake-indexeddb');
const {createConfig}=require('../src/storage/indexeddb.ts');
const {createComposerBridge}=require('../userscript/composer');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('mobile Discord textarea mounts the toolbar and receives files without changing the draft',async()=>{
 const {window}=new JSDOM('<form><div class="channelTextArea_mobile"><textarea>mobile draft</textarea><input type="file" multiple><div class="buttons_mobile"></div></div></form>',{url:'https://discord.com/channels/1/2'});
 const document=window.document,editor=document.querySelector('textarea'),input=document.querySelector('input');
 editor.getClientRects=()=>[{}];Object.defineProperty(input,'files',{value:[],writable:true});
 const page={Event:window.Event,File:window.File,MutationObserver:window.MutationObserver,location:window.location,setTimeout,clearTimeout,
  DataTransfer:class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}}};
 const bridge=createComposerBridge(page,document),rendered=[];
 const context={module:{exports:{}},document,MutationObserver:window.MutationObserver,queueMicrotask,
  platform:{composer:bridge,discord:{selectedChannelStore:()=>null},react:{createElement:(_,props)=>props},reactDOM:{createRoot:()=>({render:props=>rendered.push(props),unmount(){}})}}};
 const stop=require('./helpers/core.cjs').importCore(context).mountToolbar(context.platform,()=>{});
 try{
  assert.equal(document.querySelectorAll('.dccon-toolbar-host').length,1);assert.equal(bridge.available(),true);
  assert.equal(rendered[0].channelId,bridge.targetFor(editor));
  input.addEventListener('change',()=>{
   const item=document.createElement('li');item.setAttribute('data-list-item-id','attachments___mobile');
   const name=document.createElement('span');name.className='filename_mobile';name.textContent=input.files[0].name;item.append(name);input.closest('form').append(item);
  });
  await bridge.attachFiles([new window.File(['test'],'mobile.gif')],rendered[0].channelId);
  assert.equal(editor.value,'mobile draft');assert.equal(input.files[0].name,'mobile.gif');
 }finally{stop();bridge.dispose();window.close();}
});

test('settings merge concurrent tabs without losing unrelated keys or same-list additions',async()=>{
 const indexedDB=new IDBFactory(),a=createConfig(indexedDB),b=createConfig(indexedDB);
 const first={info:{package_idx:'1'}},second={info:{package_idx:'2'}};
 await Promise.all([a.config('open',[{dccons:[],favorites:[]}]),b.config('open',[{dccons:[],favorites:[]}])]);
 await a.config('save',['dccons',[first],[]]);
 await b.config('save',['favorites',[{path:'favorite',ext:'gif'}],[]]);
 await Promise.all([a.config('save',['dccons',[first,second],[first]]),b.config('save',['dccons',[{info:{package_idx:'3'}}],[]])]);
 const data=await b.config('open',[{dccons:[]}]);
 assert.deepEqual(data.settings.dccons.map(p=>p.info.package_idx).sort(),['1','2','3']);
 assert.equal(data.settings.favorites.length,1);
 await b.config('save',['dccons',[],[second]]);
 assert.deepEqual((await a.config('open',[{}])).settings.dccons.map(p=>p.info.package_idx).sort(),['1','3']);
 a.dispose();b.dispose();
 const reopened=createConfig(indexedDB);
 assert.equal((await reopened.config('open',[{dccons:[]}])).settings.dccons.length,2);reopened.dispose();
});
function fixture() {
 const {window}=new JSDOM('<form id="main"><input type="file" multiple><div role="textbox" contenteditable="true">main draft</div></form><form id="thread"><input type="file" multiple><div role="textbox" contenteditable="true">thread draft</div></form>',{url:'https://discord.com/channels/1/2'});
 const page={Event:window.Event,File:window.File,MutationObserver:window.MutationObserver,location:window.location,
  setTimeout:fn=>setTimeout(fn,30),clearTimeout,
  DataTransfer:class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}}};
 const bridge=createComposerBridge(page,window.document),editors=[...window.document.querySelectorAll('[role=textbox]')];
 for(const e of editors)e.getClientRects=()=>[{}];
 const files=[new window.File(['one'],'one.gif',{type:'image/gif'}),new window.File(['two'],'two.gif',{type:'image/gif'})];
 let sequence=0;
 function add(form,name){const node=window.document.createElement('li');node.setAttribute('data-list-item-id','attachments___'+ ++sequence);const label=window.document.createElement('span');label.className='filename_hash';label.textContent=name;node.append(label);form.append(node);}
 for(const input of window.document.querySelectorAll('input'))Object.defineProperty(input,'files',{value:[],writable:true});
 return {window,page,bridge,editors,files,add};
}
test('the button-bound composer receives all files, preserves text and never submits',async()=>{
 const {window,bridge,editors,files,add}=fixture();let submits=0,mainChanges=0;
 window.document.addEventListener('submit',()=>submits++);
 const main=editors[0].closest('form'),thread=editors[1].closest('form');
 main.querySelector('input').addEventListener('change',()=>mainChanges++);
 thread.querySelector('input').addEventListener('change',e=>{for(const file of e.target.files)add(thread,file.name);});
 const mainId=bridge.targetFor(editors[0]),threadId=bridge.targetFor(editors[1]);assert.notEqual(mainId,threadId);
 assert.equal(bridge.targetFor(editors[1]),threadId);
 await bridge.attachFiles(files,threadId);
 assert.equal(mainChanges,0);assert.equal(submits,0);assert.equal(thread.querySelectorAll('li').length,2);
 assert.equal(editors[0].textContent,'main draft');assert.equal(editors[1].textContent,'thread draft');
 thread.remove();assert.throws(()=>bridge.attachFiles(files,threadId),/입력창이 바뀌/);
});
test('route changes and replaced input elements invalidate a captured target',()=>{
 const {window,bridge,editors,files}=fixture();const id=bridge.targetFor(editors[0]);
 window.history.pushState({},'', '/channels/1/3');assert.throws(()=>bridge.attachFiles(files,id),/입력창이 바뀌/);
 const next=bridge.targetFor(editors[0]);assert.notEqual(next,id);
 const input=editors[0].closest('form').querySelector('input');input.replaceWith(input.cloneNode());
 assert.throws(()=>bridge.attachFiles(files,next),/입력창이 바뀌/);
});
test('exceeding existing attachment slots is rejected before dispatch',()=>{
 const {bridge,editors,files,add}=fixture(),form=editors[0].closest('form');let changes=0;
 form.querySelector('input').addEventListener('change',()=>changes++);
 for(let i=0;i<9;i++)add(form,'existing-'+i);
 assert.throws(()=>bridge.attachFiles(files,bridge.targetFor(editors[0])),/최대 10개/);assert.equal(changes,0);
});
test('a rejected or partial native change rejects instead of acknowledging attachment',async()=>{
 const {bridge,editors,files,add}=fixture(),form=editors[0].closest('form');
 await assert.rejects(bridge.attachFiles(files,bridge.targetFor(editors[0])),/수락을 확인하지 못/);
 form.querySelector('input').addEventListener('change',()=>add(form,files[0].name));
 await assert.rejects(bridge.attachFiles(files,bridge.targetFor(editors[0])),/수락을 확인하지 못/);
});
