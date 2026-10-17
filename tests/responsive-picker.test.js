const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const executablePath = [process.env.WEBP_TEST_BROWSER, chromium.executablePath()].find(p => p && fs.existsSync(p));

test('picker adapts to available width without shrinking the grid when collecting; keyboard and desktop layouts remain usable', {skip: !executablePath}, async t => {
  const source = require('esbuild').buildSync({stdin: {resolveDir: path.resolve(__dirname, '..'), contents: `
    import React from 'react';
    import * as ReactDOM from 'react-dom';
    import {createRoot} from 'react-dom/client';
    import {createEvents} from './src/core/events.ts';
    import {createPickerUI} from './src/core/ui/picker.ts';
    import {createToolbarUI} from './src/core/ui/toolbar.ts';
    const h=React.createElement, events=createEvents();
    const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="12" fill="#a6e4cf"/></svg>');
    const cons=Array.from({length:30},(_,i)=>({idx:i,title:'콘 '+i,path:String(i),ext:'png'}));
    const pack={info:{package_idx:'1',title:'테스트 팩'},detail:cons};
    const queues={}, sending={setCurrentChannel:()=>{},isSending:()=>false,activeQueue:id=>queues[id]||[],removeBuffered(id,entry){queues[id]=entry?queues[id].filter(e=>e!==entry):[];events.dispatch({type:'DCCON_BUFFER_UPDATE'});},sendDCConMessage:async(con,options)=>{window.selections.push(options);if(options.keepOpen){queues.one=[...(queues.one||[]),{con,file:new File(['x'],'image.webp')}];events.dispatch({type:'DCCON_BUFFER_UPDATE'});}}};
    const platform={react:React,reactDOM:{...ReactDOM,createRoot},discord:{classes:{textarea:{}},locale:{locale:'ko'}},composer:{attachFiles(){}}};
    const image=props=>h('img',{src:svg,alt:props.alt||props.title||''});
    const media={DCConImage:image,PersonalImage:image,BufferImage:image,PackThumbnail:image,ManduIcon:()=>h('span',null,'●')};
    const picker=createPickerUI(platform,{settings:{loadData:(_,fallback)=>fallback},packs:{pickerPacks:()=>[pack],personalCons:()=>[],setExpanded(){},toggleFavorite(){}},images:{mergeImageReason:async files=>files.length>=2&&files.length<=3?'':'이미지 2~3개를 모아 주세요.'},sending,embedding:{enabled:()=>false,status:{},cancelSearch(){}},events,media});
    const {DCConButton}=createToolbarUI(platform,sending,events,media,picker,{DCConSettingsPanel:()=>h('div',null,'설정')});
    const root=createRoot(document.getElementById('root'));window.selections=[];
    root.render(h(DCConButton,{channelId:'one'}));
    window.setQueue=n=>{queues.one=Array.from({length:n},(_,i)=>({con:cons[i],file:new File(['x'],'image.webp')}));events.dispatch({type:'DCCON_BUFFER_UPDATE'});};
  `}, bundle:true, write:false, format:'iife', platform:'browser', define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:360,height:780},hasTouch:true});
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await page.setContent(`<style>body{margin:0;background:#313338}#root{position:fixed;right:8px;bottom:8px}${fs.readFileSync(path.join(__dirname,'../src/core/style.css'),'utf8')}</style><div id="root"></div>`);
  await page.addScriptTag({content:source});await page.locator('.dccon-trigger').click();
  const geometry=()=>page.evaluate(()=>{
    const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const popup=document.querySelector('.dccon-popover'),grid=document.querySelector('.dccon-items'),tray=document.querySelector('.dccon-buffer');
    return {compact:popup.classList.contains('dccon-popover-compact'),popup:box(popup),main:box(document.querySelector('.dccon-popover-main')),tray:box(tray),
      columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,grid:box(grid),item:box(document.querySelector('.dccon-item')),railDirection:getComputedStyle(document.querySelector('.dccon-rail')).flexDirection,
      thumb:box(document.querySelector('.dccon-buffer-items button')),horizontalOverflow:popup.scrollWidth>popup.clientWidth,
      actions:[...document.querySelectorAll('.dccon-buffer-send,.dccon-buffer-split,.dccon-buffer-merge')].map(box),list:box(document.querySelector('.dccon-browser-content'))};
  });
  for(const width of [320,360,390,430,590,600,1024]) {
    await page.setViewportSize({width,height:780});await page.evaluate(()=>setQueue(0));
    await page.waitForFunction(()=>!document.querySelector('.dccon-buffer'));
    assert.notEqual(await page.locator('.dccon-footer').evaluate(e=>getComputedStyle(e).display),'none');
    const before=await geometry();assert.equal(before.compact,width<600);
    if(width<600)assert.equal(before.columns,4);
    for(const count of [1,3,9]) {
      await page.evaluate(n=>setQueue(n),count);await page.waitForFunction(n=>document.querySelector('.dccon-buffer')?.dataset.count===String(n),count);
      const g=await geometry();assert.equal(g.horizontalOverflow,false);assert.ok(g.popup.x>=0&&g.popup.right<=width);
      assert.equal(await page.locator('.dccon-footer').evaluate(e=>getComputedStyle(e).display),'none');
      if(width<600){
        assert.equal(g.columns,4);assert.equal(g.grid.width,before.grid.width);
        assert.equal(g.railDirection,'row');assert.ok(g.tray.y>=g.main.bottom-1);assert.equal(g.thumb.width,52);assert.equal(g.thumb.height,52);
        assert.ok(g.list.height>=150);for(const a of g.actions){assert.ok(a.height>=44);assert.ok(a.bottom<=g.popup.bottom);}
      }else{assert.equal(g.railDirection,'column');assert.ok(g.tray.right<=g.main.x+1);}
    }
  }
  // A narrow visual viewport must activate the layout even with a wide layout viewport.
  await page.evaluate(()=>{const v=Object.assign(new EventTarget(),{width:360,height:320,offsetLeft:0,offsetTop:0});Object.defineProperty(window,'visualViewport',{configurable:true,value:v});window.dispatchEvent(new Event('resize'));});
  await page.waitForFunction(()=>document.querySelector('.dccon-popover-short'));
  const short=await geometry();assert.equal(short.compact,true);assert.equal(short.columns,4);assert.ok(short.popup.bottom<=320);assert.ok(short.list.height>=44);
  for(const a of short.actions)assert.ok(a.bottom<=short.popup.bottom);
  await page.evaluate(()=>{delete window.visualViewport;window.dispatchEvent(new Event('resize'));setQueue(0);});
  await page.setViewportSize({width:390,height:780});await page.waitForFunction(()=>!document.querySelector('.dccon-buffer'));
  await page.evaluate(()=>setQueue(9));await page.waitForFunction(()=>document.querySelector('.dccon-buffer-items')?.dataset.count==='9');
  const strip=await page.locator('.dccon-buffer-preview').boundingBox(),start={x:strip.x+strip.width-30,y:strip.y+26,id:1};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  for(let i=1;i<=5;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...start,x:start.x-i*25}]});await page.waitForTimeout(30);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(await page.locator('.dccon-buffer-preview').evaluate(e=>e.scrollLeft>0));
  assert.equal(await page.locator('.dccon-buffer-items').getAttribute('data-count'),'9','swiping thumbnails must not remove an image');
  await page.getByRole('button',{name:'전체 비우기',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.dccon-buffer'));
  const item=page.locator('.dccon-item').first(),box=await item.boundingBox(),p={x:box.x+box.width/2,y:box.y+box.height/2,id:1};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await page.waitForTimeout(650);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('.dccon-buffer-items')?.dataset.count==='1');
  assert.deepEqual(await page.evaluate(()=>selections.map(s=>s.keepOpen)),[true],'layout change must not turn a held touch into a send');
  await page.locator('.dccon-buffer-items button').click();await page.waitForFunction(()=>!document.querySelector('.dccon-buffer'));
  assert.equal((await geometry()).columns,4);
});
