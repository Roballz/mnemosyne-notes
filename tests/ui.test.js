import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { parseHTML } from 'linkedom/worker';
import 'fake-indexeddb/auto';
import * as db from '../lib/db.js';
import { reader } from '../lib/dom.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) {
    for(let i=0;i<180;i++){const result=await fn();if(result)return result;await delay(10);}
    throw Error('等待界面或事件超时');
}
function setup() {
    const {document,Event,HTMLElement,HTMLSelectElement,MutationObserver}=parseHTML(
        '<html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_block"></div></div></div></body></html>');
    Object.assign(globalThis,{document,MutationObserver,innerWidth:390,innerHeight:800});
    const store=new Map();
    globalThis.localStorage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
    // Supply browser surfaces missing in the headless DOM implementation.
    HTMLElement.prototype.showModal=function(){this.open=true;};
    HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    HTMLElement.prototype.setPointerCapture=HTMLElement.prototype.releasePointerCapture=function(){};
    const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
    Object.defineProperty(HTMLSelectElement.prototype,'value',{...descriptor,set(v){
        for(const o of this.options){if(o.value===v)o.setAttribute('selected','');else o.removeAttribute('selected');}
    }});
    const floor=document.querySelector('.mes');document.elementsFromPoint=()=>[floor];
    const listeners=new Map();
    const names=['CHAT_CHANGED','APP_READY','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_SENT','MESSAGE_DELETED','MESSAGE_EDITED','MESSAGE_SWIPED','GENERATION_ENDED'];
    const ctx={getCurrentChatId:()=>'synthetic',characterId:1,chat:[{mes:'开场线索',send_date:1}],
        eventTypes:Object.fromEntries(names.map(n=>[n,n])),eventSource:{on:(name,fn)=>listeners.set(name,fn)}};
    globalThis.SillyTavern={getContext:()=>ctx};
    // Execute the shipped browser worker module in a real separate Node thread.
    const workers=[];
    globalThis.Worker=class {
        constructor(url){
            const body=`import { parentPort } from 'node:worker_threads';globalThis.self=globalThis;
            self.postMessage=m=>parentPort.postMessage(m);await import(${JSON.stringify(url.href)});
            parentPort.on('message',data=>self.onmessage({data}));`;
            this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(body)),{type:'module'});
            this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',e=>this.onerror?.(e));workers.push(this.worker);
        }
        postMessage(m){this.worker.postMessage(m);} terminate(){this.worker.terminate();}
    };
    return {document,ctx,emit:(name,id)=>listeners.get(name)?.(id),workers};
}
test('正常入口：气泡收藏、当场新建、多选与换批、手势、三主题、后台陌生名称归类',async t=>{
    const {document:d,ctx,emit,workers}=setup();
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const key=JSON.stringify(['character',1,'synthetic']);
    await db.mutateBook(key,b=>{b.tags=Array.from({length:15},(_,i)=>({name:'词'+i,last:Date.now(),score:20-i}));});
    const {activate}=await import('../index.js');activate();
    await until(()=>d.querySelector('.mn-floor-action'));await delay(30);
    assert.equal(d.querySelectorAll('.mn-head').length,1);
    const clickText=(host,text)=>{const el=[...host.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(el,text);el.click();};
    const head=d.querySelector('.mn-head');head.click();
    let dialog=await until(()=>d.querySelector('dialog'));assert.ok(dialog.textContent.includes('开场线索'));
    dialog.querySelector('textarea').value='收藏备注';
    for(const [i,value] of ['人物甲','合集乙'].entries()){
        [...dialog.querySelectorAll('button')].filter(b=>b.textContent==='＋ 新建')[i].click();
        const inline=dialog.querySelectorAll('.mn-inline')[i];inline.querySelector('input').value=value;clickText(inline,'添加');
    }
    clickText(dialog,'换一批');clickText(dialog,'词11');
    dialog.querySelector('input[placeholder*="逗号"]').value='自填';
    clickText(dialog,'确认收藏');await until(()=>!d.querySelector('dialog'));
    const note=(await db.list(key,'note')).rows[0];assert.deepEqual([note.people,note.folders,note.tags],[['人物甲'],['合集乙'],['词11','自填']]);
    d.querySelector('.mn-floor-action').click();dialog=await until(()=>d.querySelector('dialog'));assert.ok(dialog.textContent.includes('编辑收藏'));
    dialog.close();
    head.onpointerdown({isPrimary:true,button:0,pointerId:1,clientX:382,clientY:300});
    head.onpointermove({pointerId:1,clientX:270,clientY:304});
    head.onpointerup({pointerId:1,clientX:270,clientY:304});
    assert.equal(d.querySelector('#mnemosyne-notes').dataset.open,'yes');
    await until(()=>d.querySelector('.mn-entry'));
    clickText(d,'按人物');await until(()=>[...d.querySelectorAll('.mn-group')].some(b=>b.textContent==='人物甲'));
    clickText(d,'人物甲');await until(()=>[...d.querySelectorAll('.mn-group')].some(b=>b.textContent==='合集乙'));
    clickText(d,'设置');for(const [name,theme] of [['深蓝 · 深色','dark'],['墨绿 · 霓虹','neon'],['白绿 · 浅色','light']]){
        clickText(d,name);assert.equal(d.querySelector('#mnemosyne-notes').dataset.theme,theme);
    }
    d.querySelector('.mn-panel [aria-label="关闭"]').click();
    ctx.chat.push({mes:'<div data-nvwa-ui="新信箱"><div>21:08</div>晚安<button>草稿</button></div>',send_date:2});
    emit('MESSAGE_RECEIVED',1);emit('GENERATION_ENDED',1);
    const toast=await until(()=>[...d.querySelectorAll('.mn-toast')].find(x=>x.textContent.includes('待归类')));
    toast.click();dialog=await until(()=>d.querySelector('dialog'));
    dialog.querySelector('.mn-select').click();clickText(d.querySelector('.mn-picker'),'合集乙');clickText(dialog,'归类并记住此名称');
    await until(async()=>(await db.list(key,'block',{folder:'合集乙'})).rows.length===1);
    clickText(d,'打开 Mnemosyne记事簿');clickText(d,'消息');await until(()=>d.querySelector('.mn-group')?.textContent==='合集乙');
    clickText(d,'合集乙');await until(()=>d.querySelector('.mn-entry')?.textContent.includes('新信箱'));
    d.querySelector('.mn-entry').click();await until(()=>d.querySelector('.mn-reading'));
    assert.match(d.querySelector('.mn-reading').textContent,/21:08晚安/);assert.ok(!d.querySelector('.mn-reading').textContent.includes('草稿'));
    const safe=reader('<script>secret</script><img src="x" onerror="noop()"><div onclick="x()">安全</div>');
    assert.equal(safe.textContent,'安全');assert.equal(safe.querySelector('script,img,[onclick]'),null);
});

test('旧宿主注册过晚后仍可恢复聊天，未进聊天也可调整两个独立气泡',async t=>{
    const {document:d,ctx,workers}=setup();
    let id='', registrations=0, syncs=0;
    ctx.getCurrentChatId=()=>id;
    globalThis.__TAURITAVERN__={api:{
        chatSurface:{isManagedOwnershipRequired:()=>true,registerParticipant:()=>{registrations++;throw Error('registration closed');}},
        chat:{current:{ref:()=>null,handle:()=>{throw Error('handle unavailable');},windowInfo:async()=>{syncs++;throw Error('info unavailable');}}},
    }};
    t.after(async()=>{delete globalThis.__TAURITAVERN__;for(const w of workers)await w.terminate();});
    const {activate,registerChatSurface}=await import('../index.js?late-binding');
    registerChatSurface();activate();await delay(5);
    const root=d.querySelector('#mnemosyne-notes'),head=root.querySelector('.mn-head');
    assert.equal(registrations,1);
    d.querySelector('#mn-open-settings').click();
    root.querySelector('[data-tab=settings]').click();
    const pick=(label,text)=>{
        root.querySelector('[aria-label="'+label+'"]').click();
        [...root.querySelectorAll('.mn-picker .mn-option')].find(b=>b.textContent===text).click();
    };
    pick('外部气泡样式','磨砂光感玻璃');
    assert.equal(root.dataset.glass,'frost');
    const tone=root.querySelector('[aria-label="自定义色值"]');tone.value='#99aacc';tone.onchange();
    assert.equal(root.style.getPropertyValue('--mn-rgb'),'153,170,204');
    pick('悬浮图标','自定义文字或表情');
    pick('导航栏位置','底部');assert.equal(root.dataset.nav,'bottom');
    const select=root.querySelector('[aria-label="导航栏位置"]');
    for(const [type,y] of [['pointerdown',110],['pointermove',147],['pointerup',148],['click',148]]){
        const ev=Object.assign(new document.defaultView.Event(type,{bubbles:true}),{detail:1,clientX:50,clientY:y});
        select.dispatchEvent(ev);
    }
    assert.equal(root.querySelector('.mn-picker'),null);
    const glyph=root.querySelector('[aria-label="自定义图标文字"]');glyph.value='🌙';glyph.onchange();
    assert.equal(head.textContent,'🌙');
    const headControl=root.querySelector('[aria-label="悬浮头高度"]');
    const noticeControl=root.querySelector('[aria-label="通知单行高度"]');
    const transparency=root.querySelector('[aria-label="气泡透明度"]');
    assert.equal(transparency.value,'0');
    const prior=localStorage.getItem('mnemosyne-notes:appearance');
    transparency.value='65';transparency.oninput();
    assert.equal(root.style.getPropertyValue('--mn-bubble-opacity'),'0.35');
    assert.equal(transparency.getAttribute('aria-valuetext'),'65%');
    assert.equal(localStorage.getItem('mnemosyne-notes:appearance'),prior);
    transparency.onchange();assert.equal(JSON.parse(localStorage.getItem('mnemosyne-notes:appearance')).transparency,65);
    const before=localStorage.getItem('mnemosyne-notes:appearance');
    headControl.value='30';headControl.oninput();
    assert.equal(root.style.getPropertyValue('--mn-head-size'),'30px');
    assert.equal(root.style.getPropertyValue('--mn-notice-size'),'34px');
    assert.equal(localStorage.getItem('mnemosyne-notes:appearance'),before);headControl.onchange();
    noticeControl.value='52';noticeControl.oninput();noticeControl.onchange();
    const saved=JSON.parse(localStorage.getItem('mnemosyne-notes:appearance'));
    assert.deepEqual([saved.headSize,saved.noticeSize,saved.glyph],[30,52,'🌙']);assert.equal(syncs,0);
    root.querySelector('.mn-panel [aria-label="关闭"]').click();
    id='late-chat';head.click();
    const dialog=await until(()=>d.querySelector('dialog'));
    assert.ok(dialog.textContent.includes('开场线索'));assert.equal(registrations,1);
    dialog.close();id='another-chat';ctx.chat=[{mes:'切档后的线索',send_date:2}];head.click();
    assert.ok((await until(()=>d.querySelector('dialog'))).textContent.includes('切档后的线索'));
});

test('从三级目录浏览到编辑删除，以及未分类详情的黑名单确认与取消',async t=>{
    const {document:d,ctx,workers}=setup();
    ctx.getCurrentChatId=()=>'directory-flow';
    ctx.chat=[{mes:'<div data-nvwa-ui="崔冬来信">信件</div><div data-nvwa-ui="浮窗">无关</div>',send_date:2}];
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const key=JSON.stringify(['character',1,'directory-flow']);
    const {blankFolder}=await import('../lib/model.js');
    await db.mutateBook(key,b=>{b.folders.push(blankFolder('崔冬'),{...blankFolder('微信'),parent:'崔冬'},
        {...blankFolder('来信'),parent:'微信',names:['崔冬来信']});});
    const {activate}=await import('../index.js?directory-flow');activate();
    const click=async(scope,label)=>{
        const item=await until(()=>[...scope.querySelectorAll('button')].find(b=>b.textContent===label));item.click();
    };
    await until(()=>d.querySelector('#mn-open-settings'));d.querySelector('#mn-open-settings').click();
    const panel=d.querySelector('.mn-panel');
    await click(panel,'消息');
    for(const dir of ['崔冬','微信','来信'])await click(panel,dir);
    await until(()=>panel.querySelector('.mn-entry')?.textContent.includes('崔冬来信'));
    await click(panel,'编辑目录');
    let editor=d.querySelector('dialog');
    await click(editor,'删除合集');
    await click(d.querySelector('.mn-confirm-dialog'),'取消');
    assert.ok((await db.getBook(key)).folders.some(f=>f.name==='来信'));
    await click(editor,'删除合集');await click(d.querySelector('.mn-confirm-dialog'),'确认删除');
    let manager=await until(()=>d.querySelector('dialog[aria-label="目录管理"]'));
    const search=manager.querySelector('[aria-label="搜索目录"]');search.value='微信';search.oninput();
    assert.ok(manager.querySelector('.mn-tree-entry').textContent.includes('崔冬 / 微信'));
    // Add a third-level folder through the same editor the user gets in the manager.
    manager.querySelector('[aria-label="在「微信」新建子目录"]').click();
    editor=d.querySelector('dialog[aria-label="新建合集"]');
    editor.querySelector('[placeholder="目录名称"]').value='视频';
    editor.querySelector('textarea').value='微信视频';editor.querySelector('[placeholder*="玦"]').value='玦；崔冬';
    await click(editor,'保存合集');
    manager=await until(()=>d.querySelector('dialog[aria-label="目录管理"]'));
    const saved=(await db.getBook(key)).folders.find(f=>f.name==='视频');
    assert.equal(saved.parent,'微信');assert.deepEqual(saved.persons,['玦','崔冬']);
    manager.close();
    await click(panel,'未分类');
    const entry=await until(()=>[...panel.querySelectorAll('.mn-entry')].find(b=>b.textContent.includes('浮窗')));
    entry.click();
    const detail=await until(()=>d.querySelector('dialog[aria-label="浮窗"]'));
    await click(detail,'过滤此名称（黑名单）');await click(d.querySelector('.mn-confirm-dialog'),'取消');
    assert.deepEqual((await db.getBook(key)).ignoreNames,[]);
    await click(detail,'过滤此名称（黑名单）');await click(d.querySelector('.mn-confirm-dialog'),'确认过滤');
    await until(async()=>(await db.getBook(key)).ignoreNames.includes('浮窗'));
    await until(()=>!panel.textContent.includes('浮窗') && panel.textContent.includes('崔冬来信'));
    assert.equal((await db.getBook(key)).folders.some(f=>f.name==='来信'),false);
});

test('从设置启用双私信拆分，再从未分类记住其中一页',async t=>{
    const {document:d,ctx,workers}=setup();
    ctx.getCurrentChatId=()=>'tab-mailbox';
    ctx.chat=[{mes:'<div data-nvwa-ui="界内·新消息" style="background:#1d2026;color:#d9d4c7"><div data-nvwa-tabs><div data-tab="槐下听雨 · 12">第一封</div><div data-tab="无字碑 · 6">第二封</div></div></div>'}];
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const key=JSON.stringify(['character',1,'tab-mailbox']);
    const {activate}=await import('../index.js?tab-mailbox');activate();
    await until(()=>d.querySelector('#mn-open-settings'));d.querySelector('#mn-open-settings').click();
    const click=async(scope,label)=>(await until(()=>[...scope.querySelectorAll('button')].find(b=>b.textContent===label))).click();
    const panel=d.querySelector('.mn-panel');await click(panel,'设置');await click(panel,'拆分多标签消息');
    const form=d.querySelector('dialog');form.querySelector('textarea').value='界内·新消息';await click(form,'保存');
    await until(async()=>(await db.list(key,'block')).rows.length===2);
    await click(panel,'消息');await click(panel,'未分类');
    const entry=await until(()=>[...panel.querySelectorAll('.mn-entry')].find(b=>b.textContent.includes('槐下听雨')));
    entry.click();
    const detail=await until(()=>d.querySelector('dialog[aria-label="界内·新消息 / 槐下听雨"]'));
    await until(()=>detail.querySelector('.mn-reading'));
    assert.equal(detail.querySelector('.mn-reading').textContent,'第一封');
    const formats=[];
    ctx.messageFormatting=text=>{formats.push(text);return text;};
    await click(detail,'前端');
    const frame=await until(()=>detail.querySelector('iframe'));
    assert.equal(formats.length,1);assert.match(formats[0],/color:#d9d4c7/);
    assert.match(formats[0],/第一封/);assert.doesNotMatch(formats[0],/第二封|无字碑/);
    assert.match(frame.srcdoc,/color:#d9d4c7/);
    assert.match(frame.srcdoc,/第一封/);assert.doesNotMatch(frame.srcdoc,/第二封/);
    assert.equal(JSON.parse(localStorage.getItem('mnemosyne-notes:appearance')).readingMode,'frontend');

    await click(detail,'选择合集并记住此名称');
    const assign=d.querySelector('dialog[aria-label="将消息归入合集"]');
    assign.querySelector('input').value='槐下的私信';await click(assign,'归类并记住此名称');
    await until(async()=>(await db.list(key,'block',{folder:'槐下的私信'})).rows.length===1);
    assert.deepEqual((await db.list(key,'block',{folder:''})).rows.map(r=>r.name),['界内·新消息 / 无字碑']);
});

test('未分类跨页多选一次保存别名并重分类，收藏隐藏三级时保留已选合集',async t=>{
    const {document:d,ctx,workers}=setup();
    ctx.getCurrentChatId=()=>'batch-picker';
    ctx.chat=Array.from({length:39},(_,i)=>({mes:'<div data-nvwa-ui="来信'+i+'">正文</div>',send_date:i+1}));
    const key=JSON.stringify(['character',1,'batch-picker']);
    const {blankFolder}=await import('../lib/model.js');
    await db.mutateBook(key,b=>{b.folders=['一','二','三'].map((n,i)=>({...blankFolder(n),parent:['','一','二'][i]}));});
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const {activate}=await import('../index.js?batch-picker');activate();
    const click=async(scope,label)=>(await until(()=>[...scope.querySelectorAll('button')].find(b=>b.textContent===label))).click();
    (await until(()=>d.querySelector('#mn-open-settings'))).click();
    const panel=d.querySelector('.mn-panel');
    await click(panel,'消息');
    await until(async()=>(await db.list(key,'block',{},null,40)).rows.length===39);
    await click(panel,'未分类');await click(panel,'多选');
    panel.querySelector('.mn-entry').click();await click(panel,'查看更多');
    (await until(()=>panel.querySelectorAll('.mn-entry')[38])).click();
    await click(panel,'加入合集（2）');
    const form=d.querySelector('dialog[aria-label="将消息归入合集"]');
    form.querySelector('.mn-select').click();await click(d.querySelector('.mn-picker'),'一 / 二 / 三');
    await click(form,'归类并记住此名称');
    await until(async()=>(await db.list(key,'block',{folder:'三'})).rows.length===2);
    const book=await db.getBook(key);
    assert.equal(book.revision,2);
    assert.deepEqual(book.folders[2].names.sort(),['来信0','来信38']);

    d.querySelector('.mn-floor-action').click();
    let editor=await until(()=>d.querySelector('dialog[aria-label="收藏楼层"]'));
    assert.ok(!editor.textContent.includes('一 / 二 / 三'));
    await click(editor,'显示三级');await click(editor,'一 / 二 / 三');await click(editor,'显示三级');
    await click(editor,'确认收藏');
    await until(async()=>(await db.list(key,'note')).rows[0]?.folders.includes('三'));
    d.querySelector('.mn-floor-action').click();
    editor=await until(()=>d.querySelector('dialog[aria-label="编辑收藏"]'));
    assert.ok(!editor.textContent.includes('一 / 二 / 三'));
    await click(editor,'显示三级');
    assert.equal([...editor.querySelectorAll('.mn-chip')].find(b=>b.textContent==='一 / 二 / 三').getAttribute('aria-pressed'),'true');
});

test('收藏正文的操作与楼层切换固定在阅读区外，两种显示共用内侧视窗',async()=>{
    const {document:d,ctx}=setup();
    const {View}=await import('../lib/view.js');
    const root=d.createElement('main');d.body.append(root);
    const prefs={readingMode:'plain'},view=new View(root,prefs,p=>Object.assign(prefs,p));
    const msg={mes:'“正文”'};
    view.engine={alive:()=>true,host:{offset:0},source:async()=>({msg,floor:5})};
    ctx.messageFormatting=()=>'<q>“正文”</q>';
    await view.detail({key:['chat','note'],floor:4,note:'长备注'.repeat(60)});
    const dialog=d.querySelector('.mn-note-dialog');
    const header=dialog.firstElementChild,toolbar=dialog.querySelector('.mn-reader-toolbar');
    assert.ok(header.textContent.includes('编辑备注与标签'));assert.ok(header.textContent.includes('取消收藏'));
    assert.equal(toolbar.querySelector('.mn-floor').textContent,'#5');
    const viewport=dialog.querySelector('.mn-reader-viewport');
    assert.ok(viewport.querySelector('.mn-reading'));
    toolbar.querySelector('button').click();
    await until(()=>viewport.querySelector('iframe'));assert.equal(viewport.children.length,1);
    assert.ok(!viewport.querySelector('button'));assert.equal(dialog.querySelectorAll('.mn-modes').length,1);
});

test('状态栏隐藏设置可按范围操作并保留最近楼，关闭后重开读取现状',async t=>{
    const {document:d,ctx,workers}=setup();
    ctx.getCurrentChatId=()=>'visibility-panel';
    ctx.chat=Array.from({length:25},(_,i)=>({mes:'楼'+i,send_date:i}));
    ctx.chat[0].is_system=true;let saves=0;
    ctx.saveChat=async()=>{saves++;};
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const {activate}=await import('../index.js?visibility-panel');activate();
    (await until(()=>d.querySelector('#mn-open-settings'))).click();
    const status=d.querySelector('.mn-status');
    await until(()=>status.textContent.includes('当前已隐藏 1 楼'));
    await until(()=>status.textContent.includes('历史已整理'));
    status.querySelector('button').click();
    const form=d.querySelector('dialog[aria-label="隐藏楼层设置"]');
    const [start,end,keep]=form.querySelectorAll('input[type="number"]'),opening=form.querySelector('input[type="checkbox"]');
    assert.deepEqual([start.value,end.value,keep.value,opening.checked],['0','24','20',false]);
    const click=text=>[...form.querySelectorAll('button')].find(b=>b.textContent===text).click();
    end.value='4';end.oninput();click('隐藏楼层');
    await until(()=>form.querySelector('.mn-hidden-total').textContent.includes(' 5 楼'));
    assert.ok(status.textContent.includes(' 5 楼'));
    click('取消隐藏');await until(()=>status.textContent.includes(' 0 楼'));
    opening.checked=true;opening.onchange();click('隐藏更早楼层');
    await until(()=>status.textContent.includes(' 4 楼'));assert.equal(saves,3);
    assert.ok(!ctx.chat[0].is_system && ctx.chat[1].is_system && !ctx.chat[5].is_system);
    form.close();d.querySelector('.mn-panel [aria-label="关闭"]').click();
    ctx.chat[12].is_system=true;
    d.querySelector('#mn-open-settings').click();
    await until(()=>status.textContent.includes(' 5 楼'));
});
