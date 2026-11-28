import * as storage from './store.js';
import * as targets from './targets.js';
import { captureWorkbenchContext, latestFloor } from './context.js';
import { listPresets } from './tt.js';
import { Host } from '../host.js';
import { updateReminderState } from './reminders.js';
import { runWorkbench, cancelWorkbenchRun, readWorkbenchRunLog } from './llm.js';
import { captureHistory, getDefaultPreset } from './memory.js';
import { clone, makeId, settingsWithDefaults, validateSettings, materialSelection, worldFromTargetId, rangeFor, interruptedArchiveSetup, nextReminder, archivePhase, workbenchDuties, validatePlan, normalizeReport, reconcileSavedReports, reportMarkdown, taskInstructions, TOOLS } from './model.js';
import { failureSummary } from './failures.js';

const emptyReport=()=>({cleared:[],retained:[],closed:[]});
const REPORT_VERSION=2;
function updateSavedReports(job){
    job.report=reconcileSavedReports(job.batches,job.carry);
    job.reportVersion=REPORT_VERSION;
}
function needsReportUpgrade(job){
    return job?.mode==='archive'&&job.status!=='done'&&(job.reportVersion??1)<REPORT_VERSION
        &&job.batches.some(batch=>batch.status==='saved');
}
async function sourceSignature(messages){
    if(!globalThis.crypto?.subtle)throw Error('工作台需要安全的正文版本校验能力');
    const bytes=new TextEncoder().encode(JSON.stringify(messages));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export class WorkbenchController {
    constructor(deps={}) {
        this.api={storage,targets,captureWorkbenchContext,latestFloor,listPresets,runWorkbench,cancelWorkbenchRun,readWorkbenchRunLog,captureHistory,getDefaultPreset,...deps};
        this.listeners=new Set();this.persistChain=Promise.resolve();this.generation=0;this.running=false;this.saving=false;this.liveText='';this.liveReasoning='';this.liveStatus='';
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
            const pending=jobs.find(j=>!['done','abandoned'].includes(j.status)&&j.mode===(state.mode||'archive'));
            pendingJob=pending?await this.api.storage.getJob(pending.id):null;
        }
        if(generation!==this.generation)return;
        if(this.running&&this.scope?.chatKey!==scope.chatKey)throw Error('另一聊天的工作台仍在生成。可先停止该任务，再切换工作台。');
        Object.assign(this,{scope,settings:settingsWithDefaults(global),state:{mode:'archive',archivedFloor:0,remindedAt:0,...state},targets:catalog.targets,worlds:catalog.worlds,lastFloor:last,jobs,presets});
        Object.assign(this,materialSelection(this.targets,this.state,this.scope.worldNames));
        this.job=pendingJob;
        if(this.job)this.restrictJobMaterials(this.job);
        const repair=needsReportUpgrade(this.job);
        if(repair)updateSavedReports(this.job);
        // A run cannot survive a frontend restart; only complete staged calls are recoverable.
        if(this.job?.status==='running'&&!this.running){
            try{await this.cancelPreviousRun(this.job);}catch(error){this.job.nativeCancelError=error.message;}
            this.job.status=this.job.batches?.some(b=>b.status==='review')?'review':'interrupted';
            this.job.error='上次生成中断，已完成的草案保留。可审核或重试当前批。';await this.persist();
        }else if(repair)await this.persist();
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
        const nextState={...this.state,...patch},job=this.job;
        const changesRange=['mode','firstFloor','throughFloor','archivedFloor'].some(key=>key in patch);
        const draftChanged=job?.status==='draft'&&(changesRange||'selectedTargetIds' in patch||'enabledWorlds' in patch);
        const retrySetup=('archivedFloor' in patch||'selectedTargetIds' in patch||'enabledWorlds' in patch)&&interruptedArchiveSetup(job);
        // Reject invalid ranges before either persistent or in-memory state changes.
        const nextRange=changesRange||draftChanged?rangeFor(nextState.mode,nextState,this.lastFloor):null;
        if(retrySetup&&'archivedFloor' in patch)rangeFor('archive',{...nextState,throughFloor:job.lastFloor},this.lastFloor);
        await this.api.storage.saveSettings(scope,patch);
        updateReminderState(scope.chatKey,patch);
        if(this.scope?.chatKey===scope.chatKey){
            Object.assign(this.state,patch);
            if('selectedTargetIds' in patch||'enabledWorlds' in patch)
                Object.assign(this,materialSelection(this.targets,this.state,this.scope.worldNames));
            const sameIdleJob=this.job===job&&!this.running&&!this.starting;
            if(draftChanged&&sameIdleJob&&job.status==='draft'){
                Object.assign(this.job,nextRange,{mode:this.state.mode,cursorBase:this.state.archivedFloor||0,manualArchive:this.state.manualArchive===true});
                if(patch.selectedTargetIds)this.job.selectedTargetIds=[...patch.selectedTargetIds];
                if(patch.enabledWorlds)this.job.enabledWorlds=[...patch.enabledWorlds];
                this.restrictJobMaterials(this.job);
                this.job.plan=[];this.job.batches=this.state.mode==='free'?[{id:'batch-1',index:0,title:'自由编辑',instructions:'',status:'pending',items:[],report:emptyReport()}]:[];
                delete this.job.sourceSignature;delete this.job.history;this.capture=null;await this.persist();
            }else if(retrySetup&&sameIdleJob&&interruptedArchiveSetup(job)){
                // Keep the user's request and fixed cutoff when retrying before the first assistant reply.
                if('archivedFloor' in patch){
                    if(job.firstFloor!==patch.archivedFloor)delete job.sourceSignature;
                    Object.assign(job,{firstFloor:patch.archivedFloor,cursorBase:patch.archivedFloor,manualArchive:patch.manualArchive===true,error:''});
                }
                if(patch.selectedTargetIds)job.selectedTargetIds=[...patch.selectedTargetIds];
                if(patch.enabledWorlds)job.enabledWorlds=[...patch.enabledWorlds];
                this.restrictJobMaterials(job);
                delete job.history;this.capture=null;
                await this.persist(job);
            }
            this.changed('state');
        }
    }
    async select(ids,enabledWorlds){
        const selection=materialSelection(this.targets,{selectedTargetIds:[...ids],
            ...(enabledWorlds?{enabledWorlds:[...enabledWorlds]}:{})},this.scope.worldNames);
        await this.saveState({selectedTargetIds:[...selection.selected],enabledWorlds:[...selection.enabledWorlds],materialSelectionVersion:1});
        Object.assign(this,selection);
    }
    restrictJobMaterials(job){
        // Old tasks did not store book permissions. Infer only books of their
        // explicit selected IDs, never the former all-bound-books scope.
        const byId=new Map((this.targets||[]).map(t=>[t.id,t]));
        const inferred=(job.selectedTargetIds||[]).map(id=>byId.get(id)?.world||worldFromTargetId(id)).filter(Boolean);
        const available=this.scope?.worldNames||job.scope?.worldNames||[];
        job.enabledWorlds=[...new Set((job.enabledWorlds||inferred).filter(name=>available.includes(name)))];
        job.scope=targets.materialScope({...job.scope,worldNames:available},job.enabledWorlds);
        job.selectedTargetIds=(job.selectedTargetIds||[]).filter(id=>{
            const world=byId.get(id)?.world||worldFromTargetId(id);return !world||job.enabledWorlds.includes(world);
        });
        job.materialSelectionVersion=1;
    }
    async switchMode(mode){
        if(!['archive','free'].includes(mode))throw Error('工作台模式无效');
        if(this.running||this.starting||this.saving)throw Error('请先停止生成或等待保存完成，再切换模式');
        if((this.job?.mode||this.state.mode)===mode)return;
        if(this.job&&this.job.status!=='draft'){
            await this.persist();this.job=null;this.capture=null;
            this.notice='已切换模式，原任务保留在「任务记录」中。';this.changed('notice');
        }
        await this.saveState({mode});
    }
    async setArchivedFloor(floor,manualArchive=this.state.manualArchive===true){
        if(!Number.isInteger(floor)||floor<0||floor>this.lastFloor)throw Error('请输入0到最新楼层之间的整数');
        if(this.saving)throw Error('正在保存，请稍后再修改归档楼层');
        await this.saveState({archivedFloor:floor,remindedAt:floor,manualArchive});
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
        const job={id:makeId('job'),schemaVersion:2,scope:clone(this.scope),mode:this.state.mode,status:'draft',
            createdAt:Date.now(),updatedAt:Date.now(),...range,cursorBase:this.state.archivedFloor||0,manualArchive:this.state.manualArchive===true,
            selectedTargetIds:[...this.selected],...(this.enabledWorlds?{enabledWorlds:[...this.enabledWorlds]}:{}),config:{sourceId:this.settings.sourceId,presetId:this.settings.presetId},
            carry:clone(this.state.retained||[]),plan:[],batches:[],messages:[],report:emptyReport()};
        if(job.mode==='free')job.batches.push({id:'batch-1',index:0,title:'自由编辑',instructions:'',status:'pending',items:[],report:emptyReport()});
        this.restrictJobMaterials(job);
        this.job=job;await this.persist();this.changed();return job;
    }
    async resume(id){
        if(this.running||this.saving)throw Error('请等待当前操作完成');
        const job=await this.api.storage.getJob(id);
        if(!job||job.scope.chatKey!==this.scope.chatKey)throw Error('任务不属于当前聊天');
        if(job.completedAt!=null&&job.finalReport)job.status='done';
        else if(['running','abandoned'].includes(job.status)){
            job.status=job.batches?.some(b=>['review','partial'].includes(b.status))?'review':['discuss','negotiate'].includes(job.requestPhase)&&!job.plan.length?'discussion':job.plan?.length?(job.batches.some(b=>b.status==='saved')?'ready':'planned'):'draft';
        }
        this.restrictJobMaterials(job);
        if(needsReportUpgrade(job))updateSavedReports(job);
        await this.api.storage.saveSettings(this.scope,{mode:job.mode});this.state.mode=job.mode;
        this.job=job;this.capture=null;this.liveText='';this.liveReasoning='';this.liveStatus='';
        if(job.status!=='done')await this.persist();
        this.changed();
    }
    async abandon(){
        if(this.running||this.saving)throw Error('请先停止生成或等待保存完成');
        if(this.job&&this.job.status!=='done'){this.job.status='abandoned';await this.persist();}
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
    async captureFor(job,phase){
        if(job.sourceDirty)throw Error(job.error||'任务正文已变化');
        const {firstFloor,lastFloor,mode,manualArchive}=job;
        const sourceId=this.settings.sourceId,channel=this.settings.channels.find(c=>c.id===sourceId);
        if(sourceId!=='main'&&!channel)throw Error('请先配置工作台API');
        const connection={sourceId,presetId:this.settings.presetId,generationSettings:clone(this.settings.generation),cleanTags:clone(this.settings.cleanTags),
            channel:channel?{...channel,...this.settings.generation}:undefined};
        if(phase==='plan'){
            // Registration transcribes the approved conversation. Execution will verify all sources again.
            const capture=await this.api.captureWorkbenchContext({...connection,scope:job.scope,firstFloor,lastFloor,mode,
                discussionOnly:true,defaultPreset:await this.api.getDefaultPreset(),duties:'只登记用户已同意的最新分批方案。'});
            if(job!==this.job||job.sourceDirty)throw Error('任务材料已改变，请重新核对方案。');
            job.config={sourceId,presetId:connection.presetId,cleanTags:connection.cleanTags};
            return capture;
        }
        this.restrictJobMaterials(job);
        const {selectedTargetIds}=job;
        const scope=await this.api.targets.captureScope();
        if(scope.chatKey!==job.scope.chatKey)throw Error('聊天已切换，请回到本任务聊天后继续');
        const [catalog,history,defaultPreset]=await Promise.all([
            this.api.targets.listTargets(job.scope),this.api.captureHistory({scope,firstFloor,lastFloor}),
            this.api.getDefaultPreset(),
        ]);
        const allowed=new Set(selectedTargetIds);
        // New entries created and accepted in this task become available to later batches.
        for(const batch of job.batches)if(batch.status==='saved')for(const item of batch.items||[])if(item.accepted!==false&&item.action==='create')allowed.add(item.target.id);
        const selected=catalog.targets.filter(t=>allowed.has(t.id));
        const missing=[...allowed].filter(id=>!selected.some(t=>t.id===id)&&!job.batches.some(b=>b.status==='saved'&&b.items?.some(i=>i.target.id===id&&i.action==='delete')));
        if(missing.length)throw Error('已选目标已移除或身份发生变化，请放下旧任务并重新选材：'+missing.join('、'));
        if(mode==='archive'&&!manualArchive&&history.available&&history.coverage?.complete===false)
            throw Error('历史总结与起始楼层之间存在缺口。此前已手动归档，可点「已归档」数字，勾选「从手动归档处接续」。'+(history.warnings||[]).join(' '));
        const capture=await this.api.captureWorkbenchContext({
            ...connection,scope:job.scope,firstFloor,lastFloor,selectedTargets:selected,enabledWorlds:job.enabledWorlds,
            defaultPreset,duties:workbenchDuties(this.settings,mode,phase),
            mode,historyBlock:history.block?.content||history.text||'',
        });
        const signature=await sourceSignature(capture.rawMessages);
        if(job!==this.job||firstFloor!==job.firstFloor||lastFloor!==job.lastFloor||mode!==job.mode
            ||manualArchive!==job.manualArchive||selectedTargetIds!==job.selectedTargetIds)
            throw Error('任务材料已调整，请按当前设置重试。');
        if(job.sourceSignature&&job.sourceSignature!==signature)throw Error('本任务原文已变化，请放下旧任务并重新规划；已保存修改可从快照查看。');
        job.sourceSignature=signature;
        job.config={sourceId,presetId:connection.presetId,cleanTags:connection.cleanTags};
        job.history={available:history.available,warnings:history.warnings,revision:history.revision,
            coverage:mode==='archive'&&manualArchive?{complete:history.coverage.complete}:history.coverage};
        this.capture=capture;this.captureTargets=selected;this.captureAllowed=allowed;
        // The run reads only enabled books; keep the full chooser catalog until
        // the next explicit material refresh so disabled books remain visible.
        this.targetsDirty=true;
        return capture;
    }
    async send(input='',options={}){
        if(this.starting||this.running||this.saving)throw Error('工作台已有任务正在处理');
        this.starting=true;this.changed('progress');
        try{return await this.sendInner(input,options);}finally{this.starting=false;this.changed('progress');}
    }
    async sendInner(input='',options={}){
        if(this.running||this.saving)throw Error('工作台已有任务正在处理');
        if(!this.job||['done','abandoned'].includes(this.job.status))await this.newJob();
        const job=this.job;
        if(job.mode==='archive'&&job.status==='draft'&&!job.messages.length&&job.cursorBase===(this.state.archivedFloor||0)){
            job.carry=clone(this.state.retained||[]);
        }
        const previousFailure=job.failure;
        // Failed generation can be discussed/retried manually while retaining its drafts.
        // A partial host write must still be recovered through the original review journal.
        if(job.batches.some(b=>b.status==='partial'||b.status==='review'&&previousFailure?.kind!=='tool'))throw Error('先审核并保存当前批，再继续下一批');
        const hasSaved=job.batches.some(b=>b.status==='saved');
        const phase=archivePhase(job,input,options);
        const revision=job.planRevision||0;
        const batch=job.batches.find(b=>b.status!=='saved');
        if(phase==='edit'&&!batch)throw Error('所有批次已处理');
        this.running=true;this.abort=new AbortController();this.liveText='';this.liveReasoning='';this.liveStatus='正在准备本次材料';this.changed('progress');
        let text='',reasoning='',proposals=0;
        try{
            job.requestPhase=phase;
            if(input.trim())job.messages.push({role:'user',content:input.trim()});
            await this.persist(job);
            await this.cancelPreviousRun(job);
            if(phase==='discuss'){delete job.nativeRunId;delete job.nativeCancellation;}
            const capture=await this.captureFor(job,phase);
            if(this.abort.signal.aborted)throw new DOMException('已停止','AbortError');
            job.status='running';job.error='';
            await this.persist(job);
            const prompt=taskInstructions(job,this.settings,phase,input);
            const conversation=job.messages.slice(0,-(input.trim()?1:0)||undefined)
                .filter(m=>(m.role==='user'||m.role==='assistant')&&m.kind!=='plan'&&!m.incomplete&&m.content)
                .map(({role,content})=>({role,content}));
            const messages=[...conversation,{role:'user',content:prompt}];
            const tools={discuss:[],plan:[TOOLS.plan],negotiate:[TOOLS.read,TOOLS.plan],
                batchChat:[TOOLS.read,TOOLS.plan],edit:[TOOLS.read,TOOLS.propose]}[phase];
            const result=await this.api.runWorkbench(capture,{
                messages,tools,plainReply:phase==='discuss',signal:this.abort.signal,
                onText:(delta,complete)=>{text=typeof complete==='string'?complete:text+String(delta||'');this.liveText=text;this.changed('text');},
                onReasoning:(delta,complete)=>{reasoning=typeof complete==='string'?complete:reasoning+String(delta||'');this.liveReasoning=reasoning;this.changed('text');},
                onStatus:stage=>{this.liveStatus=String(stage||'');this.changed('status');},
                onTool:async(name,args,execution)=>{
                    if(name==='plan_archive'&&job.planRevision>revision)throw Error('本轮已登记分批方案');
                    const value=await this.onTool(job,phase,name,args,execution);
                    if(name==='propose_changes')proposals++;
                    return value;
                },
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
            text=result.text||text;reasoning=result.reasoning||reasoning;this.liveText=text;this.liveReasoning=reasoning;if(result.runId)job.nativeTerminal=true;
            if(text||reasoning)job.messages.push({role:'assistant',content:text,...(reasoning?{reasoning}:{} )});
            if(previousFailure?.kind==='tool'&&previousFailure.phase==='edit'&&(phase!=='edit'||!proposals)){
                job.status='interrupted';job.error=failureSummary(previousFailure);
            }
            else if(job.batches.some(b=>b.status==='review'))job.status='review';
            else if(phase!=='edit'){
                if(job.plan.length)job.status=hasSaved?'ready':'planned';
                else if(text.trim())job.status='discussion';
                else throw Error(phase==='plan'?'未收到分批登记结果，可重试登记。':'未收到完整规划回复，可重试本轮讨论。');
            }
            else if(job.mode==='free'){job.status='discussion';}
            else{job.status='interrupted';job.error='本次没有完整改动草案，可继续讨论或重试当前批。';}
            if(job.status!=='interrupted')delete job.failure;
            job.finishReason=result.finishReason;
        }catch(error){
            // Never parse or execute a truncated fragment. Complete tool calls were saved as they arrived.
            if(typeof error.partial?.text==='string')text=error.partial.text||text;
            if(typeof error.partial?.reasoning==='string')reasoning=error.partial.reasoning||reasoning;
            this.liveText=text;this.liveReasoning=reasoning;
            job.status=error.failure?.kind==='tool'||previousFailure?.kind==='tool'?'interrupted':job.batches.some(b=>b.status==='review')?'review':job.planRevision>revision?(hasSaved?'ready':'planned'):'interrupted';
            job.error=error.name==='AbortError'?(error.cancellation?'已发出取消请求，完整草案已保留。':'已停止本次请求，完整草案已保留。'):error.message||String(error);
            if(text||reasoning)job.messages.push({role:'assistant',content:text,...(reasoning?{reasoning}:{}),incomplete:true});
            if(error.failure){
                const failure={...clone(error.failure),phase,createdAt:Date.now()};
                job.failure=previousFailure?.kind==='tool'&&failure.kind!=='tool'?previousFailure:failure;
                job.messages.push({role:'assistant',kind:'failure',failure,incomplete:true,content:''});
            }
        }finally{
            this.running=false;this.abort=null;this.capture=null;this.captureTargets=[];this.captureAllowed=null;this.liveStatus='';
            try{await this.persist(job);}finally{this.changed();}
        }
    }
    async onTool(job,phase,name,args,execution={}){
        if(execution.signal?.aborted)throw new DOMException('已停止','AbortError');
        if(this.job?.id!==job.id)throw Error('任务已变化');
        if(typeof args==='string'){try{args=JSON.parse(args);}catch{throw Error('工具参数未完整返回');}}
        if(!args||typeof args!=='object')throw Error('工具参数无效');
        if(name==='read_settings'){
            if(phase==='plan'||phase==='discuss')throw Error('本轮不提供读取工具');
            if(!Array.isArray(args.ids)||args.ids.length>60)throw Error('一次最多读取60个已选目标');
            return args.ids.map(id=>{
                const target=this.captureTargets.find(t=>t.id===id);
                if(!target||!this.captureAllowed.has(id))throw Error('目标未选中：'+id);
                return {id,title:target.title,content:target.content,metadata:target.metadata};
            });
        }
        if(name==='plan_archive'){
            if(!['plan','negotiate','batchChat'].includes(phase))throw Error('用户采用方案后才能登记分批计划');
            const saved=job.batches.filter(b=>b.status==='saved');
            if(saved.length&&phase!=='batchChat')throw Error('已保存的批次不能重置');
            if(job.batches.some(b=>!['pending','saved'].includes(b.status)))throw Error('请先完成当前批次审核');
            const pending=validatePlan(args).map((b,i)=>({...b,id:'batch-'+(saved.length+i+1)}));
            if(saved.length+pending.length>30)throw Error('计划最多30个批次');
            const prior={plan:job.plan,batches:job.batches,status:job.status,planExplanation:job.planExplanation,
                planRevision:job.planRevision,messages:job.messages};
            job.plan=[...job.plan.slice(0,saved.length),...pending];
            job.batches=[...saved,...pending.map((b,i)=>({...b,index:saved.length+i,status:'pending',items:[],report:emptyReport()}))];
            job.status=saved.length?'ready':'planned';
            job.planExplanation=String(args.explanation??job.planExplanation??'');job.planRevision=(job.planRevision||0)+1;
            job.messages=job.messages.filter(m=>m.kind!=='plan');
            job.messages.push({role:'assistant',kind:'plan',revision:job.planRevision,content:''});
            try{await this.persist(job);}catch(error){Object.assign(job,prior);throw error;}
            this.changed();
            return {status:job.status,batches:job.plan.length,next:'方案已登记，可继续提要求或开始待处理批次。'};
        }
        if(name!=='propose_changes'||phase!=='edit')throw Error('当前阶段不允许此工具');
        if(!Array.isArray(args.operations)||!args.operations.length)throw Error('每次需要至少一项操作');
        const batch=job.batches.find(b=>b.status!=='saved');
        if(!batch)throw Error('本次任务没有待处理批次');
        const items=await this.api.targets.prepareOperations(args.operations,{scope:job.scope,targets:this.captureTargets,allowedIds:this.captureAllowed});
        for(const item of items){
            item.id=makeId('change');
            if(item.action==='create')item.target.id='world:'+encodeURIComponent(item.target.world)+':new:'+makeId('entry');
            if(item.action!=='create'&&!this.captureAllowed.has(item.target.id))throw Error('编辑目标未选中：'+item.target.id);
            if(batch.items.some(i=>i.target.id===item.target.id))throw Error('本批已提交该目标，请一次工具调用包含对同一目标的全部修改');
        }
        if(execution.signal?.aborted)throw new DOMException('已停止','AbortError');
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
        const remap=new Map(),byItem=new Map(outcomes.map(outcome=>[outcome.itemId||outcome.id,outcome]));
        for(const item of batch.items){
            const outcome=byItem.get(item.id);
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
        return byItem;
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
            // Persist the final edits once, even if source checks or a host write fail.
            batch.items=clone(items);batch.reviewIndex=items.length-1;await this.persist(job);
            await this.verifySource(job);
            const scope=await this.api.targets.captureScope();
            if(scope.chatKey!==job.scope.chatKey)throw Error('请回到本任务对应聊天后保存');
            const result=await this.api.storage.saveBatch({jobId:job.id,batchId:job.id+':'+batch.id,scope:job.scope,items:batch.items,restores:batch.restores});
            // Creation UIDs are assigned by the write journal, not the model.
            // Replace temporary refs everywhere before continuing another batch.
            const byItem=this.applyOutcomes(batch,result.outcomes);
            let selectionChanged=false;
            for(const item of batch.items){
                const outcome=byItem.get(item.id);
                if(outcome?.status!=='applied')continue;
                if(item.action==='create'){
                    this.selected.add(item.target.id);selectionChanged=true;
                    // The chooser cache predates this host-assigned UID. Update
                    // it from the confirmed receipt before normalizing selection.
                    const target={...clone(item.target),title:item.title,...clone(item.after)},index=this.targets.findIndex(t=>t.id===item.target.id);
                    if(index>=0)this.targets[index]=target;else this.targets.push(target);
                }else if(item.action==='delete'){
                    this.selected.delete(item.target.id);selectionChanged=true;
                    const index=this.targets.findIndex(t=>t.id===item.target.id);if(index>=0)this.targets.splice(index,1);
                }
            }
            this.targetsDirty=true;
            if(selectionChanged)await this.saveState({selectedTargetIds:[...this.selected]});
            if(result.complete){
                delete job.failure;job.error='';
                batch.status='saved';batch.savedAt=Date.now();
                updateSavedReports(job);
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
        if(job.status==='done')return;
        if(job.mode==='archive'){
            // Also covers resuming an older task interrupted between the last write and finalization.
            if(needsReportUpgrade(job))updateSavedReports(job);
            const current=await this.api.storage.getSettings(job.scope);
            if((current.archivedFloor||0)===job.cursorBase){
                const progress={archivedFloor:job.lastFloor,remindedAt:job.lastFloor,retained:job.report.retained,retainedJobId:job.id,throughFloor:null};
                await this.api.storage.saveSettings(job.scope,progress);
                updateReminderState(job.scope.chatKey,progress);
                if(this.scope.chatKey===job.scope.chatKey)Object.assign(this.state,progress);
            }else if(current.archivedFloor!==job.lastFloor){
                job.cursorConflict=true;job.error='归档期间手动调整过归档楼层，保留手动值。请核对后自行设置。';
            }
            job.finalReport=reportMarkdown(job.report,this.reportTitles(job));
        }
        // Completed tasks keep routing/report metadata; full old/new versions
        // live exclusively in the expiring snapshot store, not permanent job copies.
        for(const batch of job.batches)batch.items=(batch.items||[]).map(item=>({
            id:item.id,target:clone(item.target),title:item.after?.metadata?.comment||item.title,action:item.action,accepted:item.accepted,
        }));
        job.status='done';job.completedAt=Date.now();await this.persist(job);
    }
    reportTitles(job){
        const titles=Object.create(null);
        for(const target of this.targets||[])titles[target.id]=target.metadata?.comment||target.title;
        for(const batch of job.batches||[])for(const item of batch.items||[]){
            titles[item.target.id]=item.after?.metadata?.comment||item.title;
        }
        return titles;
    }
    async markArchivedKey(job,key){
        if(this.running||this.starting||this.saving)throw Error('请等待当前操作完成');
        if(this.job!==job||this.scope?.chatKey!==job.scope.chatKey)throw Error('归档任务已变化，请重新打开');
        this.saving=true;this.changed('progress');
        try{
            await this.persistChain.catch(()=>{});
            const result=await this.api.storage.markArchivedKey({
                scope:job.scope,jobId:job.id,key,titles:this.reportTitles(job),
            });
            if(this.scope?.chatKey===job.scope.chatKey)this.state.retained=result.retained;
            if(this.job===job)Object.assign(job,result.job);
            return result.removedFromCarry;
        }finally{this.saving=false;this.changed();}
    }
    async refreshTargets(){
        if(!this.targetsDirty)return;
        const catalog=await this.api.targets.listTargets(this.scope);
        this.targets=catalog.targets;this.worlds=catalog.worlds;this.targetsDirty=false;
        Object.assign(this,materialSelection(this.targets,{selectedTargetIds:[...this.selected],
            ...(this.enabledWorlds?{enabledWorlds:[...this.enabledWorlds]}:{})},this.scope.worldNames));
    }
    async stageRestore(snapshot){
        if(this.running||this.saving)throw Error('请先完成当前操作');
        if(this.job&&!['done','abandoned'].includes(this.job.status))throw Error('请先放下当前任务，再创建回退草案');
        if(snapshot.scopeKey!==this.scope.chatKey)throw Error('快照不属于当前聊天');
        const before=await this.api.targets.readTarget(snapshot.target,this.scope);
        const item={id:makeId('restore'),target:clone(snapshot.target),title:'回退 · '+snapshot.title,
            action:snapshot.before===null?'delete':before===null?'create':'replace',before:clone(before),after:clone(snapshot.before),accepted:true};
        const now=Date.now();this.job={id:makeId('job'),schemaVersion:2,scope:clone(this.scope),mode:'free',status:'review',createdAt:now,updatedAt:now,
            firstFloor:0,lastFloor:this.lastFloor,cursorBase:this.state.archivedFloor||0,selectedTargetIds:[item.target.id],config:{},plan:[],messages:[],report:emptyReport(),
            batches:[{id:'batch-1',index:0,title:'回退快照',status:'review',items:[item],report:emptyReport(),restores:snapshot.id}]};
        this.restrictJobMaterials(this.job);
        await this.persist();this.changed();
    }

}
