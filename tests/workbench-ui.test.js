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
test('archive floor dialog reuses the current floor and can toggle manual onboarding',async()=>{
    const {view,c,document,click}=setup();c.job=null;
    const values=[];
    c.setArchivedFloor=async(floor,manualArchive)=>{values.push([floor,manualArchive]);Object.assign(c.state,{archivedFloor:floor,manualArchive});};
    await view.open();
    for(const enabled of [true,false]){
        click(view.progress,'100');
        const dialog=await until(()=>document.querySelector('dialog'));
        const toggle=dialog.querySelector('input[type="checkbox"]');
        assert.match(dialog.textContent,/从手动归档处接续/);
        assert.equal(toggle.checked,!enabled);
        toggle.checked=enabled;click(dialog,'确认');
        await until(()=>!document.querySelector('dialog'));
    }
    assert.deepEqual(values,[[100,true],[100,false]]);view.close();
});
test('hiding the workbench does not stop a background run or touch story UI',async()=>{
    const {view,c,document}=setup();await view.open();c.running=true;view.close();
    assert.equal(document.querySelector('.mn-notebook').dataset.workbench,'no');
    assert.equal(c.stopped,undefined);assert.equal(c.running,true);
});
test('a retained TT timeout opens its log on demand without retrying the request',async()=>{
    const {view,c,click}=setup(),reads=[];
    Object.assign(c.job,{status:'interrupted',error:'工作台请求超时',nativeRunId:'prior-run',config:{sourceId:'main'}});
    view.showRunLog=async id=>{reads.push(id);};
    await view.open();assert.deepEqual(reads,[]);
    click(view.taskbar,'查看上次 TT 运行记录');await until(()=>reads.length);
    assert.deepEqual(reads,['prior-run']);
    c.job.config.sourceId='independent';view.render();
    assert.doesNotMatch(view.taskbar.textContent,/查看上次 TT 运行记录/);view.close();
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
    const button=[...view.taskbar.querySelectorAll('button')].find(b=>b.textContent==='本批仍在生成…');
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

test('one conversation renders the plan table with lazy Markdown details and keeps selectors beside send',async()=>{
    const {view,c}=setup();
    c.job.status='planned';c.job.plan=[{title:'整理约定',instructions:'- **S-001** → 补充日期\n- 核对地点',targets:['S-001','P-002']}];
    c.job.planExplanation='## 需要确认\n\n先核对日期。';
    c.job.messages=[{role:'user',content:'整理本段'}, {role:'assistant',kind:'plan',content:''},{role:'assistant',content:'计划已提交，请确认。\n\n| 项目 | 状态 |\n|---|---|\n| 日期 | 待确认 |'}];
    await view.open();
    assert.equal(view.config.closest('.mn-wb-composer'),view.composer);
    assert.equal(view.body.querySelectorAll('.mn-wb-plan').length,1);
    assert.equal(view.body.querySelectorAll('table').length,2);
    assert.equal(view.body.querySelector('.mn-wb-task'),null);
    assert.equal(view.body.querySelector('.mn-wb-message>pre'),null);
    const detail=view.body.querySelector('.mn-wb-plan-detail');assert.equal(detail.hidden,true);assert.equal(detail.querySelector('.mn-wb-markdown'),null);
    view.body.querySelector('.mn-wb-batch-title').click();
    assert.equal(detail.hidden,false);assert.equal(detail.querySelectorAll('li').length,2);assert.equal(detail.querySelector('strong').textContent,'S-001');
    const message=view.body.querySelector('.mn-wb-user'),plan=view.body.querySelector('.mn-wb-plan');view.render();
    assert.equal(view.body.querySelector('.mn-wb-user'),message);assert.equal(view.body.querySelector('.mn-wb-plan'),plan);assert.equal(detail.hidden,false);
    view.close();
});

test('free mode remains discoverable during an idle archive task and picker listeners close cleanly',async()=>{
    const {view,c,click}=setup(),modes=[];c.job.status='planned';
    c.switchMode=async mode=>{modes.push(mode);};
    await view.open();assert.equal(view.mode.disabled,false);
    view.mode.click();assert.equal(view.mode.getAttribute('aria-expanded'),'true');
    const option=[...view.panel.querySelectorAll('[role=option]')].find(el=>el.textContent.startsWith('自由模式'));assert.ok(option);option.click();
    await until(()=>modes.length);assert.deepEqual(modes,['free']);assert.equal(view.mode.getAttribute('aria-expanded'),'false');
    view.apiPicker.trigger.click();assert.equal(view.apiPicker.trigger.getAttribute('aria-expanded'),'true');
    view.close();assert.equal(view.apiPicker.trigger.getAttribute('aria-expanded'),'false');
});

test('reasoning is separate and lazy; status/text bursts reuse existing message and live nodes',async()=>{
    const {view,c}=setup();c.running=true;c.liveReasoning='已返回的模型推理';c.liveText='';c.liveStatus='等待模型响应';
    c.job.messages=[{role:'assistant',content:'已有回复',reasoning:'旧推理'}];
    await view.open();const message=view.body.querySelector('.mn-wb-message'),live=view.live,reasoning=view.liveReasoning;
    const old=message.querySelector('.mn-wb-reasoning');assert.ok(old);assert.equal(old.querySelector('.mn-wb-markdown'),null);
    assert.equal(reasoning.hidden,false);assert.equal(view.liveReasoningText.textContent,'');
    reasoning.open=true;reasoning.ontoggle();assert.equal(view.liveReasoningText.textContent,c.liveReasoning);
    for(let i=0;i<100;i++){c.liveText='输出'+i;c.liveReasoning='推理'+i;view.update('text');}
    c.liveStatus='已收到模型正文';view.update('status');await wait(100);
    assert.equal(view.live,live);assert.equal(view.body.querySelector('.mn-wb-message'),message);assert.equal(view.liveReasoning,reasoning);
    assert.equal(live.textContent,'输出99');assert.equal(view.liveReasoningText.textContent,'推理99');assert.equal(view.liveStatus.textContent,'已收到模型正文');
    view.close();
});

test('progress unlocks task controls after the outer send finishes, and closing a modal shows a completed reply',async()=>{
    const {view,c}=setup();c.job.status='planned';c.starting=true;
    await view.open();const start=()=>[...view.taskbar.querySelectorAll('button')].find(b=>b.textContent==='开始第一批');
    assert.equal(start().disabled,true);c.starting=false;view.update('progress');assert.equal(start().disabled,false);
    const {el}=view.dialog('临时设置');c.job.messages.push({role:'assistant',content:'已在后台完成'});view.update('state');
    assert.doesNotMatch(view.body.textContent,/已在后台完成/);el.close();await until(()=>view.body.textContent.includes('已在后台完成'));view.close();
});

test('message rendering cache stays bounded to the visible 24-message window',async()=>{
    const {view,c}=setup();c.job.messages=Array.from({length:24},(_,i)=>({role:'assistant',content:'合成消息 '+i}));
    await view.open();const old=c.job.messages[0];assert.ok(view.messageCache.has(old));
    c.job.messages.push({role:'assistant',content:'最新消息'});view.render();
    assert.equal(view.messageCache.has(old),false);assert.equal(view.visibleMessages.size,24);assert.equal(view.body.querySelectorAll('.mn-wb-message').length,24);view.close();
});
