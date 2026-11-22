import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { WorkbenchView } from '../lib/workbench/view.js';
import { reviewBatch } from '../lib/workbench/review.js';
import { settingsWithDefaults } from '../lib/workbench/model.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<80;i++){const value=fn();if(value)return value;await wait(5);}throw Error('UI did not settle');}
function setup(){
    const {document,Event,HTMLElement,HTMLSelectElement}=parseHTML('<html><body><div class="mn-notebook"></div></body></html>');
    globalThis.document=document;globalThis.Worker=undefined;
    HTMLElement.prototype.showModal=function(){this.open=true;};
    HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
    Object.defineProperty(HTMLSelectElement.prototype,'value',{...descriptor,set(v){for(const option of this.options){if(option.value===v)option.setAttribute('selected','');else option.removeAttribute('selected');}}});
    const items=[
        {id:'a',title:'合成世界条目',target:{id:'world:w:1',kind:'world',world:'合成世界',uid:1},action:'replace',before:{content:'旧甲\n共同',metadata:{comment:'合成世界条目',key:['旧词'],position:0}},after:{content:'新甲\n共同',metadata:{comment:'合成世界条目',key:['新词'],position:0}}},
        {id:'b',title:'合成User设定',target:{id:'user:u:description',kind:'user'},action:'replace',before:{content:'旧乙',metadata:{}},after:{content:'新乙',metadata:{}}},
        {id:'c',title:'合成Char设定',target:{id:'char:c:description',kind:'char'},action:'replace',before:{content:'旧丙',metadata:{}},after:{content:'新丙',metadata:{}}},
    ];
    const batch={id:'batch-1',index:0,status:'review',items,report:{}},writes=[],drafts=[];
    const c={
        settings:settingsWithDefaults(),state:{mode:'archive',archivedFloor:100},scope:{chatKey:'synthetic'},lastFloor:150,
        selected:new Set(['world:w:1']),targets:[],worlds:[],presets:[],running:false,saving:false,
        job:{id:'job',mode:'archive',status:'review',firstFloor:100,lastFloor:150,batches:[batch],messages:[],plan:[]},
        subscribe:()=>()=>{},open:async()=>{},stop:()=>{c.stopped=true;},
        currentBatch:()=>batch,saveDraft:async(value,index)=>{drafts.push({value:structuredClone(value),index});},
        saveReviewed:async value=>{writes.push(structuredClone(value));c.job.status='done';return {complete:true};},
    };
    const view=new WorkbenchView(document.querySelector('.mn-notebook'),{controller:c});
    const click=(host,label)=>{const el=[...host.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(el,label);el.click();};
    return {document,c,view,batch,writes,drafts,click};
}
test('sequential review edits directly, skips one target, and saves only at final button',async()=>{
    const {view,document,writes,drafts,click}=setup();const dialog=reviewBatch(view);
    await until(()=>dialog.querySelector('.mn-wb-add'));
    assert.match(dialog.querySelector('.mn-wb-old').textContent,/旧甲/);
    assert.match(dialog.textContent,/待处理 1 \/ 3/);
    const edit=dialog.querySelector('.mn-wb-editor');edit.value='人工修订甲\n共同';edit.oninput();
    click(dialog,'继续下一个');await until(()=>dialog.textContent.includes('待处理 2 / 3'));
    assert.equal(writes.length,0);assert.equal(drafts.at(-1).value[0].after.content,'人工修订甲\n共同');
    click(dialog,'跳过本项');await until(()=>dialog.textContent.includes('待处理 3 / 3'));
    assert.ok([...dialog.querySelectorAll('button')].some(b=>b.textContent==='全部保存'));
    click(dialog,'全部保存');await until(()=>writes.length===1);await until(()=>!document.querySelector('dialog'));
    assert.equal(writes[0][0].accepted,true);assert.equal(writes[0][1].accepted,false);assert.equal(writes[0][2].accepted,true);
    assert.equal(writes[0][0].after.content,'人工修订甲\n共同');
});
test('closing review retains the draft without any host write',async()=>{
    const {view,writes,drafts}=setup(),dialog=reviewBatch(view),edit=dialog.querySelector('.mn-wb-editor');
    edit.value='尚未确认的改稿';edit.oninput();dialog.close();
    await until(()=>drafts.length>0);
    assert.equal(drafts.at(-1).value[0].after.content,'尚未确认的改稿');assert.equal(writes.length,0);
});
test('hiding the workbench does not stop a background run or touch story UI',async()=>{
    const {view,c,document}=setup();await view.open();c.running=true;view.close();
    assert.equal(document.querySelector('.mn-notebook').dataset.workbench,'no');
    assert.equal(c.stopped,undefined);assert.equal(c.running,true);
});
test('streaming updates reuse the live text node instead of rebuilding history',async()=>{
    const {view,c}=setup();c.running=true;c.job.messages=[{role:'user',content:'合成任务'}];c.liveText='前缀';
    await view.open();const message=view.body.querySelector('.mn-wb-message'),live=view.live;
    c.liveText='前缀追加';view.update('text');await wait(100);
    assert.equal(view.live,live);assert.equal(view.body.querySelector('.mn-wb-message'),message);assert.equal(live.textContent,'前缀追加');
    view.close();
});

test('an unfinished generation cannot open review through the toolbar or review entry point',async()=>{
    const {view,c,document,drafts}=setup();c.running=true;await view.open();
    const button=[...view.body.querySelectorAll('button')].find(b=>b.textContent==='本批仍在生成…');
    assert.ok(button);assert.equal(button.disabled,true);
    assert.throws(()=>reviewBatch(view),/等待|生成/);assert.equal(document.querySelector('dialog'),null);
    c.running=false;c.starting=true;assert.throws(()=>reviewBatch(view),/等待|生成/);
    c.starting=false;c.saving=true;assert.throws(()=>reviewBatch(view),/等待|保存/);
    assert.equal(drafts.length,0);view.close();
});

test('a proven failed intent stays immutable but can be skipped while the other items are saved',async()=>{
    const {view,batch,writes,drafts,click,document}=setup();
    batch.status='partial';batch.outcomes=[{itemId:'a',status:'failed',snapshotId:'synthetic-failed',error:'已确认未写入'}];
    const dialog=reviewBatch(view),skip=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='跳过本项');
    assert.equal(dialog.querySelector('.mn-wb-editor').readOnly,true);assert.equal(skip.disabled,false);
    click(dialog,'跳过本项');await until(()=>dialog.textContent.includes('待处理 2 / 3'));
    assert.equal(drafts.at(-1).value[0].accepted,false);
    click(dialog,'继续下一个');await until(()=>dialog.textContent.includes('待处理 3 / 3'));
    click(dialog,'全部保存');await until(()=>writes.length===1);await until(()=>!document.querySelector('dialog'));
    assert.equal(writes[0][0].accepted,false);assert.equal(writes[0][1].accepted,true);assert.equal(writes[0][2].accepted,true);
    assert.equal(writes[0][0].after.content,batch.items[0].after.content);
});

test('unknown write outcomes cannot be skipped or edited',async()=>{
    const {view,batch,drafts,writes}=setup();
    batch.status='partial';batch.outcomes=[{itemId:'a',status:'unknown',snapshotId:'synthetic-unknown',error:'保存结果未知'}];
    const dialog=reviewBatch(view),skip=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='跳过本项');
    assert.equal(skip.disabled,true);assert.equal(dialog.querySelector('.mn-wb-editor').readOnly,true);
    dialog.close();await until(()=>drafts.length>0);
    assert.notEqual(drafts.at(-1).value[0].accepted,false);assert.equal(writes.length,0);
});

test('review autosave carries the captured job and batch identity',async()=>{
    const {view,c,batch,drafts}=setup(),expected=[];const save=c.saveDraft;
    c.saveDraft=async(items,index,identity)=>{expected.push(structuredClone(identity));return save(items,index);};
    const dialog=reviewBatch(view),editor=dialog.querySelector('.mn-wb-editor');
    editor.value='合成审核草稿';editor.oninput();dialog.close();await until(()=>drafts.length>0);
    assert.deepEqual(expected,[{jobId:c.job.id,batchId:batch.id}]);
    assert.equal(drafts.at(-1).value[0].after.content,'合成审核草稿');
});
