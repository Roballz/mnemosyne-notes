import { database } from '../db.js';
import { applyReviewedItems, reconcileSkippedItems, sameValue, scopeKey } from './targets.js';

const JOBS='workbenchJobs',SNAPSHOTS='workbenchSnapshots';
const clone=value=>value==null?value:structuredClone(value);
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||Error('工作台本机保存失败'));});
const terminal=status=>['applied','failed','conflict','skipped'].includes(status);
const boundedLimit=(limit,max=200)=>Math.max(1,Math.min(max,Math.floor(Number(limit)||50)));
const requireScope=scope=>{const key=scopeKey(scope);if(!key)throw Error('缺少聊天身份');return key;};
const snapshotId=(scope,jobId,batchId,itemId)=>JSON.stringify(['workbench',requireScope(scope),String(jobId||''),String(batchId),String(itemId)]);
const intentState=value=>value==null?null:{content:value.content,metadata:value.metadata||{}};

export async function getSettings(scope='global') {
    const db=await database();return (await request(db.transaction('meta').objectStore('meta').get(['workbench.settings',requireScope(scope)])))||{};
}
export async function saveSettings(scope,patch) {
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('工作台设置无效');
    const key=['workbench.settings',requireScope(scope)],db=await database(),tx=db.transaction('meta','readwrite'),done=finished(tx),store=tx.objectStore('meta');
    const prior=store.get(key);let value;
    prior.onsuccess=()=>{value={...(prior.result||{}),...clone(patch)};store.put(value,key);};
    await done;return value;
}
async function payloads(kind,storeName,ids){
    const db=await database(),tx=db.transaction(['meta',storeName]),meta=tx.objectStore('meta'),index=tx.objectStore(storeName);
    // Read only the requested payloads. The fallback supports pre-release full records.
    return Promise.all(ids.map(id=>Promise.all([request(meta.get(['workbench.'+kind,id])),request(index.get(id))]).then(([payload,legacy])=>payload??legacy)));
}
const jobSummary=job=>({id:job.id,scopeKey:job.scopeKey,mode:job.mode,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,firstFloor:job.firstFloor,lastFloor:job.lastFloor,batches:job.batches?.map(b=>({id:b.id,index:b.index,status:b.status,count:b.count??b.items?.length??0}))});
export async function getJob(id) {return (await payloads('job',JOBS,[id]))[0];}
export async function putJob(job) {
    if(!job?.id)throw Error('任务缺少 ID');
    const now=Date.now(),value={...clone(job),version:1,scopeKey:requireScope(job.scope||job.scopeKey),createdAt:job.createdAt??now,updatedAt:job.updatedAt??now};
    const db=await database(),tx=db.transaction(['meta',JOBS],'readwrite'),done=finished(tx);
    tx.objectStore('meta').put(value,['workbench.job',value.id]);tx.objectStore(JOBS).put(jobSummary(value));await done;return value;
}
function timeRange(scope,before,timeField) {
    const key=requireScope(scope);const upper=Array.isArray(before)?[key,...before]:before?.id?[key,before[timeField],before.id]:Number.isFinite(before)?[key,before]:[key,[]];
    return IDBKeyRange.bound([key],upper,false,before!=null);
}
async function list(storeName,scope,{limit=50,before}={},project=value=>value) {
    const db=await database(),tx=db.transaction(storeName),rows=[];
    await new Promise((resolve,reject)=>{const cursor=tx.objectStore(storeName).index('scopeTime').openCursor(timeRange(scope,before,storeName===SNAPSHOTS?'createdAt':'updatedAt'),'prev');cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{const next=cursor.result;if(!next||rows.length>=boundedLimit(limit)){resolve();return;}rows.push(project(next.value));next.continue();};});
    return rows;
}
export const listJobs=(scope,options)=>list(JOBS,scope,options,jobSummary);
const summary=s=>({id:s.id,jobId:s.jobId,batchId:s.batchId,itemId:s.itemId,scopeKey:s.scopeKey,target:s.target,title:s.title,action:s.action,status:s.status,createdAt:s.createdAt,updatedAt:s.updatedAt,error:s.error,restores:s.restores});
export const listSnapshots=(scope,options)=>list(SNAPSHOTS,scope,options,summary);
export async function getSnapshot(id) {return (await payloads('snapshot',SNAPSHOTS,[id]))[0];}
async function getSnapshots(ids) {
    return payloads('snapshot',SNAPSHOTS,ids);
}
export async function getBatchOutcomes({jobId='',batchId,scope,items=[]}){
    const rows=await getSnapshots(items.map(item=>snapshotId(scope,jobId,batchId,item.id)));
    return rows.filter(Boolean).map(row=>({id:row.itemId,itemId:row.itemId,target:clone(row.target),status:row.status,snapshotId:row.id,error:row.error,decision:row.decision}));
}
async function writeSnapshots(rows) {
    if(!rows.length)return;
    const db=await database(),tx=db.transaction(['meta',SNAPSHOTS],'readwrite'),done=finished(tx),store=tx.objectStore(SNAPSHOTS),meta=tx.objectStore('meta');
    for(const row of rows){meta.put(row,['workbench.snapshot',row.id]);store.put({...summary(row),retentionTime:row.retentionTime});}await done;
}

let batchQueue=Promise.resolve();
export function saveBatch(options) {
    const run=()=>saveBatchNow(options);const operation=batchQueue.then(run,run);batchQueue=operation.catch(()=>{});return operation;
}
async function saveBatchNow({jobId='',batchId,scope,items,adapter,restores}) {
    if(!batchId)throw Error('保存批次缺少稳定 ID');
    if(!Array.isArray(items)||new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>!i.id))throw Error('审核项 ID 无效或重复');
    const key=requireScope(scope),records=new Map(),outcomes=[],remaining=[],rejections=[];
    const saved=await getSnapshots(items.map(item=>snapshotId(scope,jobId,batchId,item.id)));
    for(let i=0;i<items.length;i++){
        const item=clone(items[i]),record=saved[i];
        if(record){
            records.set(item.id,record);
            if(record.status==='applied'){outcomes.push({id:item.id,itemId:item.id,target:clone(record.target),status:'applied',snapshotId:record.id,recovered:true,...(item.accepted===false?{alreadyApplied:true,error:'本项已于先前保存；需要撤销时请使用快照回退'}:{})});continue;}
            if(item.accepted===false||record.decision==='skip'&&record.status!=='skipped'){
                record.decision='skip';record.updatedAt=Date.now();delete record.retentionTime;
                rejections.push({...item,target:clone(record.target),before:clone(record.before),after:clone(record.after),accepted:false,intent:true});continue;
            }
            // A reused batch ID must never replace an uncertain operation.
            if(!sameValue(intentState(record.before),intentState(item.before))||!sameValue(intentState(record.after),intentState(item.after))){outcomes.push({id:item.id,itemId:item.id,target:clone(record.target),status:'conflict',snapshotId:record.id,error:'该批次已有持久化保存意图；请恢复原批次后再创建新的修改'});continue;}
            remaining.push({...item,target:clone(record.target),before:clone(record.before),after:clone(record.after),accepted:true,intent:true});
        }else remaining.push(item);
    }
    const onResult=async outcome=>{
        const record=records.get(outcome.itemId);if(!record)return;
        record.status=outcome.status;record.updatedAt=Date.now();record.error=outcome.error||null;
        if(terminal(record.status))record.retentionTime=record.createdAt;else delete record.retentionTime;
        await writeSnapshots([record]);outcome.snapshotId=record.id;
    };
    if(rejections.length){
        await writeSnapshots(rejections.map(item=>records.get(item.id)));
        outcomes.push(...await reconcileSkippedItems(rejections,{scope,adapter,onResult}));
    }
    const applied=await applyReviewedItems(remaining,{
        scope,batchId,adapter,
        async beforeWrite(ready){
            const now=Date.now(),writes=[];
            for(const item of ready){
                const old=records.get(item.id);
                const record={version:1,id:snapshotId(scope,jobId,batchId,item.id),jobId,batchId,itemId:item.id,scopeKey:key,scope:clone(scope),target:clone(item.target),title:item.title||item.target.id,action:item.before===null?'create':item.after===null?'delete':'replace',before:clone(item.before),after:clone(item.after),status:'prepared',createdAt:old?.createdAt??now,updatedAt:now,...(restores?{restores}:{})};
                records.set(item.id,record);writes.push(record);
            }
            // All old/new text is durable before the first corresponding host write.
            await writeSnapshots(writes);
        },
        onResult,
    });
    outcomes.push(...applied);
    const count=status=>outcomes.filter(o=>o.status===status).length;
    return {batchId,outcomes,complete:outcomes.every(o=>['applied','skipped'].includes(o.status)),applied:count('applied'),skipped:count('skipped'),failed:outcomes.filter(o=>!['applied','skipped'].includes(o.status)).length};
}

export async function restoreSnapshot(id,{scope,batchId,adapter}={}) {
    const snapshot=await getSnapshot(id);if(!snapshot)throw Error('快照不存在或已过期');
    if(snapshot.status!=='applied')throw Error('只能回退已确认写入成功的快照');
    if(requireScope(scope)!==snapshot.scopeKey)throw Error('不能将其他聊天的快照回退到当前工作台');
    const restoreId=batchId||`restore-${globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    return saveBatch({scope,batchId:restoreId,jobId:snapshot.jobId,adapter,restores:id,items:[{id:'restore',title:`回退 · ${snapshot.title}`,target:clone(snapshot.target),before:clone(snapshot.after),after:clone(snapshot.before),accepted:true}]});
}

export async function pruneSnapshots({days=30,now=Date.now(),limit=100}={}) {
    if(!Number.isFinite(days)||days<1||days>36500)throw Error('快照保留天数必须为 1–36500');
    if(!Number.isFinite(now))throw Error('清理时间无效');
    const threshold=now-days*86400000,db=await database(),tx=db.transaction(['meta',SNAPSHOTS],'readwrite'),done=finished(tx),store=tx.objectStore(SNAPSHOTS);let deleted=0,hasMore=false;
    const cursor=store.index('expiry').openCursor(IDBKeyRange.upperBound(threshold));
    cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(deleted>=boundedLimit(limit,500)){hasMore=true;return;}if(terminal(row.value.status)){tx.objectStore('meta').delete(['workbench.snapshot',row.value.id]);row.delete();deleted++;}row.continue();};
    await done;return {deleted,hasMore};
}
function fenced(text,language='') {
    text=String(text??'');let longest=2;for(const match of text.matchAll(/`+/g))longest=Math.max(longest,match[0].length);const fence='`'.repeat(longest+1);
    return `${fence}${language}\n${text}\n${fence}`;
}
export async function exportSnapshots(ids) {
    if(!Array.isArray(ids)||ids.length>1000)throw Error('每次最多导出 1000 个快照');
    const lines=['# 记事簿工作台修改快照',`\n导出时间：${new Date().toISOString()}`];
    let characters=0,processed=0;
    for(const id of [...new Set(ids)]){
        const snapshot=await getSnapshot(id);if(!snapshot)throw Error('选中的快照已不存在，请刷新列表后重新选择');
        const serializedSize=JSON.stringify(snapshot).length;
        characters+=serializedSize;
        if(characters>12_000_000)throw Error('本次导出内容过大，请减少选择的快照后分批导出');
        if(++processed%8===0)await new Promise(resolve=>setTimeout(resolve,0));
        lines.push(`\n## ${String(snapshot.title||snapshot.target.id).replace(/[\r\n]/g,' ')}`,`\n时间：${new Date(snapshot.createdAt).toISOString()}  \n状态：${snapshot.status}  \n操作：${snapshot.action}  \n批次：${snapshot.batchId}`,`\n### 目标\n\n${fenced(JSON.stringify(snapshot.target,null,2),'json')}`);
        for(const [label,value] of [['修改前',snapshot.before],['修改后',snapshot.after]]){
            lines.push(`\n### ${label}`);
            if(value===null){lines.push('\n（条目不存在）');continue;}
            lines.push(`\n${fenced(value.content)}`,`\n属性：\n\n${fenced(JSON.stringify(value.metadata||{},null,2),'json')}`);
            if(value.raw||value.original)lines.push(`\n完整条目与导入来源属性：\n\n${fenced(JSON.stringify({raw:value.raw,original:value.original},null,2),'json')}`);
        }
    }
    return lines.join('\n')+'\n';
}
