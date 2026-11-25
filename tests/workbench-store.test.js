import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { database,meta } from '../lib/db.js';
import { getSettings,saveSettings,putJob,getJob,listJobs,markArchivedKey,saveBatch,getBatchOutcomes,listSnapshots,getSnapshot,restoreSnapshot,exportSnapshots,pruneSnapshots } from '../lib/workbench/store.js';
import { listTargets,prepareOperations } from '../lib/workbench/targets.js';
import { WorkbenchController } from '../lib/workbench/controller.js';
import { reportMarkdown, settingsWithDefaults, taskInstructions } from '../lib/workbench/model.js';

const copy=v=>structuredClone(v),req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const txDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);});
function fixture(name='store-'+crypto.randomUUID()){
 const scope={chatKey:name,worldNames:['合成书']};
 let live={entries:{0:{uid:0,comment:'合成条目',content:'旧原文',key:['线索'],constant:true,unknown:{preserve:7}}},originalData:{entries:[{uid:0,content:'旧原文',keys:['线索'],extensions:{preserve:8}}]}},durable=copy(live),writes=0;
 const adapter={readWorld:async()=>copy(live),readWorldPersisted:async()=>copy(durable),saveWorld:async(name,data)=>{writes++;live=copy(data);durable=copy(data);}};
 return {scope,adapter,get live(){return live;},get durable(){return durable;},get writes(){return writes;},setLive:value=>{live=copy(value);},setDurable:value=>{durable=copy(value);},change:fn=>{fn(live);durable=copy(live);}};
}
async function proposal(f,operations){const {targets}=await listTargets(f.scope,{adapter:f.adapter});return prepareOperations(operations||[{action:'replace',target:targets[0].id,content:'新原文'}],{scope:f.scope,targets,adapter:f.adapter});}

async function seed(rows){const db=await database(),tx=db.transaction(['meta','workbenchSnapshots'],'readwrite'),done=txDone(tx);for(const row of rows){tx.objectStore('workbenchSnapshots').put(row);tx.objectStore('meta').put({...row,before:{content:'存档原文',metadata:{}},after:null},['workbench.snapshot',row.id]);}await done;}
async function seedIntent(f,batchId,item,status='prepared'){
 const id=JSON.stringify(['workbench',f.scope.chatKey,'',batchId,item.id]),row={id,itemId:item.id,batchId,scopeKey:f.scope.chatKey,scope:copy(f.scope),target:copy(item.target),before:copy(item.before),after:copy(item.after),status,createdAt:Date.now(),updatedAt:Date.now()};
 const db=await database(),tx=db.transaction(['meta','workbenchSnapshots'],'readwrite'),done=txDone(tx);tx.objectStore('workbenchSnapshots').put(row);tx.objectStore('meta').put(row,['workbench.snapshot',id]);await done;return id;
}

test('v1 upgrade preserves notebook data and creates workbench stores in the same database',async()=>{
 const opening=indexedDB.open('mnemosyne-notes-v1',1);opening.onupgradeneeded=()=>{const db=opening.result;db.createObjectStore('meta');const items=db.createObjectStore('items',{keyPath:'key'});items.createIndex('order','order',{unique:true});items.createIndex('facets','facets',{multiEntry:true});items.createIndex('filteredOrder','filteredOrder',{multiEntry:true});};
 const old=await req(opening),tx=old.transaction('meta','readwrite'),done=txDone(tx);tx.objectStore('meta').put({text:'现有收藏保留'},['synthetic-note']);await done;old.close();
 const db=await database();assert.equal(db.version,2);assert.ok(db.objectStoreNames.contains('workbenchSnapshots'));assert.deepEqual(await meta(['synthetic-note']),{text:'现有收藏保留'});
 assert.equal(db.transaction('workbenchSnapshots').objectStore('workbenchSnapshots').index('expiry').keyPath,'retentionTime');
});
test('per-chat settings merge independently and durable jobs use thin list records',async()=>{
 await saveSettings('chat-a',{archivedFloor:100});await Promise.all([saveSettings('chat-a',{mode:'archive'}),saveSettings('chat-a',{remindedAt:150})]);await saveSettings('chat-b',{archivedFloor:0});
 assert.deepEqual(await getSettings('chat-a'),{archivedFloor:100,mode:'archive',remindedAt:150});assert.equal((await getSettings('chat-b')).archivedFloor,0);
 const job={id:'job-thin',scope:{chatKey:'jobs'},createdAt:1,updatedAt:2,mode:'archive',status:'review',messages:[{role:'user',content:'完整草稿'}],batches:[{id:'batch',items:[{before:{content:'旧'},after:{content:'新'}}]}]};await putJob(job);
 assert.equal((await getJob(job.id)).messages[0].content,'完整草稿');const rows=await listJobs('jobs');assert.equal(rows[0].messages,undefined);assert.equal(rows[0].batches[0].count,1);
 const raw=await req((await database()).transaction('workbenchJobs').objectStore('workbenchJobs').get(job.id));assert.equal(raw.messages,undefined);
});
test('snapshot journal commits before host mutation; same batch retry is idempotent',async()=>{
 const f=fixture(),items=await proposal(f),save=f.adapter.saveWorld;
 f.adapter.saveWorld=async(name,data)=>{const rows=await listSnapshots(f.scope);assert.equal(rows.length,1);const journal=await getSnapshot(rows[0].id);assert.equal(journal.status,'prepared');assert.equal(journal.before.content,'旧原文');assert.equal(journal.after.content,'新原文');assert.equal(journal.after.raw.content,'新原文');await save(name,data);};
 const result=await saveBatch({scope:f.scope,jobId:'journal',batchId:'one',items,adapter:f.adapter});assert.equal(result.complete,true);assert.equal(result.applied,1);assert.equal(f.writes,1);
 const repeat=await saveBatch({scope:f.scope,jobId:'journal',batchId:'one',items,adapter:f.adapter});assert.equal(repeat.complete,true);assert.equal(f.writes,1);
 const rows=await listSnapshots(f.scope);assert.equal(rows[0].before,undefined);const raw=await req((await database()).transaction('workbenchSnapshots').objectStore('workbenchSnapshots').get(rows[0].id));assert.equal(raw.after,undefined);
 const exportText=await exportSnapshots([rows[0].id]);assert.match(exportText,/旧原文/);assert.match(exportText,/新原文/);assert.match(exportText,/preserve/);
});
test('a reopened archive draft saves TT recursion toggles and levels unchanged in one book write',async()=>{
 const f=fixture(),values=[false,true,0,3];
 f.change(book=>{
  for(const [uid,delayUntilRecursion] of values.entries()){
   book.entries[uid]={uid,content:'旧原文',delayUntilRecursion};
  }
  book.originalData.entries=values.map((value,uid)=>({uid,content:'旧原文',extensions:{delay_until_recursion:value}}));
 });
 const {targets}=await listTargets(f.scope,{adapter:f.adapter});
 const items=await prepareOperations(targets.map(t=>({action:'replace',target:t.id,content:'审核定稿'+t.uid})),{scope:f.scope,targets});
 const jobId='recursion-draft',batchId='first';
 await putJob({id:jobId,scope:f.scope,mode:'archive',status:'review',batches:[{id:batchId,items}]});
 const saved=await getJob(jobId);
 const options={jobId,batchId,scope:f.scope,items:saved.batches[0].items,adapter:f.adapter};
 const result=await saveBatch(options);
 assert.equal(result.applied,values.length);
 for(const [uid,value] of values.entries()){
  assert.equal(f.durable.entries[uid].content,'审核定稿'+uid);
  assert.equal(f.durable.entries[uid].delayUntilRecursion,value);
  assert.equal(f.durable.originalData.entries[uid].extensions.delay_until_recursion,value);
 }
 assert.equal((await saveBatch(options)).complete,true);
 assert.equal(f.writes,1);
});
test('reopening a reviewed draft preserves inactive roles and untouched legacy properties',async()=>{
 const f=fixture(),jobId='role-draft',batchId='first';
 f.change(book=>{
  Object.assign(book.entries[0],{position:0,role:null,scanDepth:'8'});
  book.entries[1]={uid:1,position:4,role:2,content:'旧原文'};
  book.originalData.entries.push({uid:1,content:'旧原文',extensions:{role:2}});
 });
 const {targets}=await listTargets(f.scope,{adapter:f.adapter});
 const items=await prepareOperations(targets.map(target=>({action:'replace',target:target.id,content:'定稿'+target.uid})),{scope:f.scope,targets});
 await putJob({id:jobId,scope:f.scope,mode:'archive',status:'review',batches:[{id:batchId,items}]});
 const job=await getJob(jobId),options={scope:f.scope,adapter:f.adapter,jobId,batchId,items:job.batches[0].items};
 assert.equal((await saveBatch(options)).applied,2);
 assert.equal(f.durable.entries[0].content,'定稿0');
 assert.equal(f.durable.entries[0].role,null);
 assert.equal(f.durable.entries[0].scanDepth,'8');
 assert.deepEqual(f.durable.originalData.entries[0].extensions,{preserve:8});
 assert.equal(f.durable.entries[1].role,2);
 assert.equal((await saveBatch(options)).complete,true);
 assert.equal(f.writes,1);
});
test('editing a role still rejects invalid values before writing and identifies the entry',async()=>{
 const f=fixture();
 f.change(book=>{Object.assign(book.entries[0],{position:4,role:1});});
 const items=await proposal(f),options={scope:f.scope,batchId:'change-role',items,adapter:f.adapter};
 for(const invalid of [3,'1',false]){
  items[0].after.metadata.role=invalid;
  await assert.rejects(()=>saveBatch(options),/合成条目.*消息角色超出允许范围/);
 }
 assert.equal(f.writes,0);
 Object.assign(items[0].after.metadata,{position:0,role:null});
 assert.equal((await saveBatch(options)).applied,1);
 assert.equal(f.durable.entries[0].role,null);
 assert.equal(f.durable.originalData.entries[0].extensions.role,null);
});
test('lost create acknowledgement recovers original UID without duplicate entries',async()=>{
 const f=fixture(),items=await proposal(f,[{action:'create',target:{kind:'world',world:'合成书'},content:'新建内容',metadata:{comment:'新建条目',light:'blue'}}]);let attempts=0,failRead=true;
 f.adapter.saveWorld=async(name,data)=>{attempts++;f.setLive(data);f.setDurable(data);throw Error('lost acknowledgement');};
 f.adapter.readWorldPersisted=async()=>{if(failRead){failRead=false;throw Error('disconnected');}return copy(f.durable);};
 const first=await saveBatch({scope:f.scope,batchId:'uncertain-create',items,adapter:f.adapter});assert.equal(first.outcomes[0].status,'unknown');assert.equal(first.complete,false);
 const second=await saveBatch({scope:f.scope,batchId:'uncertain-create',items,adapter:f.adapter});assert.equal(second.complete,true);assert.equal(second.outcomes[0].recovered,true);assert.equal(attempts,1);assert.equal(Object.keys(f.durable.entries).length,2);
 assert.equal((await listSnapshots(f.scope)).length,1);
});
test('failed durable save with dirty working cache retries its original intent',async()=>{
 const f=fixture(),items=await proposal(f);let attempts=0;
 f.adapter.saveWorld=async(name,data)=>{attempts++;f.setLive(data);if(attempts===1)throw Error('disk unavailable');f.setDurable(data);};
 const first=await saveBatch({scope:f.scope,batchId:'cached-failure',items,adapter:f.adapter});assert.equal(first.outcomes[0].status,'failed');assert.equal(f.live.entries[0].content,'新原文');assert.equal(f.durable.entries[0].content,'旧原文');
 const changed=copy(items);changed[0].after.content='另外的新修改';assert.equal((await saveBatch({scope:f.scope,batchId:'cached-failure',items:changed,adapter:f.adapter})).outcomes[0].status,'conflict');
 const second=await saveBatch({scope:f.scope,batchId:'cached-failure',items,adapter:f.adapter});assert.equal(second.complete,true);assert.equal(attempts,2);assert.equal(f.durable.entries[0].content,'新原文');
});
test('prepared intent rejected after restart is inspected and skipped without replay',async()=>{
 const f=fixture(),items=await proposal(f),batchId='prepared-rejection';await seedIntent(f,batchId,items[0]);
 const journals=await getBatchOutcomes({scope:f.scope,batchId,items});assert.equal(journals[0].status,'prepared');assert.equal(journals[0].before,undefined);
 items[0].accepted=false;const result=await saveBatch({scope:f.scope,batchId,items,adapter:f.adapter});assert.equal(result.complete,true);assert.equal(result.outcomes[0].status,'skipped');assert.equal(f.writes,0);assert.equal(f.live.entries[0].content,'旧原文');
});
test('rejecting a failed write clears its dirty cache before recording skipped',async()=>{
 const f=fixture(),{targets}=await listTargets(f.scope,{adapter:f.adapter}),items=await proposal(f,[{action:'replace',target:targets[0].id,content:'拒绝的版本',metadata:{role:1}}]);let attempts=0;
 f.adapter.saveWorld=async(name,data)=>{attempts++;f.setLive(data);if(attempts===1)throw Error('disk failure');f.setDurable(data);};
 const first=await saveBatch({scope:f.scope,batchId:'failed-skip',items,adapter:f.adapter});assert.equal(first.outcomes[0].status,'failed');assert.equal(f.live.entries[0].content,'拒绝的版本');assert.equal(f.durable.entries[0].content,'旧原文');
 const latest=copy(f.live);latest.entries[9]={uid:9,content:'其他人的待保存修改'};f.setLive(latest);
 items[0].accepted=false;const result=await saveBatch({scope:f.scope,batchId:'failed-skip',items,adapter:f.adapter});assert.equal(result.complete,true);assert.equal(result.outcomes[0].status,'skipped');assert.equal(result.outcomes[0].revertedWorkingCopy,true);
 assert.equal(f.live.entries[0].content,'旧原文');assert.equal(f.durable.entries[0].content,'旧原文');assert.equal(f.live.entries[0].role,undefined);assert.equal(f.live.originalData.entries[0].extensions.role,undefined);assert.equal(f.live.entries[9].content,'其他人的待保存修改');assert.equal(attempts,2);
});
test('rejection with unavailable disk evidence stays unknown and never replays after',async()=>{
 const f=fixture(),items=await proposal(f),batchId='skip-no-evidence';await seedIntent(f,batchId,items[0]);
 f.adapter.readWorldPersisted=async()=>{throw Error('offline');};items[0].accepted=false;
 const first=await saveBatch({scope:f.scope,batchId,items,adapter:f.adapter});assert.equal(first.complete,false);assert.equal(first.outcomes[0].status,'unknown');assert.equal(f.writes,0);
 assert.equal((await getSnapshot(first.outcomes[0].snapshotId)).decision,'skip');
 f.adapter.readWorldPersisted=async()=>copy(f.durable);items[0].accepted=true;
 const resumed=await saveBatch({scope:f.scope,batchId,items,adapter:f.adapter});assert.equal(resumed.outcomes[0].status,'skipped');assert.equal(f.writes,0);
});
test('rejected uncertain intent already on disk is reported applied without undoing it',async()=>{
 const f=fixture(),items=await proposal(f),batchId='already-applied-rejection';await seedIntent(f,batchId,items[0]);f.change(book=>{book.entries[0].content='新原文';});items[0].accepted=false;
 const result=await saveBatch({scope:f.scope,batchId,items,adapter:f.adapter});assert.equal(result.outcomes[0].status,'applied');assert.equal(result.outcomes[0].alreadyApplied,true);assert.equal(f.writes,0);assert.equal(f.durable.entries[0].content,'新原文');
});
test('closed entry deletion stores full original and rollback restores it with a new snapshot',async()=>{
 const f=fixture(),{targets}=await listTargets(f.scope,{adapter:f.adapter}),original=copy(f.live);
 const items=await proposal(f,[{action:'delete',target:targets[0].id}]);const result=await saveBatch({scope:f.scope,batchId:'closed',items,adapter:f.adapter});assert.equal(result.complete,true);assert.equal(f.live.entries[0],undefined);
 const id=result.outcomes[0].snapshotId,snapshot=await getSnapshot(id);assert.equal(snapshot.after,null);assert.equal(snapshot.before.raw.unknown.preserve,7);
 await assert.rejects(()=>restoreSnapshot(id,{scope:{...f.scope,chatKey:'other'},adapter:f.adapter}),/其他聊天/);
 const restored=await restoreSnapshot(id,{scope:f.scope,batchId:'restore-closed',adapter:f.adapter});assert.equal(restored.complete,true);assert.deepEqual(f.live.entries[0],original.entries[0]);assert.equal(f.live.originalData.entries[0].extensions.preserve,8);assert.equal((await listSnapshots(f.scope)).length,2);
 const text=await exportSnapshots((await listSnapshots(f.scope)).map(s=>s.id));assert.match(text,/条目不存在/);assert.match(text,/回退/);
});
test('rollback refuses a changed target and rejected items are not written',async()=>{
 const f=fixture(),items=await proposal(f);const result=await saveBatch({scope:f.scope,batchId:'first',items,adapter:f.adapter});f.change(b=>{b.entries[0].content='用户更新';});
 const back=await restoreSnapshot(result.outcomes[0].snapshotId,{scope:f.scope,batchId:'rollback-conflict',adapter:f.adapter});assert.equal(back.complete,false);assert.equal(back.outcomes[0].status,'conflict');assert.equal(f.live.entries[0].content,'用户更新');
 const ignored=await proposal(f);ignored[0].accepted=false;assert.equal((await saveBatch({scope:f.scope,batchId:'skip',items:ignored,adapter:f.adapter})).skipped,1);assert.equal(f.writes,1);
});
test('snapshot pagination uses createdAt and cannot repeat when updatedAt is newer',async()=>{
 await seed([100,200,300].map(n=>({id:'page-'+n,scopeKey:'pages',createdAt:n,updatedAt:999999,status:'applied',target:{id:'synthetic'},retentionTime:n})));
 const first=await listSnapshots('pages',{limit:2});assert.deepEqual(first.map(r=>r.id),['page-300','page-200']);
 const second=await listSnapshots('pages',{limit:2,before:first.at(-1)});assert.deepEqual(second.map(r=>r.id),['page-100']);
});
test('bounded default 30-day retention removes full payloads, preserving uncertain writes and notes',async()=>{
 const now=Date.now(),old=now-40*86400000;
 await seed([{id:'ret-old',scopeKey:'retention',createdAt:old,updatedAt:old,status:'applied',retentionTime:old,target:{id:'synthetic'}},{id:'ret-new',scopeKey:'retention',createdAt:now-10*86400000,updatedAt:now,status:'applied',retentionTime:now-10*86400000,target:{id:'synthetic'}},{id:'ret-pending',scopeKey:'retention',createdAt:old,updatedAt:old,status:'unknown',target:{id:'synthetic'}}]);
 const bounded=await pruneSnapshots({now,limit:1});assert.equal(bounded.deleted,1);assert.equal(bounded.hasMore,true);
 await pruneSnapshots({now});assert.equal(await getSnapshot('ret-old'),undefined);assert.ok(await getSnapshot('ret-new'));assert.ok(await getSnapshot('ret-pending'));
 assert.equal(await meta(['workbench.snapshot','ret-old']),undefined);assert.deepEqual(await meta(['synthetic-note']),{text:'现有收藏保留'});
 const longer=await pruneSnapshots({now,days:60});assert.equal(longer.deleted,0);
});

test('more than 100 reviewed operations persist without a hidden cap or repeated host writes',async()=>{
 const f=fixture(),content='## S-001 合成同编号\n已经完成了。'+'甲'.repeat(801);
 const items=await proposal(f,Array.from({length:125},()=>({action:'create',target:{kind:'world',world:'合成书'},content})));
 const result=await saveBatch({batchId:'large-batch',scope:f.scope,items,adapter:f.adapter});
 assert.equal(result.complete,true);assert.equal(result.applied,125);assert.equal(f.writes,1);
 assert.equal(Object.values(f.durable.entries).filter(entry=>entry.content===content).length,125);
 const replay=await saveBatch({batchId:'large-batch',scope:f.scope,items,adapter:f.adapter});
 assert.equal(replay.applied,125);assert.equal(f.writes,1);
});

test('confirmed manual corrections update old task reports and the next request together',async()=>{
 const scope={chatKey:'legacy-archive-correction',worldNames:[]},target='world:w:1';
 const retained=['确认一','确认二','仍须保留'].map(key=>({key,reason:'待核对',into:[target]}));
 const report={cleared:[],retained,closed:[]},titles={[target]:'隐藏认知'};
 const task={id:'legacy-archive-done',scope,mode:'archive',status:'abandoned',createdAt:1,completedAt:2,
  firstFloor:100,lastFloor:150,messages:[{role:'assistant',content:'原讨论'}],batches:[],report,finalReport:reportMarkdown(report,titles)};
 await putJob(task);
 await saveSettings(scope,{retained,archivedFloor:150,remindedAt:150});
 const controller=new WorkbenchController({
  targets:{captureScope:async()=>scope,listTargets:async()=>({targets:[],worlds:[]})},
  latestFloor:async()=>200,listPresets:async()=>[],
 });
 await controller.open();
 const unstarted=await controller.newJob();
 assert.deepEqual(unstarted.carry,retained);
 await controller.resume(task.id);
 assert.equal(controller.job.status,'done');
 controller.targets=[{id:target,title:titles[target]}];
 for(const key of ['确认一','确认二'])assert.equal(await controller.markArchivedKey(controller.job,key),true);
 const saved=await getJob(task.id);
 assert.deepEqual(saved.report.cleared,retained.slice(0,2).map(({key,into})=>({key,into})));
 assert.deepEqual(saved.report.retained,retained.slice(2));
 assert.deepEqual(saved.messages,task.messages);
 assert.equal(saved.finalReport,reportMarkdown(saved.report,titles));
 assert.deepEqual(await getSettings(scope),{mode:'archive',retained:retained.slice(2),retainedJobId:task.id,archivedFloor:150,remindedAt:150});
 assert.equal((await markArchivedKey({scope,jobId:task.id,key:'确认一',titles})).removedFromCarry,false);
 await controller.abandon();
 assert.equal((await getJob(task.id)).status,'done');
 const next=await controller.newJob(),prompt=taskInstructions(next,settingsWithDefaults(),'discuss');
 assert.match(prompt,/仍须保留/);
 assert.doesNotMatch(prompt,/确认一|确认二|原讨论/);
 await controller.resume(unstarted.id);
 controller.captureFor=async()=>({});
 let dispatched;
 controller.api.runWorkbench=async(_,request)=>{dispatched=request.messages.at(-1).content;return {text:'新一轮规划'};};
 await controller.send('继续整理');
 assert.match(dispatched,/仍须保留/);
 assert.doesNotMatch(dispatched,/确认一|确认二|原讨论/);
});

test('editing a completed report preserves a newer task’s matching carry, with and without provenance',async()=>{
 for(const provenance of [false,true]){
  const scope={chatKey:'same-floor-'+provenance},retained=[{key:'同名事项',reason:'待核对',into:['world:w:1']}];
  const report={retained,cleared:[],closed:[]};
  const done={scope,mode:'archive',status:'done',lastFloor:200,report,finalReport:reportMarkdown(report),batches:[]};
  const older={...done,id:'older-'+provenance,createdAt:100,completedAt:110,updatedAt:115};
  const newer={...done,id:'newer-'+provenance,createdAt:120,completedAt:130,updatedAt:135};
  await putJob(older);await putJob(newer);
  await saveSettings(scope,{archivedFloor:200,retained,...(provenance?{retainedJobId:newer.id}:{})});
  await assert.rejects(()=>markArchivedKey({scope:'other',jobId:older.id,key:'同名事项'}),/本聊天/);
  assert.equal((await markArchivedKey({scope,jobId:older.id,key:'同名事项'})).removedFromCarry,false);
  assert.equal((await getJob(older.id)).report.cleared[0].key,'同名事项');
  assert.deepEqual((await getSettings(scope)).retained,retained);
  assert.deepEqual((await getJob(newer.id)).report.retained,retained);
 }
});
