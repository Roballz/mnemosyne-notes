import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { WorkbenchView } from '../lib/workbench/view.js';
import { metadataEditor,reviewBatch } from '../lib/workbench/review.js';
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
test('clean tag settings add, deduplicate and remove rules, preserve IME input, and save only on confirmation', async () => {
    const { view, c, document, click } = setup(), saved = [];
    c.saveSettings = async value => { saved.push(structuredClone(value));c.settings = settingsWithDefaults(value); };
    view.settings();let dialog = document.querySelector('dialog');
    const input = dialog.querySelector('[aria-label="清洗标签"]'), chips = () => dialog.querySelectorAll('.mn-wb-clean-tags button');
    input.value = 'sxrp';click(dialog, '添加标签');await until(() => chips().length === 1);
    input.value = '<SXRp>';input.onkeydown({ key: 'Enter', preventDefault() {} });await until(() => input.value === '');
    assert.equal(chips().length, 1);assert.deepEqual(c.settings.cleanTags, []);
    input.value = '<archive type="关系">';
    input.onkeydown({ key: 'Enter', isComposing: true, preventDefault: () => assert.fail('IME confirmation must not add a rule') });
    assert.equal(chips().length, 1);assert.equal(input.value, '<archive type="关系">');
    input.onkeydown({ key: 'Enter', isComposing: false, preventDefault() {} });await until(() => chips().length === 2);
    dialog.querySelector('[aria-label="删除清洗标签 <sxrp>"]').click();assert.equal(chips().length, 1);
    input.value = '<note>';click(dialog, '保存设置');await until(() => !document.querySelector('dialog'));
    assert.equal(saved.length, 1);assert.deepEqual(c.settings.cleanTags, ['<archive type="关系">', '<note>']);
    view.settings();dialog = document.querySelector('dialog');
    assert.equal(dialog.querySelectorAll('.mn-wb-clean-tags button').length, 2);
    dialog.querySelector('[aria-label="清洗标签"]').value = '<discarded>';click(dialog, '添加标签');
    await until(() => dialog.querySelectorAll('.mn-wb-clean-tags button').length === 3);dialog.close();
    assert.equal(saved.length, 1);assert.deepEqual(c.settings.cleanTags, ['<archive type="关系">', '<note>']);
});

test('actual request material preview displays the cleaned projection including an empty floor', async () => {
    const { view, c, document, click } = setup();
    c.preview = async () => ({ firstFloor: 0, lastFloor: 1, historyBlock: '历史总结', selectedTargets: [], cleanTags: ['<sxrp>'],
        rawMessages: [{ floor: 0, role: 'user', content: '<sxrp>隐藏原文甲</sxrp>' }, { floor: 1, role: 'assistant', content: '保留正文<sxrp>隐藏原文乙</sxrp>' }],
        promptMessages: [{ floor: 0, role: 'user', content: '' }, { floor: 1, role: 'assistant', content: '保留正文' }],
    });
    view.range();click(document.querySelector('dialog'), '查看实际请求材料');
    const preview = await until(() => document.querySelector('dialog[aria-label="本次请求材料预览"]'));
    assert.doesNotMatch(preview.textContent, /隐藏原文甲|隐藏原文乙/);
    assert.match(preview.textContent, /保留正文/);assert.match(preview.textContent, /#0 · user/);
    assert.match(preview.textContent, /已应用 1 条清洗规则/);preview.close();
});

test('clean tag imports merge valid rules in the draft and reject invalid files without losing existing rules', async () => {
    const { view, c, document, click } = setup();c.settings.cleanTags = ['<sxrp>'];
    c.saveSettings = async value => { c.settings = settingsWithDefaults(value); };
    view.settings();const dialog = document.querySelector('dialog'), file = dialog.querySelector('input[type="file"]');
    const load = async data => {
        Object.defineProperty(file, 'files', { configurable: true, value: [{ size: 100, text: async () => JSON.stringify(data) }] });
        await file.onchange();
    };
    await load({ kind: 'mnemosyne-clean-tags', version: 1, cleanTags: ['<SXRp>', '<archive type="关系">'] });
    assert.equal(dialog.querySelectorAll('.mn-wb-clean-tags button').length, 2);assert.deepEqual(c.settings.cleanTags, ['<sxrp>']);
    await load({ kind: 'unrelated-file', version: 1, cleanTags: ['<discarded>'] });
    assert.match(dialog.querySelector('.mn-error').textContent, /清洗标签文件/);
    assert.equal(dialog.querySelectorAll('.mn-wb-clean-tags button').length, 2);
    click(dialog, '保存设置');await until(() => !document.querySelector('dialog'));
    assert.deepEqual(c.settings.cleanTags, ['<sxrp>', '<archive type="关系">']);
});

test('a closed settings dialog cannot report a late tag import error into the next dialog', async () => {
    const { view, c, document } = setup();view.settings();
    const stale = document.querySelector('dialog'), file = stale.querySelector('input[type="file"]');
    let finish;
    Object.defineProperty(file, 'files', { value: [{ size: 100, text: () => new Promise(resolve => { finish = resolve; }) }] });
    const pending = file.onchange();await until(() => finish);
    stale.close();view.settings();finish('invalid JSON');await pending;
    const current = document.querySelector('dialog');
    assert.equal(current.querySelector('.mn-error'), null);assert.deepEqual(c.settings.cleanTags, []);
    assert.equal(current.querySelectorAll('.mn-wb-clean-tags button').length, 0);current.close();
});

test('saving during an invalid tag import waits and keeps the error visible instead of saving old rules', async () => {
    const { view, c, document } = setup(), saved = [];
    c.saveSettings = async value => { saved.push(value); };view.settings();
    const dialog = document.querySelector('dialog'), file = dialog.querySelector('input[type="file"]');
    let finish;
    Object.defineProperty(file, 'files', { value: [{ size: 100, text: () => new Promise(resolve => { finish = resolve; }) }] });
    const importing = file.onchange();await until(() => finish);
    const saving = [...dialog.querySelectorAll('button')].find(button => button.textContent === '保存设置').onclick();
    await Promise.resolve();finish('invalid JSON');await Promise.all([importing, saving]);
    assert.equal(saved.length, 0);assert.equal(dialog.open, true);assert.ok(dialog.querySelector('.mn-error'));
    dialog.close();
});

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
test('the review role selector follows injection position without changing the draft on open',()=>{
    const {batch,document}=setup(),item=batch.items[0],metadata=item.after.metadata;
    metadata.role=null;
    const grid=metadataEditor(item);
    const control=name=>[...grid.querySelectorAll('label')].find(label=>label.firstChild.textContent===name).querySelector('select');
    const position=control('插入位置'),role=control('注入角色');
    const choose=(select,value)=>{select.value=value;select.dispatchEvent(new document.defaultView.Event('change',{bubbles:true}));};
    assert.equal(role.disabled,true);assert.equal(role.value,'');assert.equal(metadata.role,null);
    choose(position,'4');assert.equal(role.disabled,false);assert.equal(metadata.role,0);
    choose(role,'2');assert.equal(metadata.role,2);
    choose(position,'1');assert.equal(role.disabled,true);assert.equal(role.value,'');assert.equal(metadata.role,null);
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
    c.api={readWorkbenchRunLog:async id=>{
        reads.push(id);return [{label:'#16 模型调用失败',detail:'流在 message_stop 之前中断'},{label:'#17 TT 已安排重试',detail:''}];
    }};
    await view.open();assert.deepEqual(reads,[]);
    click(view.taskbar,'查看上次 TT 运行记录');await until(()=>reads.length);
    assert.deepEqual(reads,['prior-run']);
    const failure=await until(()=>view.root.querySelector('.mn-wb-run-log details'));
    assert.equal(failure.open,true);assert.match(failure.textContent,/message_stop/);
    c.job.config.sourceId='independent';view.render();
    assert.doesNotMatch(view.taskbar.textContent,/查看上次 TT 运行记录/);view.close();
});

test('tool and model failures render distinct persistent diagnostics and retry only after a manual click',async()=>{
    const {view,c,click}=setup(),requests=[];
    const failure={version:1,kind:'tool',toolName:'propose_changes',message:'补丁原文未唯一命中',errorCode:'extension.tool_error',resultPath:'tool-results/inv_root/round-001-call_test.json'};
    Object.assign(c.job,{status:'interrupted',failure,error:'本批已停止',messages:[
        {role:'assistant',kind:'failure',failure,incomplete:true,content:''},
        {role:'assistant',kind:'failure',failure:{version:1,kind:'model',message:'HTTP 502 上游响应中断'},incomplete:true,content:''},
    ]});
    c.send=async(...args)=>{requests.push(args);};
    await view.open();
    assert.match(view.body.textContent,/工具执行失败.*补丁原文未唯一命中/s);
    assert.match(view.body.textContent,/模型请求失败.*HTTP 502/s);
    assert.ok([...view.body.querySelectorAll('details')].every(detail=>detail.open));
    assert.match(view.taskbar.textContent,/审核已保留草案/);assert.deepEqual(requests,[]);
    view.input.value='按补充要求重提';click(view.taskbar,'手动重新提交');
    await until(()=>requests.length===1);assert.deepEqual(requests,[['按补充要求重提',{retry:true}]]);
    c.job.error='';view.render();assert.match(view.body.textContent,/补丁原文未唯一命中/);view.close();
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

test('composer uses icon-only triggers and changes only the mode icon after mode selection',async()=>{
    const {view,c}=setup();c.job.status='done';
    c.switchMode=async mode=>{c.state.mode=mode;view.renderProgress();};
    await view.open();
    const triggers=[view.mode,view.apiPicker.trigger,view.presetPicker.trigger];
    const glyph=el=>el.querySelector('svg path').getAttribute('d');
    const original=triggers.map(glyph),apiIcon=triggers[1].firstElementChild,presetIcon=triggers[2].firstElementChild;
    assert.equal(new Set(original).size,3);
    for(const trigger of triggers){
        assert.equal(trigger.textContent,'');assert.ok(trigger.getAttribute('aria-label'));assert.equal(trigger.children.length,1);
        assert.equal(trigger.hasAttribute('data-short'),false);
    }
    view.mode.click();
    const options=[...view.modePicker.root.querySelectorAll('[role=option]')];
    assert.equal(options.length,2);assert.equal(glyph(options[0]),original[0]);
    assert.equal(options[0].getAttribute('aria-selected'),'true');
    const freeGlyph=glyph(options[1]);assert.notEqual(freeGlyph,original[0]);
    options[1].click();await until(()=>c.state.mode==='free');
    assert.equal(glyph(view.mode),freeGlyph);assert.match(view.mode.getAttribute('aria-label'),/自由/);
    const freeIcon=view.mode.firstElementChild;view.renderProgress();assert.equal(view.mode.firstElementChild,freeIcon);
    assert.equal(triggers[1].firstElementChild,apiIcon);assert.equal(triggers[2].firstElementChild,presetIcon);
    view.mode.click();assert.equal(view.modePicker.root.querySelector('[aria-selected=true]').textContent.startsWith('自由模式'),true);
    view.modePicker.root.querySelector('[role=option]').click();await until(()=>c.state.mode==='archive');
    assert.equal(glyph(view.mode),original[0]);assert.match(view.mode.getAttribute('aria-label'),/归档/);
    c.running=true;view.renderProgress();assert.ok(triggers.every(t=>t.disabled));
    view.close();
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

test('a queued native close after a complete or partial save cannot write an old review draft',async()=>{
    for(const complete of [true,false]){
        const {view,c,batch,document,drafts,click}=setup();
        batch.reviewIndex=batch.items.length-1;
        const dialog=reviewBatch(view);
        dialog.close=()=>{
            dialog.open=false;
            setTimeout(()=>dialog.dispatchEvent(new document.defaultView.Event('close')),0);
        };
        let submitted;
        c.saveReviewed=async items=>{
            submitted=structuredClone(items);
            if(complete)c.currentBatch=()=>({id:'batch-2'});
            else batch.status='partial';
            return {complete};
        };
        const edit=dialog.querySelector('.mn-wb-editor');
        edit.value='最后一项的手改';edit.oninput();
        click(dialog,'全部保存');await until(()=>!document.querySelector('dialog'));
        assert.equal(drafts.length,0);
        assert.equal(submitted.at(-1).after.content,'最后一项的手改');
        assert.match(view.message.textContent,complete?/本批已保存/:/部分项未保存/);
    }
});

test('manual close still saves edits after the final submit throws',async()=>{
    const {view,c,batch,drafts,click}=setup();batch.reviewIndex=batch.items.length-1;
    c.saveReviewed=async()=>{throw Error('合成写入失败');};
    const dialog=reviewBatch(view);click(dialog,'全部保存');
    await until(()=>dialog.querySelector('.mn-error')?.textContent==='合成写入失败');
    const edit=dialog.querySelector('.mn-wb-editor');edit.value='保留失败后的修订';edit.oninput();dialog.close();
    await until(()=>drafts.length===1);
    assert.equal(drafts.at(-1).value.at(-1).after.content,'保留失败后的修订');
});

test('the retained key’s circle check confirms the named correction and disappears after saving',async()=>{
    const {view,c,document,click}=setup(),calls=[];
    c.reportTitles=()=>({'world:w:1':'隐藏认知'});
    Object.assign(c.job,{status:'done',finalReport:'导出原记录',report:{
        cleared:[],retained:[{key:'旧 key',reason:'待核对',into:['world:w:1']}],closed:[],
    }});
    c.markArchivedKey=async(job,key)=>{
        calls.push([job.id,key]);
        const {into}=job.report.retained.pop();job.report.cleared.push({key,into});job.finalReport='导出已更正';
        view.update('state');
        return true;
    };
    await view.open();
    const icon=view.body.querySelector('.mn-wb-archive-check');
    assert.ok(icon.querySelector('svg'));assert.equal(icon.textContent,'');
    assert.equal(icon.title,'标记为已归档');assert.match(icon.getAttribute('aria-label'),/旧 key/);
    icon.click();let dialog=document.querySelector('dialog');
    assert.match(dialog.textContent,/旧 key/);click(dialog,'取消');assert.deepEqual(calls,[]);
    icon.click();dialog=document.querySelector('dialog');click(dialog,'确认');
    await until(()=>!view.body.querySelector('.mn-wb-archive-check'));
    assert.deepEqual(calls,[[c.job.id,'旧 key']]);
    assert.match(view.body.querySelector('.mn-wb-report').textContent,/共1个.*旧 key.*隐藏认知/);
    assert.match(view.message.textContent,/已更新本次清单和下次保留清单/);
});

test('repair details render exact text on expansion and partial review only saves a draft',async()=>{
    const {view,c,batch,writes,drafts,click}=setup();
    batch.patchRepair={version:1,groups:[]};batch.reviewIndex=batch.items.length-1;
    const failure={kind:'tool',message:'一段待修',patches:[{title:'合成目标',reason:'原文有多处匹配',oldText:'重复词',newText:'对应替换'}]};
    Object.assign(c.job,{status:'interrupted',failure,messages:[{role:'assistant',kind:'failure',failure}]});
    await view.open();
    const details=view.body.querySelector('details details');assert.ok(details);
    assert.doesNotMatch(details.textContent,/重复词/);
    details.open=true;details.ontoggle();assert.match(details.textContent,/重复词.*对应替换/);
    const dialog=reviewBatch(view);click(dialog,'暂存并返回');
    await until(()=>drafts.length===1);assert.equal(writes.length,0);assert.equal(dialog.open,false);view.close();
});
