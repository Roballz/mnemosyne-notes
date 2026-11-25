import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, settingsWithDefaults, validateSettings, rangeFor, nextReminder, selectedIds, materialSelection, archivePhase, jobWorldNames, reconcileReport, aggregateReport, reportMarkdown, validatePlan, taskInstructions, formalSections, validateArchiveEdits } from '../lib/workbench/model.js';
import { diffText } from '../lib/workbench/diff-worker.js';

test('independent API settings do not inherit memory or story generation settings',()=>{
    const settings=settingsWithDefaults();
    assert.equal(settings.sourceId,'main');assert.deepEqual(settings.channels,[]);
    settings.generation.temperature=.4;assert.equal(DEFAULT_SETTINGS.generation.temperature,1);
    assert.throws(()=>validateSettings({...settings,generation:{...settings.generation,maxTokens:2000,contextSize:1000}}));
    assert.throws(()=>validateSettings({...settings,channels:[{id:'x',name:'x',url:'javascript:alert(1)',model:'x'}]}));
});
test('workbench timeout defaults and legacy 180 seconds upgrade once, retaining custom settings',()=>{
    assert.equal(settingsWithDefaults().generation.timeoutSec,600);
    const legacy={schemaVersion:1,generation:{timeoutSec:180}};
    const upgraded=settingsWithDefaults(legacy);
    assert.equal(upgraded.generation.timeoutSec,600);assert.equal(legacy.generation.timeoutSec,180);
    assert.equal(settingsWithDefaults({generation:{timeoutSec:900}}).generation.timeoutSec,900);
    upgraded.generation.timeoutSec=180;
    assert.equal(settingsWithDefaults(validateSettings(upgraded)).generation.timeoutSec,180);
});
test('blue/User/Char default selection is explicit and preserves manual exclusions',()=>{
    const targets=[{id:'u',kind:'user',selected:true},{id:'c',kind:'char',selected:true},{id:'b',kind:'world',selected:true},{id:'g',kind:'world',selected:false}];
    assert.deepEqual([...selectedIds(targets)],['u','c','b']);
    assert.deepEqual([...selectedIds(targets,['g','missing'])],['g']);
});
test('archive cutoff is inclusive and separate from chat hiding',()=>{
    assert.deepEqual(rangeFor('archive',{archivedFloor:100},250),{firstFloor:100,lastFloor:250});
    assert.deepEqual(rangeFor('free',{firstFloor:80,throughFloor:120},250),{firstFloor:80,lastFloor:120});
    assert.throws(()=>rangeFor('free',{firstFloor:300},250));
});
test('reminders fire once per 50-floor threshold, with one catchup',()=>{
    assert.equal(nextReminder(100,149,100),null);assert.equal(nextReminder(100,150,100),150);
    assert.equal(nextReminder(100,151,150),null);assert.equal(nextReminder(100,249,200),null);
    assert.equal(nextReminder(100,250,200),250);assert.equal(nextReminder(100,799,100),750);
});
test('a skipped destination retains the key instead of claiming archival',()=>{
    const items=[{id:'a',target:{id:'world:w:1'},action:'replace'},{id:'b',target:{id:'world:w:2'},action:'delete'}];
    const report=reconcileReport({cleared:[{key:'demo-a',into:['world:w:1']},{key:'demo-b',into:['world:w:2']}],closed:[{id:'world:w:2',title:'closed'}]},items,[{itemId:'a',status:'applied'},{itemId:'b',status:'skipped'}]);
    assert.deepEqual(report.cleared.map(r=>r.key),['demo-a']);assert.deepEqual(report.retained.map(r=>r.key),['demo-b']);assert.deepEqual(report.closed,[]);
});
test('closing sections in a shared world entry records only removed formal sections and preserves each closed id',()=>{
    const item={id:'a',target:{id:'world:w:1'},action:'replace',before:{content:'## S-001 合成甲\n旧甲\n## S-002 合成乙\n旧乙\n## P-001 合成人物\n保留'},after:{content:'## P-001 合成人物\n保留'}};
    const closed=[{id:'world:w:1',entryId:'S-001',title:'S-001 合成甲'},{id:'world:w:1',entryId:'S-002',title:'S-002 合成乙'},{id:'world:w:1',entryId:'P-001',title:'P-001 合成人物'}];
    const savedReport=reconcileReport({closed},[item],[{itemId:'a',status:'applied'}]);
    assert.deepEqual(savedReport.closed,closed.slice(0,2));
    assert.deepEqual(aggregateReport([{status:'saved',savedReport}]).closed,closed.slice(0,2));
    assert.deepEqual(reconcileReport({closed},[item],[{itemId:'a',status:'skipped'}]).closed,[]);
});
test('new formal ids resolve to unique created world targets',()=>{
    const items=[{id:'a',target:{id:'world:w:3'},action:'create',after:{content:'S-003 合成记录',metadata:{comment:'S-003 合成记录'}}}];
    const report=reconcileReport({cleared:[{key:'demo',into:['S-003']}]},items,[{itemId:'a',status:'applied'}]);
    assert.deepEqual(report.cleared[0].into,['world:w:3']);
});
test('retained rolling keys survive across tasks and no raw rolling deletion is generated',()=>{
    const report=aggregateReport([{status:'saved',savedReport:{cleared:[{key:'a',into:['world:w:1']}],retained:[{key:'b',reason:'进行中',into:['world:w:2']}],closed:[]}}],[{key:'a',into:[]},{key:'carried',reason:'待处理',into:[]}]);
    assert.deepEqual(report.retained.map(r=>r.key),['carried','b']);
    assert.match(reportMarkdown(report),/本次清除/);assert.match(reportMarkdown(report),/已整理部分/);
});
test('planning requires bounded, meaningful batches and exposes allowed books',()=>{
    assert.throws(()=>validatePlan({batches:[]}));assert.throws(()=>validatePlan({batches:[{title:'empty'}]}));
    const plan=validatePlan({batches:[{title:'合成批次',instructions:'整理一项'}]});assert.equal(plan[0].id,'batch-1');
    assert.match(taskInstructions({scope:{worldNames:['合成世界']},enabledWorlds:['合成世界'],batches:[],firstFloor:0,lastFloor:9},settingsWithDefaults(),'plan'),/合成世界/);
});
test('book permissions begin with User/Char and migrate explicit entry choices without enabling other books',()=>{
    const targets=[{id:'user:u:description',kind:'user',selected:true},{id:'world:synthetic:1',kind:'world',world:'甲书',selected:true},{id:'world:global:2',kind:'world',world:'全局书',selected:true}];
    const fresh=materialSelection(targets,{},['甲书','全局书']);
    assert.deepEqual([...fresh.selected],['user:u:description']);assert.deepEqual([...fresh.enabledWorlds],[]);
    const old=materialSelection(targets,{selectedTargetIds:['world:synthetic:1']},['甲书','全局书']);
    assert.deepEqual([...old.enabledWorlds],['甲书'],'actual target identity takes precedence over an encoded fixture ID');
    const disabled=materialSelection(targets,{selectedTargetIds:['world:synthetic:1'],enabledWorlds:[]},['甲书','全局书']);
    assert.deepEqual([...disabled.selected],[]);assert.deepEqual([...disabled.enabledWorlds],[]);
    const blank=materialSelection(targets,{selectedTargetIds:[],enabledWorlds:['甲书']},['甲书','全局书']);
    assert.deepEqual([...blank.selected],[]);assert.deepEqual([...blank.enabledWorlds],['甲书']);
});
test('legacy tasks expose only books inferred from explicit world entry IDs',()=>{
    const job={scope:{worldNames:['甲:书','未选全局']},selectedTargetIds:['world:'+encodeURIComponent('甲:书')+':3'],batches:[],firstFloor:0,lastFloor:9};
    assert.deepEqual(jobWorldNames(job),['甲:书']);
    const prompt=taskInstructions(job,settingsWithDefaults(),'plan');
    assert.match(prompt,/甲:书/);assert.doesNotMatch(prompt,/未选全局/);
    assert.deepEqual(jobWorldNames({...job,enabledWorlds:[]}),[]);
});
test('diff reconstructs both versions for disjoint edits, emoji and repeated lines',()=>{
    for(const [before,after] of [['甲\n乙\n丙\n','甲\n丁\n丙\n'],['🙂旧段\n相同\n尾旧','🙃新段\n相同\n尾新'],['','新增'],['旧',''],['重复\n'.repeat(5000)+'旧','重复\n'.repeat(5000)+'新']]){
        const parts=diffText(before,after);
        assert.equal(parts.filter(p=>p.type!=='add').map(p=>p.text).join(''),before);
        assert.equal(parts.filter(p=>p.type!=='remove').map(p=>p.text).join(''),after);
        for(const p of parts)assert.equal(p.text.isWellFormed(),true);
    }
});

test('one rolling key accumulates saved destinations across carry, batches and status changes',()=>{
    const carry=[{key:'ongoing',reason:'上次保留',into:['world:w:0']},{key:'untouched',reason:'另一线',into:['world:w:9']}];
    const batches=[
        {status:'saved',savedReport:{retained:[{key:'ongoing',reason:'第一批完成',into:['world:w:1','world:w:0']}]}},
        {status:'saved',savedReport:{cleared:[{key:'ongoing',into:['world:w:2','world:w:1']}]}},
        {status:'review',savedReport:{retained:[{key:'ongoing',reason:'未确认',into:['world:w:unsaved']}]}},
    ];
    const original=structuredClone({carry,batches}),cleared=aggregateReport(batches,carry);
    assert.deepEqual(cleared.cleared,[{key:'ongoing',into:['world:w:0','world:w:1','world:w:2']}]);
    assert.deepEqual(cleared.retained,[carry[1]]);
    const retained=aggregateReport([...batches,{status:'saved',savedReport:{retained:[{key:'ongoing',reason:'后续部分跳过',into:[]}]}}],carry);
    assert.deepEqual(retained.cleared,[]);
    assert.deepEqual(retained.retained.find(r=>r.key==='ongoing'),{key:'ongoing',reason:'后续部分跳过',into:['world:w:0','world:w:1','world:w:2']});
    assert.deepEqual({carry,batches},original,'report aggregation must not rewrite stored carry or batch reports');
});

test('formal archive containers enforce per-entry limits and count definitions rather than references',()=>{
    const content='## P-101 合成人物甲\n'+('甲'.repeat(450))+'\n关联 R-202，仅作引用。\n\n## P-102 合成人物乙\n'+('乙'.repeat(450));
    const item={id:'container',target:{id:'world:w:container',kind:'world'},action:'create',before:null,after:{content,metadata:{comment:'人物档案合集'}}};
    const catalog=[{id:'world:w:relation',kind:'world',content:'## R-202 合成关系\n关系记录',metadata:{comment:'关系档案'}}];
    assert.ok(content.length>800);
    assert.deepEqual(formalSections(item.after).map(s=>s.id),['P-101','P-102']);
    assert.doesNotThrow(()=>validateArchiveEdits([item],catalog));
    const duplicate=structuredClone(item);duplicate.after.content+='\n\n## P-101 重复人物\n另一条记录';
    assert.throws(()=>validateArchiveEdits([duplicate],catalog),/P-101.*重复/);
    const tooLong=structuredClone(item);tooLong.after.content='## P-101 合成人物\n'+'甲'.repeat(801);
    assert.throws(()=>validateArchiveEdits([tooLong],catalog),/P-101.*800/);
});

test('editing one formal section does not reject unchanged legacy sections or ignore ordinary container titles',()=>{
    const oldSection='## S-111 合成旧记录\n旧稿已经了结。';
    const before={content:oldSection+'\n\n## S-112 合成新记录\n旧事实',metadata:{comment:'隐藏事实合集'}};
    const after={content:oldSection+'\n\n## S-112 合成新记录\n新增事实',metadata:{comment:'隐藏事实合集'}};
    const item={id:'container',target:{id:'world:w:container',kind:'world'},action:'replace',before,after};
    assert.doesNotThrow(()=>validateArchiveEdits([item],[{...item.target,...before}]));
    const conflict={id:'other',target:{id:'world:w:new',kind:'world'},action:'create',before:null,after:{content:'## S-112 另一项\n合成事实',metadata:{comment:'普通标题'}}};
    assert.throws(()=>validateArchiveEdits([conflict],[{...item.target,...before}]),/S-112.*重复/);
});

test('adoption phrases require preceding discussion and preserve edited prompts across upgrades',()=>{
    const job={mode:'archive',messages:[],plan:[]};
    assert.equal(archivePhase(job,'好'),'discuss');
    job.messages.push({role:'assistant',content:'两批方案'});
    for(const input of ['好','可以，开始吧','就这样，开始更新','开始整理','开始归档'])assert.equal(archivePhase(job,input),'plan');
    assert.equal(archivePhase(job,'好，但重分第二批'),'discuss');
    assert.equal(archivePhase(job,'沿用我们刚商量的顺序，着手处理即可'),'negotiate');
    job.plan=[{title:'本批'}];assert.equal(archivePhase(job,'下一批少写背景'),'batchChat');
    const edited={duties:{archive:'我的归档职责'},tasks:{plan:'我的规划提示'}};
    const migrated=settingsWithDefaults({schemaVersion:2,...edited});
    assert.equal(migrated.duties.archive,edited.duties.archive);assert.equal(migrated.tasks.plan,edited.tasks.plan);
    const plain=validatePlan({batches:[{title:'合成',targets:['P-001']}]});
    assert.equal(plain[0].instructions,'');assert.deepEqual(plain[0].targets,['P-001']);
});
