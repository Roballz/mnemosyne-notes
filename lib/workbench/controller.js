import * as storage from './store.js';
import * as targets from './targets.js';
import { captureWorkbenchContext, latestFloor } from './context.js';
import { listPresets } from './tt.js';
import { Host } from '../host.js';
import { updateReminderState } from './reminders.js';
import { runWorkbench, cancelWorkbenchRun } from './llm.js';
import { captureHistory, getDefaultPreset } from './memory.js';
import { clone, makeId, settingsWithDefaults, validateSettings, selectedIds, rangeFor, nextReminder, validatePlan, normalizeReport, reconcileReport, aggregateReport, reportMarkdown, taskInstructions, validateArchiveEdits, TOOLS } from './model.js';

const emptyReport=()=>({cleared:[],retained:[],closed:[]});
async function sourceSignature(messages){
    if(!globalThis.crypto?.subtle)throw Error('工作台需要安全的正文版本校验能力');
    const bytes=new TextEncoder().encode(JSON.stringify(messages));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export class WorkbenchController {
    constructor(deps={}) {
        this.api={storage,targets,captureWorkbenchContext,latestFloor,listPresets,runWorkbench,cancelWorkbenchRun,captureHistory,getDefaultPreset,...deps};
        this.listeners=new Set();this.persistChain=Promise.resolve();this.generation=0;this.running=false;this.saving=false;this.liveText='';
    }
    subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
    changed(kind='state'){for(const fn of this.listeners)fn(kind);}
    async persist(job=this.job){
        if(!job)return;job.updatedAt=Date.now();
        const value=clone(job);
        const next=this.persistChain.catch(()=>{}).then(()=>this.api.storage.putJob(value));
        this.persistChain=next;await next;
    }
    async open(){
        const generation=++this.generation,scope=await this.api.targets.captureScope();
        const [global,state,catalog,last,jobs,presets]=await Promise.all([
            this.api.storage.getSettings('global'),this.api.storage.getSettings(scope),
            this.api.targets.listTargets(scope),this.api.latestFloor(),this.api.storage.listJobs(scope,{limit:30}),
            this.api.listPresets().catch(()=>[]),
        ]);
        let pendingJob=this.job;
        if(pendingJob?.scope?.chatKey!==scope.chatKey){
            const pending=jobs.find(j=>!['done','abandoned'].includes(j.status));
            pendingJob=pending?await this.api.storage.getJob(pending.id):null;
        }
        if(generation!==this.generation)return;
        if(this.running&&this.scope?.chatKey!==scope.chatKey)throw Error('另一聊天的工作台仍在生成。可先停止该任务，再切换工作台。');
        Object.assign(this,{scope,settings:settingsWithDefaults(global),state:{mode:'archive',archivedFloor:0,remindedAt:0,...state},targets:catalog.targets,worlds:catalog.worlds,lastFloor:last,jobs,presets});
        this.selected=selectedIds(this.targets,this.state.selectedTargetIds);
        this.job=pendingJob;
        // A run cannot survive a frontend restart; only complete staged calls are recoverable.
        if(this.job?.status==='running'&&!this.running){
            try{await this.cancelPreviousRun(this.job);}catch(error){this.job.nativeCancelError=error.message;}
            this.job.status=this.job.batches?.some(b=>b.status==='review')?'review':'interrupted';
            this.job.error='上次生成中断，已完成的草案保留。可审核或重试当前批。';await this.persist();
        }
        this.changed();
        this.cleanup().catch(error=>{this.notice=error.message;this.changed('notice');});
    }
    async cleanup(){
        if(this.cleanupAt&&Date.now()-this.cleanupAt<3600000)return;
        this.cleanupAt=Date.now();
        // A bounded transaction only; subsequent openings continue any large backlog.
        const result=await this.api.storage.pruneSnapshots({days:this.settings.retentionDays,now:Date.now(),limit:100});
        if(result.hasMore&&!this.cleanupTimer)this.cleanupTimer=setTimeout(()=>{this.cleanupTimer=null;this.cleanupAt=0;this.cleanup().catch(()=>{});},2000);
    }
    async saveSettings(patch){
        const settings=validateSettings({...this.settings,...patch});
        await this.api.storage.saveSettings('global',settings);this.settings=settings;this.changed('settings');
    }
    async saveState(patch){
        const scope=this.scope;if(!scope)throw Error('请先打开聊天');
        const nextState={...this.state,...patch};
        const changesRange=['mode','firstFloor','throughFloor','archivedFloor'].some(key=>key in patch);
        const draftChanged=this.job?.status==='draft'&&(changesRange||'selectedTargetIds' in patch);
        // Reject invalid ranges before either persistent or in-memory state changes.
        const nextRange=changesRange||draftChanged?rangeFor(nextState.mode,nextState,this.lastFloor):null;
        await this.api.storage.saveSettings(scope,patch);
        updateReminderState(scope.chatKey,patch);
        if(this.scope?.chatKey===scope.chatKey){
            Object.assign(this.state,patch);
            if(draftChanged&&this.job?.status==='draft'){
                Object.assign(this.job,nextRange,{mode:this.state.mode,cursorBase:this.state.archivedFloor||0});
                if(patch.selectedTargetIds)this.job.selectedTargetIds=[...patch.selectedTargetIds];
                this.job.plan=[];this.job.batches=this.state.mode==='free'?[{id:'batch-1',index:0,title:'自由编辑',instructions:'',status:'pending',items:[],report:emptyReport()}]:[];
                delete this.job.sourceSignature;delete this.job.history;this.capture=null;await this.persist();
            }
            this.changed('state');
        }
    }
    async select(ids){this.selected=new Set(ids);await this.saveState({selectedTargetIds:[...this.selected]});}
    async setArchivedFloor(floor){
        if(!Number.isInteger(floor)||floor<0||floor>this.lastFloor)throw Error('请输入0到最新楼层之间的整数');
        if(this.saving)throw Error('正在保存，请稍后再修改归档楼层');
        await this.saveState({archivedFloor:floor,remindedAt:floor});
    }
    async reminder(){
        if(!this.scope||this.running)return null;
        const last=await this.api.latestFloor();this.lastFloor=last;
        const threshold=nextReminder(this.state.archivedFloor||0,last,this.state.remindedAt||0);
        if(threshold!=null)await this.saveState({remindedAt:threshold});
        this.changed('progress');return threshold;
    }
    async newJob(){
        if(this.running||this.saving)throw Error('请等待当前操作完成');
        if(this.job&&!['done','abandoned'].includes(this.job.status))throw Error('请先完成或放下当前任务，草案会保留在任务记录中');
        this.lastFloor=await this.api.latestFloor();
        const range=rangeFor(this.state.mode,this.state,this.lastFloor);
        const job={id:makeId('job'),schemaVersion:1,scope:clone(this.scope),mode:this.state.mode,status:'draft',
            createdAt:Date.now(),updatedAt:Date.now(),...range,cursorBase:this.state.archivedFloor||0,
            selectedTargetIds:[...this.selected],config:{sourceId:this.settings.sourceId,presetId:this.settings.presetId},
            carry:clone(this.state.retained||[]),plan:[],batches:[],messages:[],report:emptyReport()};
        if(job.mode==='free')job.batches.push({id:'batch-1',index:0,title:'自由编辑',instructions:'',status:'pending',items:[],report:emptyReport()});
        this.job=job;await this.persist();this.changed();return job;
    }
    async resume(id){
        if(this.running||this.saving)throw Error('请等待当前操作完成');
        const job=await this.api.storage.getJob(id);
        if(!job||job.scope.chatKey!==this.scope.chatKey)throw Error('任务不属于当前聊天');
        if(['running','abandoned'].includes(job.status)){
            job.status=job.batches?.some(b=>['review','partial'].includes(b.status))?'review':job.plan?.length?(job.batches.some(b=>b.status==='saved')?'ready':'planned'):'draft';
        }
        this.job=job;this.capture=null;this.liveText='';await this.persist();this.changed();
    }
    async abandon(){
        if(this.running||this.saving)throw Error('请先停止生成或等待保存完成');
        if(this.job){this.job.status='abandoned';await this.persist();}
        this.job=null;this.capture=null;this.changed();
    }
    stop(){this.abort?.abort();this.changed('progress');}
    async cancelPreviousRun(job){
        if(!job?.nativeRunId||job.nativeTerminal||job.nativeCancelAcknowledged)return;
        const receipt=await this.api.cancelWorkbenchRun(job.nativeRunId);
        job.nativeCancelAcknowledged=true;job.nativeCancellation={requestedAt:Date.now(),receipt};
        job.nativeCancelError='';await this.persist(job);
    }
    invalidateSource(floor,reason){
        const job=this.job;if(!job||['done','abandoned'].includes(job.status))return;
        if(reason==='deleted'||floor>=job.firstFloor&&floor<=job.lastFloor){
            job.sourceDirty=true;job.error='本任务引用的正文已编辑、切换版本或删除。草案仍保留，请重新创建任务核对来源。';
            this.stop();this.persist(job).catch(()=>{});this.changed();
        }
    }
    async verifySource(job){
        if(job.sourceDirty)throw Error(job.error||'任务正文已变化');
        if(!job.sourceSignature)return;
        const reader=new Host(job.scope.chatKey);await reader.sync();
        const messages=await reader.read(job.firstFloor,job.lastFloor+1);
        const raw=messages.map((message,index)=>({floor:job.firstFloor+index,role:message.is_user?'user':message.extra?.type==='narrator'?'system':'assistant',name:String(message.name??''),content:message.mes}));
        if(await sourceSignature(raw)!==job.sourceSignature)throw Error('本任务原文已变化，请重新创建任务；完整草案与快照仍保留。');
    }
    async preview(){
        if(this.running||this.saving)throw Error('当前任务正在运行');
        if(!this.job||['done','abandoned'].includes(this.job.status))await this.newJob();
        return this.captureFor(this.job);
    }
    async captureFor(job){
        if(job.sourceDirty)throw Error(job.error||'任务正文已变化');
        const scope=await this.api.targets.captureScope();
        if(scope.chatKey!==job.scope.chatKey)throw Error('聊天已切换，请回到本任务聊天后继续');
        const [catalog,history,defaultPreset]=await Promise.all([
            this.api.targets.listTargets(job.scope),this.api.captureHistory({...job.scope,scope:job.scope,firstFloor:job.firstFloor,lastFloor:job.lastFloor}),
            this.api.getDefaultPreset(),
        ]);
        const allowed=new Set(job.selectedTargetIds);
        // New entries created and accepted in this task become available to later batches.
        for(const batch of job.batches)if(batch.status==='saved')for(const item of batch.items||[])if(item.accepted!==false&&item.action==='create')allowed.add(item.target.id);
        const selected=catalog.targets.filter(t=>allowed.has(t.id));
        const missing=[...allowed].filter(id=>!selected.some(t=>t.id===id)&&!job.batches.some(b=>b.status==='saved'&&b.items?.some(i=>i.target.id===id&&i.action==='delete')));
        if(missing.length)throw Error('已选目标已移除或身份发生变化，请放下旧任务并重新选材：'+missing.join('、'));
        if(job.mode==='archive'&&history.available&&history.coverage?.complete===false)
            throw Error('历史总结与起始楼层之间存在缺口。请调整已归档楼层或补齐记忆总结后再试。'+(history.warnings||[]).join(' '));
        const sourceId=this.settings.sourceId,channel=this.settings.channels.find(c=>c.id===sourceId);
        if(sourceId!=='main'&&!channel)throw Error('请先配置工作台API');
        const capture=await this.api.captureWorkbenchContext({
            scope:job.scope,firstFloor:job.firstFloor,lastFloor:job.lastFloor,selectedTargets:selected,
            presetId:this.settings.presetId,sourceId,channel:channel?{...channel,...this.settings.generation}:undefined,
            generationSettings:clone(this.settings.generation),defaultPreset,
            duties:this.settings.duties.common+'\n\n'+this.settings.duties[job.mode],
            mode:job.mode,historyBlock:history.block?.content||history.text||'',
        });
        const signature=await sourceSignature(capture.rawMessages);
        if(job.sourceSignature&&job.sourceSignature!==signature)throw Error('本任务原文已变化，请放下旧任务并重新规划；已保存修改可从快照查看。');
        job.sourceSignature=signature;
        job.config={sourceId,presetId:this.settings.presetId};
        job.history={available:history.available,coverage:history.coverage,warnings:history.warnings,revision:history.revision};
        this.capture=capture;this.captureTargets=selected;this.captureCatalogTargets=catalog.targets;this.captureAllowed=allowed;
        this.targets=catalog.targets;this.worlds=catalog.worlds;this.targetsDirty=false;
        return capture;
    }
    async send(input='',options={}){
        if(this.starting||this.running||this.saving)throw Error('工作台已有任务正在处理');
        this.starting=true;this.changed('progress');
        try{return await this.sendInner(input,options);}finally{this.starting=false;this.changed('progress');}
    }
    async sendInner(input='',{execute=false,retry=false}={}){
        if(this.running||this.saving)throw Error('工作台已有任务正在处理');
        if(!this.job||['done','abandoned'].includes(this.job.status))await this.newJob();
        const job=this.job;
        if(job.batches.some(b=>b.status==='review'||b.status==='partial'))throw Error('先审核并保存当前批，再继续下一批');
        const hasSaved=job.batches.some(b=>b.status==='saved');
        const phase=job.mode==='archive'&&(!job.plan.length||!hasSaved&&!execute&&!retry)?'plan':'edit';
        if(phase==='edit'&&job.mode==='archive'&&!job.plan.length)throw Error('请先生成分批计划');
        const batch=job.batches.find(b=>b.status!=='saved');
        if(phase==='edit'&&!batch)throw Error('所有批次已处理');
        this.running=true;this.abort=new AbortController();this.liveText='';this.changed('progress');
        let text='';
        try{
            if(input.trim())job.messages.push({role:'user',content:input.trim()});
            await this.persist(job);
            await this.cancelPreviousRun(job);
            const capture=await this.captureFor(job);
            if(this.abort.signal.aborted)throw new DOMException('已停止','AbortError');
            job.status='running';job.error='';
            await this.persist(job);
            const prompt=taskInstructions(job,this.settings,phase,input);
            const conversation=job.messages.slice(0,-(input.trim()?1:0)||undefined).filter(m=>m.role==='user'||m.role==='assistant');
            const messages=[...conversation,{role:'user',content:prompt}];
            const result=await this.api.runWorkbench(capture,{
                messages,tools:phase==='plan'?[TOOLS.read,TOOLS.plan]:[TOOLS.read,TOOLS.propose],signal:this.abort.signal,
                onText:(delta,complete)=>{text=typeof complete==='string'?complete:text+String(delta||'');this.liveText=text;this.changed('text');},
                onTool:(name,args,execution)=>this.onTool(job,phase,name,args,execution),
                onRunStart:async info=>{
                    job.nativeRunId=info.runId;job.nativeTerminal=false;job.nativeCancelAcknowledged=false;job.nativeCancelError='';
                    await this.persist(job);
                },
                onCancel:info=>{
                    if(info.runId!==job.nativeRunId)return;
                    job.nativeCancelAcknowledged=!info.error;job.nativeCancellation={requestedAt:Date.now(),receipt:info.receipt};
                    job.nativeCancelError=info.error?.message||'';
                    this.persist(job).then(()=>this.changed()).catch(error=>{this.notice=error.message;this.changed('notice');});
                },
            });
            text=result.text||text;this.liveText=text;if(result.runId)job.nativeTerminal=true;
            if(text)job.messages.push({role:'assistant',content:text});
            if(job.batches.some(b=>b.status==='review'))job.status='review';
            else if(phase==='plan')job.status=job.plan.length?'planned':'discussion';
            else if(job.mode==='free'){job.status='done';}
            else{job.status='interrupted';job.error='本次没有完整改动草案，可继续讨论或重试当前批。';}
            job.finishReason=result.finishReason;
        }catch(error){
            // Never parse or execute a truncated fragment. Complete tool calls were saved as they arrived.
            job.status=job.batches.some(b=>b.status==='review')?'review':'interrupted';
            job.error=error.name==='AbortError'?(error.cancellation?'已发出取消请求，完整草案已保留。':'已停止本次请求，完整草案已保留。'):error.message||String(error);
            if(text)job.messages.push({role:'assistant',content:text,incomplete:true});
        }finally{
            this.running=false;this.abort=null;this.capture=null;this.captureTargets=[];this.captureAllowed=null;
            try{await this.persist(job);}finally{this.changed();}
        }
    }
    async onTool(job,phase,name,args,execution={}){
        if(execution.signal?.aborted)throw new DOMException('已停止','AbortError');
        if(this.job?.id!==job.id)throw Error('任务已变化');
        if(typeof args==='string'){try{args=JSON.parse(args);}catch{throw Error('工具参数未完整返回');}}
        if(!args||typeof args!=='object')throw Error('工具参数无效');
        if(name==='read_settings'){
            if(!Array.isArray(args.ids)||args.ids.length>60)throw Error('一次最多读取60个已选目标');
            return args.ids.map(id=>{
                const target=this.captureTargets.find(t=>t.id===id);
                if(!target||!this.captureAllowed.has(id))throw Error('目标未选中：'+id);
                return {id,title:target.title,content:target.content,metadata:target.metadata};
            });
        }
        if(name==='plan_archive'){
            if(phase!=='plan')throw Error('执行当前批时不能重置计划');
            const plan=validatePlan(args);
            if(job.batches.some(b=>b.status==='saved'))throw Error('已保存的任务不能重置计划');
            job.plan=plan;job.batches=plan.map((b,i)=>({...b,index:i,status:'pending',items:[],report:emptyReport()}));
            job.planExplanation=String(args.explanation||'');await this.persist(job);this.changed();
            return {status:'planned',batches:plan.length,next:'等待用户讨论或开始第一批'};
        }
        if(name!=='propose_changes'||phase!=='edit')throw Error('当前阶段不允许此工具');
        if(!Array.isArray(args.operations)||!args.operations.length||args.operations.length>60)throw Error('每次需要1–60项操作');
        const batch=job.batches.find(b=>b.status!=='saved');
        if(!batch)throw Error('本次任务没有待处理批次');
        const items=await this.api.targets.prepareOperations(args.operations,{scope:job.scope,targets:this.captureTargets});
        for(const item of items){
            item.id=makeId('change');
            if(item.action==='create')item.target.id='world:'+encodeURIComponent(item.target.world)+':new:'+makeId('entry');
            if(item.action!=='create'&&!this.captureAllowed.has(item.target.id))throw Error('编辑目标未选中：'+item.target.id);
            if(batch.items.some(i=>i.target.id===item.target.id))throw Error('本批已提交该目标，请一次工具调用包含对同一目标的全部修改');
        }
        if(execution.signal?.aborted)throw new DOMException('已停止','AbortError');
        if(job.mode==='archive')validateArchiveEdits([...batch.items,...items],this.captureCatalogTargets||this.captureTargets,{style:this.settings.validateArchiveStyle!==false});
        batch.items.push(...items);batch.status='review';batch.explanation=String(args.explanation||'');
        const report=normalizeReport(args.report);
        if(job.mode==='archive')for(const item of items)if(item.action==='delete'&&item.target.kind==='world'&&!report.closed.some(r=>r.id===item.target.id))
            report.closed.push({id:item.target.id,title:item.before?.metadata?.comment||item.title});
        for(const key of ['cleared','retained','closed'])batch.report[key].push(...report[key]);
        job.status='review';await this.persist(job);this.changed('proposal');
        return {status:'pending_review',items:items.map(i=>({id:i.id,target:i.target.id,title:i.title})),next:'草案已持久化，用户稍后逐项审核；现在结束当前批，不继续下一批。'};
    }
    currentBatch(){return this.job?.batches.find(b=>b.status!=='saved');}
    applyOutcomes(batch,outcomes){
        batch.outcomes=outcomes;
        const remap=new Map();
        for(const item of batch.items){
            const outcome=outcomes.find(o=>o.itemId===item.id||o.id===item.id);
            if(outcome?.target?.id&&outcome.target.id!==item.target.id){
                remap.set(item.target.id,outcome.target.id);item.target=clone(outcome.target);
            }
            // A lost receipt may prove that an item the user tried to skip has
            // already reached the host. Reflect that fact; rollback is separate.
            if(outcome?.status==='applied')item.accepted=true;
            else if(outcome?.decision==='skip')item.accepted=false;
        }
        for(const row of [...(batch.report?.cleared||[]),...(batch.report?.retained||[])])row.into=row.into.map(id=>remap.get(id)||id);
        for(const row of batch.report?.closed||[])row.id=remap.get(row.id)||row.id;
    }
    async prepareReview(){
        if(this.running||this.starting||this.saving)throw Error('请等待本批生成或保存完成后再审核');
        const job=this.job,batch=this.currentBatch();if(!batch)throw Error('当前没有审核批次');
        if(!this.api.storage.getBatchOutcomes)return;
        const outcomes=await this.api.storage.getBatchOutcomes({jobId:job.id,batchId:job.id+':'+batch.id,scope:job.scope,items:batch.items});
        if(this.job!==job||this.currentBatch()!==batch||this.running||this.starting||this.saving)throw Error('审核草案已变化，请重新打开');
        if(outcomes.length){this.applyOutcomes(batch,outcomes);await this.persist(job);}
    }
    async saveDraft(items,index,expected={}){
        if(this.running||this.starting||this.saving)throw Error('请等待本批生成或保存完成后再审核');
        const batch=this.currentBatch();if(!batch)throw Error('当前没有审核批次');
        if(expected.jobId&&expected.jobId!==this.job.id||expected.batchId&&expected.batchId!==batch.id)throw Error('审核窗口已过期，请重新打开当前批次');
        if(items.length!==batch.items.length||items.some((item,i)=>item.id!==batch.items[i].id))throw Error('审核草案已有新版本，请重新打开审核');
        batch.items=clone(items);batch.reviewIndex=index;await this.persist();
    }
    async saveReviewed(items,expected={}){
        if(this.running||this.starting||this.saving)throw Error('请等待生成结束再保存');
        const job=this.job,batch=this.currentBatch();if(!job||!batch)throw Error('没有待保存批次');
        if(expected.jobId&&expected.jobId!==job.id||expected.batchId&&expected.batchId!==batch.id||items.length!==batch.items.length||items.some((item,i)=>item.id!==batch.items[i].id))throw Error('审核窗口已过期，请重新打开当前批次');
        this.saving=true;this.changed('progress');
        try{
            await this.verifySource(job);
            const scope=await this.api.targets.captureScope();
            if(scope.chatKey!==job.scope.chatKey)throw Error('请回到本任务对应聊天后保存');
            if(job.mode==='archive'&&items.some(i=>i.accepted!==false&&i.target.kind==='world')){
                const catalog=await this.api.targets.listTargets(job.scope);
                validateArchiveEdits(items,catalog.targets,{style:false});
            }
            batch.items=clone(items);await this.persist(job);
            const result=await this.api.storage.saveBatch({jobId:job.id,batchId:job.id+':'+batch.id,scope:job.scope,items:batch.items,restores:batch.restores});
            // Creation UIDs are assigned by the write journal, not the model.
            // Replace temporary refs everywhere before continuing another batch.
            this.applyOutcomes(batch,result.outcomes);
            let selectionChanged=false;
            for(const item of batch.items){
                const outcome=result.outcomes.find(o=>o.itemId===item.id||o.id===item.id);
                if(outcome?.status!=='applied')continue;
                if(item.action==='create'){this.selected.add(item.target.id);selectionChanged=true;}
                else if(item.action==='delete'){this.selected.delete(item.target.id);selectionChanged=true;}
            }
            this.targetsDirty=true;
            if(selectionChanged)await this.saveState({selectedTargetIds:[...this.selected]});
            if(result.complete){
                batch.status='saved';batch.savedAt=Date.now();
                const previous=job.batches.filter(b=>b!==batch&&b.status==='saved').flatMap(b=>(b.items||[]).filter(i=>b.outcomes?.some(o=>(o.itemId===i.id||o.id===i.id)&&o.status==='applied')).map(i=>i.target.id));
                batch.savedReport=reconcileReport(batch.report,batch.items,result.outcomes,previous);
                job.report=aggregateReport(job.batches,job.carry);
                job.status=job.batches.every(b=>b.status==='saved')?'saved':'ready';
                await this.persist(job);
                if(job.status==='saved')await this.finishJob(job);
            }else{
                batch.status='partial';job.status='review';
                job.error='部分修改未写入，请查看冲突或错误。已成功的项不会重复写入。';await this.persist(job);
            }
            return result;
        }finally{this.saving=false;this.changed();}
    }
    async finishJob(job=this.job){
        if(job?.sourceDirty)throw Error(job.error||'任务正文已变化，请核对后再设置归档楼层');
        if(!job||!job.batches.length||!job.batches.every(b=>b.status==='saved'))throw Error('还有未处理批次');
        if(job.mode==='archive'){
            const current=await this.api.storage.getSettings(job.scope);
            if((current.archivedFloor||0)===job.cursorBase){
                const progress={archivedFloor:job.lastFloor,remindedAt:job.lastFloor,retained:job.report.retained,throughFloor:null};
                await this.api.storage.saveSettings(job.scope,progress);
                updateReminderState(job.scope.chatKey,progress);
                if(this.scope.chatKey===job.scope.chatKey)Object.assign(this.state,progress);
            }else if(current.archivedFloor!==job.lastFloor){
                job.cursorConflict=true;job.error='归档期间手动调整过归档楼层，保留手动值。请核对后自行设置。';
            }
            const titles=Object.fromEntries((this.targets||[]).map(t=>[t.id,t.metadata?.comment||t.title]));
            for(const batch of job.batches)for(const item of batch.items||[])titles[item.target.id]=item.after?.metadata?.comment||item.title;
            job.finalReport=reportMarkdown(job.report,titles);
        }
        // Completed tasks keep routing/report metadata; full old/new versions
        // live exclusively in the expiring snapshot store, not permanent job copies.
        for(const batch of job.batches)batch.items=(batch.items||[]).map(item=>({
            id:item.id,target:clone(item.target),title:item.title,action:item.action,accepted:item.accepted,
        }));
        job.status='done';job.completedAt=Date.now();await this.persist(job);
    }
    async refreshTargets(){
        if(!this.targetsDirty)return;
        const catalog=await this.api.targets.listTargets(this.scope);
        this.targets=catalog.targets;this.worlds=catalog.worlds;this.targetsDirty=false;
    }
    async stageRestore(snapshot){
        if(this.running||this.saving)throw Error('请先完成当前操作');
        if(this.job&&!['done','abandoned'].includes(this.job.status))throw Error('请先放下当前任务，再创建回退草案');
        if(snapshot.scopeKey!==this.scope.chatKey)throw Error('快照不属于当前聊天');
        const before=await this.api.targets.readTarget(snapshot.target,this.scope);
        const item={id:makeId('restore'),target:clone(snapshot.target),title:'回退 · '+snapshot.title,
            action:snapshot.before===null?'delete':before===null?'create':'replace',before:clone(before),after:clone(snapshot.before),accepted:true};
        const now=Date.now();this.job={id:makeId('job'),schemaVersion:1,scope:clone(this.scope),mode:'free',status:'review',createdAt:now,updatedAt:now,
            firstFloor:0,lastFloor:this.lastFloor,cursorBase:this.state.archivedFloor||0,selectedTargetIds:[item.target.id],config:{},plan:[],messages:[],report:emptyReport(),
            batches:[{id:'batch-1',index:0,title:'回退快照',status:'review',items:[item],report:emptyReport(),restores:snapshot.id}]};
        await this.persist();this.changed();
    }

}
