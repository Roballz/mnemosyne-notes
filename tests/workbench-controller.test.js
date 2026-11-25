import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchController } from '../lib/workbench/controller.js';
import { settingsWithDefaults } from '../lib/workbench/model.js';
import { prepareOperations } from '../lib/workbench/targets.js';

const scope={chatKey:'synthetic-chat',worldNames:['合成世界']};
const state=(content)=>({content,metadata:{}});
function setup(){
    const settings=new Map([['synthetic-chat',{archivedFloor:100}]]),jobs=new Map(),saved=[];
    const targets=[{id:'world:w:1',kind:'world',world:'合成世界',uid:1,title:'合成条目',content:'旧内容',metadata:{},selected:true}];
    const api={
        storage:{
            getSettings:async key=>structuredClone(settings.get(typeof key==='string'?key:key.chatKey)||{}),
            saveSettings:async(key,patch)=>{key=typeof key==='string'?key:key.chatKey;settings.set(key,{...settings.get(key),...patch});},
            putJob:async job=>{jobs.set(job.id,structuredClone(job));},getJob:async id=>structuredClone(jobs.get(id)),
            listJobs:async()=>[],pruneSnapshots:async()=>({deleted:0,hasMore:false}),
            saveBatch:async options=>{saved.push(structuredClone(options));return {complete:true,outcomes:options.items.map(i=>({itemId:i.id,status:i.accepted===false?'skipped':'applied'}))};},
        },
        targets:{captureScope:async()=>scope,listTargets:async()=>({targets,worlds:[{name:'合成世界'}]}),readTarget:async()=>state('当前新版本'),
            prepareOperations:async ops=>ops.map((op,i)=>({id:'item-'+i,target:typeof op.target==='string'?targets.find(t=>t.id===op.target)||{id:op.target}:op.target,title:'合成条目',action:op.action,before:state('旧内容'),after:op.action==='delete'?null:state(op.content||'新内容')}))},
        latestFloor:async()=>250,listPresets:async()=>[],
    };
    const c=new WorkbenchController(api);Object.assign(c,{scope,settings:settingsWithDefaults(),state:{mode:'archive',archivedFloor:100},targets,worlds:[],selected:new Set(targets.map(t=>t.id)),lastFloor:250});
    c.captureTargets=targets;c.captureAllowed=new Set(targets.map(t=>t.id));
    c.verifySource=async job=>{if(job.sourceDirty)throw Error('source changed');};
    return {c,api,settings,jobs,saved};
}
const plan={batches:[{title:'第一批',instructions:'整理第一项'},{title:'第二批',instructions:'整理第二项'}]};
test('switching mode retains the unfinished archive task and starts free mode without discarding its drafts',async()=>{
    const {c,jobs,settings}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',plan);job.status='planned';
    await c.switchMode('free');
    assert.equal(c.state.mode,'free');assert.equal(settings.get(scope.chatKey).mode,'free');assert.equal(c.job,null);
    assert.equal(jobs.get(job.id).status,'planned');assert.equal(jobs.get(job.id).plan.length,2);
    const free=await c.newJob();assert.equal(free.mode,'free');assert.notEqual(free.id,job.id);
    c.running=true;await assert.rejects(()=>c.switchMode('archive'),/停止|等待/);assert.equal(c.job,free);
});
test('manual archive onboarding retries an existing gap in place and never requests the old history',async()=>{
    const {c,jobs,settings,saved}=setup();
    let historyCalls=0;
    const captures=[],requests=[];
    c.api.captureHistory=async()=>{
        historyCalls++;
        return {available:true,coverage:{complete:false},warnings:['1034 个正文楼层未覆盖']};
    };
    c.api.captureWorkbenchContext=async options=>{
        captures.push(options);
        return {rawMessages:[{floor:options.firstFloor,role:'assistant',content:'衔接楼'}]};
    };
    c.api.runWorkbench=async(_,options)=>{
        requests.push(options.messages);
        if(options.tools.some(t=>t.name==='plan_archive'))await options.onTool('plan_archive',{batches:[plan.batches[0]]});
        return {text:'第一批计划'};
    };
    await c.send('整理新的 rolling');
    const failed=c.job;
    assert.equal(failed.status,'interrupted');assert.match(failed.error,/1034/);
    assert.equal(requests.length,0);
    // A job stored by the previous release has no manualArchive field.
    delete jobs.get(failed.id).manualArchive;
    await c.resume(failed.id);
    c.lastFloor=270;
    await c.setArchivedFloor(105,true);
    assert.equal(c.job.lastFloor,250);
    c.targets.push({id:'world:w:2',kind:'world',world:'合成世界',uid:2,title:'手动归档',content:'已有前情',metadata:{}});
    await c.select(['world:w:1','world:w:2']);
    await c.resume(failed.id);
    await c.send('',{retry:true});
    assert.equal(c.job.id,failed.id);assert.equal(c.job.status,'discussion');
    assert.deepEqual(captures.map(x=>[x.firstFloor,x.lastFloor,x.historyBlock]),[[105,250,'']]);
    assert.deepEqual(captures[0].selectedTargets.map(t=>t.id),['world:w:1','world:w:2']);
    assert.deepEqual(requests[0][0],{role:'user',content:'整理新的 rolling'});
    assert.match(requests[0].at(-1).content,/以所选设定衔接前情/);
    assert.equal(historyCalls,1);assert.equal(saved.length,0);
    await c.send('可以，开始吧');
    assert.equal(c.job.status,'planned');assert.equal(captures.at(-1).discussionOnly,true);
    assert.equal(historyCalls,1);
    c.api.runWorkbench=async(_,options)=>{
        await options.onTool('propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新归档'}]});
        return {text:'请审核本批'};
    };
    await c.send('',{execute:true});
    assert.equal(c.job.status,'review');
    assert.equal(saved.length,0);
    await c.saveReviewed(c.currentBatch().items);
    assert.equal(settings.get(scope.chatKey).archivedFloor,250);
    c.api.latestFloor=async()=>270;
    await c.newJob();await c.preview();
    assert.deepEqual(captures.filter(x=>!x.discussionOnly).map(x=>[x.firstFloor,x.lastFloor]),[[105,250],[105,250],[250,270]]);
    assert.equal(historyCalls,1);
    await c.setArchivedFloor(250,false);
    await assert.rejects(()=>c.preview(),/缺口/);
    assert.equal(historyCalls,2);
});

test('manual archive source stays scoped to one chat and to archive mode',async()=>{
    const {c,settings}=setup();let historyCalls=0;
    c.api.captureHistory=async()=>{historyCalls++;return {available:true,text:'之前的历史总结',coverage:{complete:false}};};
    c.api.captureWorkbenchContext=async options=>({...options,rawMessages:[]});
    await c.setArchivedFloor(100,true);
    assert.deepEqual([...settings.keys()],[scope.chatKey]);
    assert.deepEqual(await c.api.storage.getSettings({chatKey:'another-chat'}),{});
    await c.saveState({mode:'free'});
    const free=await c.preview();assert.equal(free.historyBlock,'之前的历史总结');assert.equal(historyCalls,1);
    await c.saveState({mode:'archive'});
    const manual=await c.preview();assert.equal(manual.historyBlock,'');assert.equal(historyCalls,1);
    c.api.captureWorkbenchContext=async()=>{throw Error('正文楼层未完整返回');};
    await assert.rejects(()=>c.preview(),/正文楼层未完整返回/);
});

test('plan and tool proposals only stage durable drafts, not writes',async()=>{
    const {c,saved,jobs}=setup();const job=await c.newJob();
    await assert.rejects(()=>c.onTool(job,'plan','propose_changes',{operations:[]}));
    await c.onTool(job,'plan','plan_archive',plan);
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}],report:{cleared:[{key:'demo',into:['world:w:1']}]}});
    assert.equal(saved.length,0);assert.equal(jobs.get(job.id).batches[0].items.length,1);
    await assert.rejects(()=>c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'outside',content:'无权'}]}),/未选中/);
});
test('each batch saves independently, final cutoff stays fixed while story continues',async()=>{
    const {c,settings,saved}=setup();c.state.throughFloor=250;const job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',plan);
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'第一批'}],report:{cleared:[{key:'demo-a',into:['world:w:1']}]}});
    await c.saveReviewed(c.currentBatch().items);assert.equal(settings.get(scope.chatKey).archivedFloor,100);
    assert.equal(job.status,'ready');assert.equal(saved.length,1);
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'第二批'}],report:{retained:[{key:'demo-b',reason:'进行中',into:['world:w:1']}]}});
    c.lastFloor=280;await c.saveReviewed(c.currentBatch().items);
    assert.equal(job.status,'done');assert.equal(settings.get(scope.chatKey).archivedFloor,250);
    assert.match(job.finalReport,/demo-b/);assert.equal(saved.length,2);
    c.api.latestFloor=async()=>280;
    const next=await c.newJob();assert.equal(next.firstFloor,250);assert.equal(next.lastFloor,280);
});
test('skipped items remain retained and do not block other reviewed writes',async()=>{
    const {c}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}],report:{cleared:[{key:'demo',into:['world:w:1']}]}});
    c.currentBatch().items[0].accepted=false;await c.saveReviewed(c.currentBatch().items);
    assert.equal(job.report.cleared.length,0);assert.equal(job.report.retained[0].key,'demo');
});
test('partial or unknown host writes never advance the archive cursor',async()=>{
    const {c,api,settings}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}]});
    api.storage.saveBatch=async options=>({complete:false,outcomes:options.items.map(item=>({itemId:item.id,status:'unknown'}))});
    await c.saveReviewed(c.currentBatch().items);
    assert.equal(settings.get(scope.chatKey).archivedFloor,100);assert.equal(c.currentBatch().status,'partial');
});
test('changing a captured floor blocks writes; newer story floors do not invalidate',async()=>{
    const {c,saved}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}]});
    c.invalidateSource(251,'MESSAGE_EDITED');assert.equal(job.sourceDirty,undefined);
    c.invalidateSource(220,'MESSAGE_SWIPED');assert.equal(job.sourceDirty,true);
    await assert.rejects(()=>c.saveReviewed(c.currentBatch().items),/source changed/);assert.equal(saved.length,0);
});
test('manual cursor changes are not overwritten by a late task',async()=>{
    const {c,settings}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}]});
    settings.set(scope.chatKey,{archivedFloor:230});
    await c.saveReviewed(c.currentBatch().items);assert.equal(settings.get(scope.chatKey).archivedFloor,230);assert.equal(job.cursorConflict,true);
});
test('rollback stages old content against current text, with no direct mutation',async()=>{
    const {c,saved}=setup();
    await c.stageRestore({id:'snap-old',scopeKey:scope.chatKey,title:'合成旧版本',target:{id:'world:w:1',kind:'world',world:'合成世界',uid:1},before:state('更早内容'),after:state('中间版本')});
    assert.equal(c.currentBatch().items[0].before.content,'当前新版本');
    assert.equal(c.currentBatch().items[0].after.content,'更早内容');assert.equal(saved.length,0);
    assert.equal(c.job.mode,'free');
});
test('draft persistence failure prevents any host write',async()=>{
    const {c,api,saved}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}]});
    api.storage.putJob=async()=>{throw Error('storage unavailable');};
    await assert.rejects(()=>c.saveReviewed(c.currentBatch().items),/storage unavailable/);assert.equal(saved.length,0);
});

test('duplicate send gestures cannot start concurrent workbench requests',async()=>{
    const {c,api}=setup();let release,calls=0;
    c.captureFor=()=>new Promise(resolve=>{release=resolve;});
    api.runWorkbench=async()=>{calls++;return {text:'规划讨论',finishReason:'stop'};};
    c.api.runWorkbench=api.runWorkbench;
    const first=c.send('合成请求');
    await assert.rejects(()=>c.send('重复请求'),/正在处理/);
    for(let i=0;i<20&&!release;i++)await Promise.resolve();
    assert.ok(release);release({});
    await first;assert.equal(calls,1);assert.equal(c.starting,false);
});
test('concurrent save clicks cannot duplicate writes while validating source',async()=>{
    const {c,saved}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'新内容'}]});
    let release;c.verifySource=()=>new Promise(resolve=>{release=resolve;});
    const first=c.saveReviewed(c.currentBatch().items);
    await assert.rejects(()=>c.saveReviewed(c.currentBatch().items),/等待/);
    release();await first;assert.equal(saved.length,1);
});

test('multiple proposal calls get unique item ids; created refs use journal UIDs in later batches',async()=>{
    const {c,api,settings}=setup(),job=await c.newJob();
    await c.onTool(job,'plan','plan_archive',plan);
    api.targets.prepareOperations=async ops=>ops.map(op=>({id:'item-0',target:{id:'world:w:new:0',kind:'world',world:'合成世界'},title:op.content,action:'create',before:null,after:state(op.content)}));
    const a=await c.onTool(job,'edit','propose_changes',{operations:[{action:'create',target:{kind:'world',world:'合成世界'},content:'S-010 合成甲'}],report:{cleared:[{key:'demo-a',into:['S-010']}]}});
    const b=await c.onTool(job,'edit','propose_changes',{operations:[{action:'create',target:{kind:'world',world:'合成世界'},content:'S-011 合成乙'}],report:{cleared:[{key:'demo-b',into:['S-011']}]}});
    assert.notEqual(a.items[0].id,b.items[0].id);assert.notEqual(a.items[0].target,b.items[0].target);
    api.storage.saveBatch=async options=>({complete:true,outcomes:options.items.map((item,i)=>({itemId:item.id,status:'applied',target:{...item.target,uid:i+10,id:'world:w:'+(i+10)}}))});
    await c.saveReviewed(c.currentBatch().items);
    assert.deepEqual(job.batches[0].items.map(i=>i.target.id),['world:w:10','world:w:11']);
    assert.deepEqual(job.report.cleared.map(r=>r.into[0]),['world:w:10','world:w:11']);
    assert.ok(c.selected.has('world:w:10'));assert.ok(settings.get(scope.chatKey).selectedTargetIds.includes('world:w:11'));
});

test('previewed archive drafts follow range and cursor changes while invalidating the old capture',async()=>{
    const {c,settings,jobs}=setup();
    c.captureFor=async job=>{
        job.sourceSignature='synthetic-preview-signature';job.history={revision:1};
        c.capture={firstFloor:job.firstFloor,lastFloor:job.lastFloor};return c.capture;
    };
    assert.deepEqual(await c.preview(),{firstFloor:100,lastFloor:250});
    await c.saveState({throughFloor:180});
    assert.equal(c.state.throughFloor,180);assert.equal(c.job.lastFloor,180);
    assert.equal(c.capture,null);assert.equal(c.job.sourceSignature,undefined);assert.equal(c.job.history,undefined);
    assert.equal(jobs.get(c.job.id).lastFloor,180);
    await c.preview();await c.setArchivedFloor(120);
    assert.equal(c.job.firstFloor,120);assert.equal(c.job.lastFloor,180);assert.equal(c.job.cursorBase,120);
    assert.equal(c.capture,null);assert.equal(settings.get(scope.chatKey).archivedFloor,120);
    assert.equal(jobs.get(c.job.id).firstFloor,120);
    await c.onTool(c.job,'plan','plan_archive',{batches:[plan.batches[0]]});
    c.job.status='planned'; // send() publishes this status after the complete planning turn.
    await c.setArchivedFloor(150);
    assert.equal(c.job.firstFloor,120,'planned jobs keep their captured range');
    assert.equal(c.job.cursorBase,120,'a manual cursor change must still be detectable at finalization');
});

test('previewed free drafts follow both range boundaries',async()=>{
    const {c,jobs}=setup();Object.assign(c.state,{mode:'free',firstFloor:20,throughFloor:120});
    c.captureFor=async job=>({firstFloor:job.firstFloor,lastFloor:job.lastFloor});
    assert.deepEqual(await c.preview(),{firstFloor:20,lastFloor:120});
    await c.saveState({firstFloor:40,throughFloor:100});
    assert.deepEqual({first:c.job.firstFloor,last:c.job.lastFloor},{first:40,last:100});
    assert.equal(jobs.get(c.job.id).firstFloor,40);assert.equal(c.job.batches.length,1);
});

test('invalid draft ranges are rejected before changing persisted settings or task state',async()=>{
    const {c,settings,jobs}=setup();await c.newJob();
    const beforeState=structuredClone(c.state),beforeSettings=structuredClone(settings.get(scope.chatKey)),beforeJob=structuredClone(c.job);
    await assert.rejects(()=>c.saveState({throughFloor:99}),/范围|楼层/);
    assert.deepEqual(c.state,beforeState);assert.deepEqual(settings.get(scope.chatKey),beforeSettings);
    assert.deepEqual(c.job,beforeJob);assert.deepEqual(jobs.get(c.job.id),beforeJob);
});

async function preparedArchive(){
    const env=setup();env.api.targets.prepareOperations=prepareOperations;env.c.captureCatalogTargets=env.c.targets;
    const job=await env.c.newJob();await env.c.onTool(job,'plan','plan_archive',{batches:[plan.batches[0]]});
    return {...env,job};
}
const createFormal=content=>({action:'create',target:{kind:'world',world:'合成世界'},content,metadata:{comment:'合成归档容器'}});

test('running, stale-list and stale-task review drafts cannot overwrite complete proposals',async()=>{
    const {c,job}=await preparedArchive();
    await c.onTool(job,'edit','propose_changes',{operations:[createFormal('## S-121 合成甲\n事实甲')]});
    const expected={jobId:job.id,batchId:c.currentBatch().id},old=structuredClone(c.currentBatch().items);
    c.running=true;
    await assert.rejects(()=>c.saveDraft(old,0,expected),/等待|生成/);
    c.running=false;
    await c.onTool(job,'edit','propose_changes',{operations:[createFormal('## S-122 合成乙\n事实乙')]});
    const complete=structuredClone(c.currentBatch().items);
    await assert.rejects(()=>c.saveDraft(old,0,expected),/新版本|过期/);
    await assert.rejects(()=>c.saveDraft(complete,0,{...expected,jobId:'stale-job'}),/过期/);
    await assert.rejects(()=>c.saveDraft(complete,0,{...expected,batchId:'stale-batch'}),/过期/);
    assert.deepEqual(c.currentBatch().items,complete);
    const edit=structuredClone(complete);edit[0].after.content='## S-121 合成甲\n人工确认事实';
    await c.saveDraft(edit,0,expected);assert.equal(c.currentBatch().items.length,2);
    assert.equal(c.currentBatch().items[0].after.content,edit[0].after.content);
});

test('formal number conflicts reject the whole same-call or later-call proposal without dropping earlier work',async()=>{
    const {c,job,jobs}=await preparedArchive();
    await assert.rejects(()=>c.onTool(job,'edit','propose_changes',{operations:[
        createFormal('## P-131 合成甲\n事实甲'),createFormal('## P-131 合成乙\n事实乙'),
    ]}),/P-131.*重复/);
    assert.equal(c.currentBatch().items.length,0);assert.equal(jobs.get(job.id).batches[0].items.length,0);
    await c.onTool(job,'edit','propose_changes',{operations:[createFormal('## P-131 合成甲\n事实甲')]});
    const accepted=structuredClone(c.currentBatch().items);
    await assert.rejects(()=>c.onTool(job,'edit','propose_changes',{operations:[createFormal('## P-131 合成乙\n事实乙')]}),/P-131.*重复/);
    assert.deepEqual(c.currentBatch().items,accepted);assert.deepEqual(jobs.get(job.id).batches[0].items,accepted);
    const container='## P-132 合成乙\n'+'乙'.repeat(440)+'\n\n## P-133 合成丙\n'+'丙'.repeat(440);
    assert.ok(container.length>800);
    await c.onTool(job,'edit','propose_changes',{operations:[createFormal(container)]});
    assert.equal(c.currentBatch().items.length,2);
});

test('manual review cannot introduce a duplicate formal number before any host write',async()=>{
    const {c,job,saved}=await preparedArchive();
    await c.onTool(job,'edit','propose_changes',{operations:[
        createFormal('## R-141 合成关系甲\n事实甲'),createFormal('## R-142 合成关系乙\n事实乙'),
    ]});
    const edits=structuredClone(c.currentBatch().items);
    edits[1].after.content='## R-141 人工误改的重复关系\n事实乙';
    await assert.rejects(()=>c.saveReviewed(edits),/R-141.*重复/);
    assert.equal(saved.length,0);assert.equal(c.saving,false);
    assert.match(c.currentBatch().items[1].after.content,/R-142/);
});

test('review preparation recovers journal locks and applied creations despite an older skipped draft',async()=>{
    const {c,api,settings,jobs,saved}=setup(),journalReads=[];
    api.targets.prepareOperations=prepareOperations;c.captureCatalogTargets=c.targets;
    const job=await c.newJob();await c.onTool(job,'plan','plan_archive',plan);
    await c.onTool(job,'edit','propose_changes',{operations:[
        createFormal('## S-151 合成已写入条目\n事实甲'),createFormal('## S-152 合成待确认条目\n事实乙'),
    ],report:{cleared:[{key:'recovered-key',into:['S-151']}],retained:[{key:'ongoing-key',reason:'继续使用',into:['S-152']}]}});
    const batch=c.currentBatch(),[created,pending]=batch.items;
    created.accepted=false;await c.persist();
    const actualCreated={...created.target,id:'world:w:151',uid:151},actualPending={...pending.target,id:'world:w:152',uid:152};
    api.storage.getBatchOutcomes=async options=>{
        journalReads.push(structuredClone(options));
        return [
            {itemId:created.id,status:'applied',target:actualCreated,snapshotId:'synthetic-applied-journal'},
            {itemId:pending.id,status:'prepared',target:actualPending,snapshotId:'synthetic-prepared-journal'},
        ];
    };
    await c.prepareReview();
    assert.equal(journalReads.length,1);assert.equal(journalReads[0].jobId,job.id);
    assert.equal(journalReads[0].batchId,job.id+':'+batch.id);assert.equal(journalReads[0].items[0].accepted,false);
    assert.equal(batch.items[0].accepted,true);assert.deepEqual(batch.items[0].target,actualCreated);
    assert.equal(batch.outcomes.find(o=>o.itemId===pending.id).status,'prepared');
    assert.equal(batch.outcomes.find(o=>o.itemId===pending.id).snapshotId,'synthetic-prepared-journal');
    assert.equal(jobs.get(job.id).batches[0].outcomes[1].snapshotId,'synthetic-prepared-journal');
    api.storage.saveBatch=async options=>{
        saved.push(structuredClone(options));
        return {complete:true,outcomes:options.items.map(item=>({itemId:item.id,status:'applied',target:item.target,snapshotId:'synthetic-'+item.target.uid}))};
    };
    await c.saveReviewed(structuredClone(batch.items),{jobId:job.id,batchId:batch.id});
    assert.equal(saved[0].items[0].accepted,true);assert.equal(job.status,'ready');assert.equal(c.currentBatch().id,'batch-2');
    assert.ok(c.selected.has(actualCreated.id));assert.ok(settings.get(scope.chatKey).selectedTargetIds.includes(actualCreated.id));
    assert.deepEqual(job.report.cleared,[{key:'recovered-key',into:[actualCreated.id]}]);
    assert.deepEqual(job.report.retained,[{key:'ongoing-key',reason:'继续使用',into:[actualPending.id]}]);
    c.targets.push(...batch.items.map(item=>({...item.target,...item.after,title:item.title})));
    let nextCapture;
    c.api.captureHistory=async()=>({available:false,text:'',warnings:[]});c.api.getDefaultPreset=()=>'';
    c.api.captureWorkbenchContext=async options=>{nextCapture=options;return {rawMessages:[]};};
    await c.captureFor(job);
    assert.ok(nextCapture.selectedTargets.some(target=>target.id===actualCreated.id),'the next batch must receive the journal-confirmed creation');
});

test('stale review saves cannot write another batch even when item counts match',async()=>{
    const {c,saved}=setup(),job=await c.newJob();await c.onTool(job,'plan','plan_archive',plan);
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'第一批确认文本'}]});
    const oldItems=structuredClone(c.currentBatch().items),oldIdentity={jobId:job.id,batchId:c.currentBatch().id};
    await c.saveReviewed(oldItems,oldIdentity);assert.equal(saved.length,1);
    await c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'第二批确认文本'}]});
    const current=structuredClone(c.currentBatch().items),identity={jobId:job.id,batchId:c.currentBatch().id};
    assert.equal(current.length,oldItems.length);
    await assert.rejects(()=>c.saveReviewed(oldItems,oldIdentity),/过期|新版本/);
    await assert.rejects(()=>c.saveReviewed(current,oldIdentity),/过期|新版本/);
    await assert.rejects(()=>c.saveReviewed(current,{...identity,jobId:'other-job'}),/过期|新版本/);
    const oldIds=structuredClone(current);oldIds[0].id=oldItems[0].id;
    await assert.rejects(()=>c.saveReviewed(oldIds,identity),/过期|新版本/);
    assert.equal(saved.length,1);assert.deepEqual(c.currentBatch().items,current);assert.equal(c.saving,false);
    await c.saveReviewed(current,identity);assert.equal(saved.length,2);assert.equal(job.status,'done');
});

test('archive discusses, registers an approved revision, and takes direction between independent batches',async()=>{
    const {c,saved}=setup();
    c.captureFor=async()=>{c.captureTargets=c.targets;c.captureAllowed=new Set(c.targets.map(t=>t.id));return {};};
    const toolNames=o=>o.tools.map(t=>t.name);
    c.api.runWorkbench=async(_,o)=>{
        assert.deepEqual(toolNames(o),[]);assert.equal(o.plainReply,true);
        await assert.rejects(o.onTool('plan_archive',plan),/采用方案/);
        return {text:'合成初稿：按人物分组。'};
    };
    await c.send('整理档案');assert.equal(c.job.status,'discussion');assert.deepEqual(c.job.batches,[]);
    c.api.runWorkbench=async(_,o)=>{
        assert.deepEqual(toolNames(o),[]);assert.equal(o.plainReply,true);
        return {text:'合成修订：按时间分为早、晚两批。'};
    };
    await c.send('好，但换成按时间分批');assert.deepEqual(c.job.plan,[]);
    const batches=[{title:'早',targets:['S-001']},{title:'晚',targets:['P-002']}];
    c.api.runWorkbench=async(_,o)=>{
        assert.deepEqual(toolNames(o),['plan_archive']);
        assert.match(JSON.stringify(o.messages),/按时间分为早、晚/);
        await o.onTool('plan_archive',{batches});return {text:'已登记'};
    };
    await c.send('就这样，开始更新');assert.equal(c.job.status,'planned');
    assert.equal(c.job.plan[0].instructions,'');assert.equal(saved.length,0);
    c.api.runWorkbench=async(_,o)=>{
        assert.ok(!toolNames(o).includes('propose_changes'));
        return {text:'已记下，第二批保留原称呼。'};
    };
    await c.send('第二批保留原称呼');assert.equal(c.job.status,'planned');
    c.api.runWorkbench=async(_,o)=>{
        assert.match(o.messages.at(-1).content,/本批目标：S-001/);
        await o.onTool('propose_changes',{operations:[{action:'replace',target:'world:w:1',content:'合成新内容'}]});
        return {text:'请审核'};
    };
    await c.send('开始第一批');assert.equal(c.job.status,'review',c.job.error);
    await c.saveReviewed(c.currentBatch().items);assert.equal(c.job.status,'ready');
    const first=structuredClone(c.job.batches[0]);
    c.api.runWorkbench=async(_,o)=>{
        assert.ok(!toolNames(o).includes('propose_changes'));
        await o.onTool('plan_archive',{batches:[{title:'更新后的晚批',targets:['P-002','R-003']}]});
        return {text:'已调整余下批次'};
    };
    await c.send('确定，把剩下的关系条目移到晚批');assert.equal(c.job.status,'ready');
    assert.deepEqual(c.job.batches[0],first);
    c.api.runWorkbench=async(_,o)=>{
        assert.match(JSON.stringify(o.messages),/第二批保留原称呼/);
        assert.match(o.messages.at(-1).content,/本批目标：P-002、R-003/);return {text:'测试结束'};
    };
    await c.send('继续下一批');assert.equal(saved.length,1);
});
