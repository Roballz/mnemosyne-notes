import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchController } from '../lib/workbench/controller.js';
import { prepareOperations, applyReviewedItems } from '../lib/workbench/targets.js';
import { taskInstructions, interruptedArchiveSetup } from '../lib/workbench/model.js';

const copy=value=>structuredClone(value);
const ref=(world,uid)=>({kind:'world',world,uid,id:`world:${encodeURIComponent(world)}:${uid}`});
const report=()=>({cleared:[],retained:[],closed:[]});
function fixture(initial={}) {
    const scope={chatKey:'material-controller',worldNames:['甲书','全局乙'],availableWorlds:['甲书','全局乙'],personaAvatar:'u'};
    const user={id:'user:u:description',kind:'user',avatar:'u',field:'description',title:'合成用户',content:'User材料',metadata:{},selected:true};
    const a={...ref('甲书',1),title:'甲一',content:'已选材料',metadata:{constant:true},selected:true};
    const hidden={...ref('甲书',2),title:'甲二',content:'未选条目正文',metadata:{constant:true},selected:true};
    const global={...ref('全局乙',1),title:'乙一',content:'未启用全局正文',metadata:{constant:true},selected:true};
    const catalog=[user,a,hidden,global],settings=new Map([[scope.chatKey,{mode:'free',...initial}]]),jobs=new Map(),reads=[],writes=[],captures=[];
    let targetReads=0;
    const storage={
        getSettings:async key=>copy(settings.get(typeof key==='string'?key:key.chatKey)||{}),
        saveSettings:async(key,patch)=>{const id=typeof key==='string'?key:key.chatKey;settings.set(id,{...settings.get(id),...copy(patch)});},
        listJobs:async()=>[],getJob:async id=>copy(jobs.get(id)),putJob:async job=>{jobs.set(job.id,copy(job));},
        pruneSnapshots:async()=>({hasMore:false}),
        saveBatch:async options=>{
            writes.push(copy(options));
            const outcomes=options.items.map(item=>{
                if(item.accepted===false)return {itemId:item.id,status:'skipped'};
                if(item.action==='create'){
                    const target=ref(item.target.world,100+catalog.length);
                    catalog.push({...target,title:item.title,...copy(item.after)});
                    return {itemId:item.id,status:'applied',target};
                }
                if(item.action==='delete'){const index=catalog.findIndex(target=>target.id===item.target.id);if(index>=0)catalog.splice(index,1);}
                return {itemId:item.id,status:'applied',target:copy(item.target)};
            });
            return {complete:true,outcomes};
        },
    };
    const adapter={readWorld:async()=>{targetReads++;throw Error('unselected host read');}};
    const c=new WorkbenchController({storage,targets:{
        captureScope:async()=>copy(scope),
        listTargets:async selectedScope=>{reads.push([...selectedScope.worldNames]);return {targets:catalog.filter(t=>t.kind!=='world'||selectedScope.worldNames.includes(t.world)),worlds:selectedScope.worldNames.map(name=>({name}))};},
        prepareOperations:(operations,options)=>prepareOperations(operations,{...options,adapter}),
    },latestFloor:async()=>5,listPresets:async()=>[],captureHistory:async()=>({available:false}),getDefaultPreset:async()=>'',
    captureWorkbenchContext:async options=>{captures.push(copy(options));return {rawMessages:[]};}});
    c.verifySource=async()=>{};
    return {c,scope,user,a,hidden,global,catalog,settings,jobs,reads,writes,captures,adapter,get targetReads(){return targetReads;}};
}

test('controller fresh defaults require book opt-in and old saved selections infer only their own book',async()=>{
    const fresh=fixture();await fresh.c.open();
    assert.deepEqual([...fresh.c.selected],[fresh.user.id]);assert.deepEqual([...fresh.c.enabledWorlds],[]);
    const old=fixture({selectedTargetIds:[ref('甲书',1).id]});await old.c.open();
    assert.deepEqual([...old.c.enabledWorlds],['甲书']);
    const job=await old.c.newJob();
    assert.deepEqual(job.scope.worldNames,['甲书']);assert.equal(Object.hasOwn(job.scope,'availableWorlds'),false);
    assert.doesNotMatch(taskInstructions(job,old.c.settings,'edit'),/全局乙/);
});

test('draft selection and capture keep book permission separate from stale entry choices',async()=>{
    const {c,a,captures,settings}=fixture();await c.open();
    await c.select(new Set([a.id]),new Set(['甲书']));const job=await c.newJob();
    await c.select(new Set([a.id]),new Set());
    assert.deepEqual(job.scope.worldNames,[]);assert.deepEqual(job.selectedTargetIds,[]);
    assert.deepEqual(settings.get('material-controller').enabledWorlds,[]);
    await c.captureFor(job);assert.deepEqual(captures[0].selectedTargets,[]);assert.deepEqual(captures[0].enabledWorlds,[]);
    assert.deepEqual(c.worlds.map(world=>world.name),['甲书','全局乙'],'restricted run does not lose disabled books from the chooser');
});

test('controller passes explicit allowed entry IDs before preparing edits or creating in disabled books',async()=>{
    const f=fixture();await f.c.open();await f.c.select(new Set([f.a.id]),new Set(['甲书']));const job=await f.c.newJob();
    await f.c.captureFor(job);
    assert.deepEqual(f.captures[0].selectedTargets.map(t=>t.id),[f.a.id]);
    assert.deepEqual(f.reads.at(-1),['甲书']);
    await assert.rejects(()=>f.c.onTool(job,'edit','propose_changes',{operations:[{action:'replace',target:f.hidden.id,content:'bad'}]}),/未选中/);
    await assert.rejects(()=>f.c.onTool(job,'edit','propose_changes',{operations:[{action:'create',target:{kind:'world',world:'全局乙'},content:'bad'}]}),/未启用/);
    assert.equal(f.targetReads,0);assert.equal(f.writes.length,0);assert.equal(job.batches[0].items.length,0);
});

test('accepted creations stay within the enabled book and deletions update the next selection',async()=>{
    const f=fixture();await f.c.open();await f.c.select(new Set([f.a.id]),new Set(['甲书']));const job=await f.c.newJob();
    job.batches.push({id:'batch-2',title:'第二批',instructions:'',status:'pending',items:[],report:report()});
    await f.c.captureFor(job);
    await f.c.onTool(job,'edit','propose_changes',{operations:[{action:'create',target:{kind:'world',world:'甲书'},content:'新条目',metadata:{comment:'合成新条目'}}]});
    await f.c.saveReviewed(f.c.currentBatch().items);
    const created=job.batches[0].items[0].target;
    assert.ok(f.c.selected.has(created.id),JSON.stringify({selected:[...f.c.selected],created,items:job.batches[0].items,outcomes:job.batches[0].outcomes}));assert.deepEqual(f.writes[0].scope.worldNames,['甲书']);
    await f.c.captureFor(job);assert.ok(f.captures.at(-1).selectedTargets.some(target=>target.id===created.id));
    await f.c.onTool(job,'edit','propose_changes',{operations:[{action:'delete',target:f.a.id}]});
    await f.c.saveReviewed(f.c.currentBatch().items);
    assert.ok(!f.c.selected.has(f.a.id));assert.ok(f.c.selected.has(created.id));
    assert.deepEqual(f.settings.get('material-controller').enabledWorlds,['甲书']);
});

test('resuming an old broad-scope draft does not authorize its unselected global-book write',async()=>{
    const f=fixture({selectedTargetIds:[ref('甲书',1).id]});await f.c.open();
    const item={id:'old-item',target:copy(f.global),title:'旧版越界草案',action:'replace',before:{content:f.global.content,metadata:{}},after:{content:'应被阻止',metadata:{}},accepted:true};
    const old={id:'old-job',scope:copy(f.scope),mode:'free',status:'review',firstFloor:0,lastFloor:5,selectedTargetIds:[f.a.id],plan:[],messages:[],batches:[{id:'batch-1',status:'review',items:[item],report:report()}],report:report()};
    f.jobs.set(old.id,old);await f.c.resume(old.id);
    assert.deepEqual(f.c.job.scope.worldNames,['甲书']);
    f.c.api.storage.saveBatch=options=>applyReviewedItems(options.items,{scope:options.scope,adapter:f.adapter});
    await assert.rejects(()=>f.c.saveReviewed(f.c.currentBatch().items),/未启用/);
    assert.equal(f.targetReads,0);
    assert.equal(interruptedArchiveSetup({mode:'archive',status:'interrupted',plan:[{}],batches:[],messages:[{role:'assistant',kind:'plan',content:''}]}),false);
});
