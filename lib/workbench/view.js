import { button, field, input, node, iconButton } from '../dom.js';
import { WorkbenchController } from './controller.js';
import { clone, DEFAULT_SETTINGS, reportGroups } from './model.js';
import { reviewBatch, snapshotDiff } from './review.js';
import { markdown } from './markdown.js';
import { composerMenu } from './composer-menu.js';
import { mountApiSettings } from './api-settings.js';
import { openMaterials } from './materials.js';
import { failureLabel, failureDetails } from './failures.js';

const row=(...children)=>{const el=node('div','mn-row');el.append(...children);return el;};
const labelStatus={draft:'待开始',planned:'已登记分批',discussion:'讨论中',running:'生成中',review:'待审核',ready:'可继续下一批',interrupted:'已中断，可恢复',saved:'待完成归档记录',done:'已完成',abandoned:'已放下'};
const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const select=(options,value)=>{const el=node('select');for(const [id,label] of options){const option=node('option','',label);option.value=String(id);el.append(option);}el.value=String(value);return el;};
export function downloadText(name,text,type='text/markdown;charset=utf-8'){
    const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');
    a.href=url;a.download=name;a.hidden=true;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export class WorkbenchView {
    constructor(root,{notice,controller}={}){
        this.root=root;this.controller=controller||new WorkbenchController();this.notify=notice;this.opened=false;this.messageCache=new WeakMap();
        this.scrim=button('',()=>this.close(),'mn-wb-scrim');this.scrim.setAttribute('aria-label','收起工作台');
        this.panel=node('section','mn-workbench');this.panel.setAttribute('aria-label','记事簿工作台');this.panel.inert=true;
        const title=node('div','mn-wb-title');title.append(node('small','mn-hint','MNEMOSYNE / WORKSPACE'),node('h2','','记事簿工作台'));
        const header=row(title,iconButton('收起工作台','close',()=>this.close()));
        const actions=node('div','mn-wb-actions');
        for(const [name,fn] of [['材料',()=>this.materials()],['楼层与历史',()=>this.range()],['任务记录',()=>this.tasks()],['旧快照',()=>this.snapshots()],['设置',()=>this.settings()]])
            actions.append(button(name,this.guard(fn)));
        this.config=node('div','mn-wb-config');this.body=node('div','mn-wb-body');this.body.setAttribute('aria-live','off');
        this.taskbar=node('div','mn-wb-taskbar');this.taskbar.hidden=true;
        this.message=node('div','mn-wb-notice');this.message.setAttribute('role','status');this.message.hidden=true;
        this.composer=node('div','mn-wb-composer');
        this.modePicker=composerMenu('切换工作台模式',{iconName:'layers',optionIcons:{archive:'layers',free:'inbox'},
            options:()=>[['archive','归档模式','先确认计划，再逐批审核归档'],['free','自由模式','直接查询或修改所选设定']],
            onSelect:this.guard(value=>this.controller.switchMode(value)),
        });this.mode=this.modePicker.trigger;
        this.apiPicker=composerMenu('工作台 API',{iconName:'plug',
            options:()=>[['main','正文 API','沿用当前连接与模型'],...(this.controller.settings?.channels||[]).map(x=>[x.id,x.name,x.model])],
            onSelect:this.guard(value=>this.controller.saveSettings({sourceId:value})),onManage:()=>this.settings(),
        });
        this.presetPicker=composerMenu('提示词预设',{iconName:'settings',
            options:()=>[['assistant-default','助手默认预设'],...(this.controller.presets||[]).map(x=>[x.id,x.name])],
            onSelect:this.guard(value=>this.controller.saveSettings({presetId:value})),
        });
        this.config.append(this.modePicker.root,this.apiPicker.root,this.presetPicker.root);
        this.input=input('','',true);this.input.rows=1;this.input.setAttribute('aria-label','工作台任务要求');
        // Current WebViews size the field natively. Older ones measure only this textarea after typing.
        if(!globalThis.CSS?.supports?.('field-sizing','content')){
            this.input.oninput=()=>{
                if(!globalThis.requestAnimationFrame){this.fitInput();return;}
                if(this.inputFrame)return;
                this.inputFrame=requestAnimationFrame(()=>{this.inputFrame=0;this.fitInput();});
            };
        }
        this.progress=node('div','mn-wb-progress');
        this.send=button('生成规划',this.guard(()=>this.controller.send(this.takeInput())));
        this.stop=button('停止',()=>this.controller.stop());this.stop.hidden=true;
        this.composer.append(this.input,row(this.config,this.progress,this.stop,this.send));
        this.panel.append(header,actions,this.message,this.body,this.taskbar,this.composer);root.append(this.scrim,this.panel);
        this.unsubscribe=this.controller.subscribe(kind=>this.update(kind));
        this.keydown=ev=>{if(ev.key==='Escape'&&this.opened&&!this.modal)this.close();};
        document.addEventListener('keydown',this.keydown);
    }
    guard(fn){return(...args)=>Promise.resolve().then(()=>fn(...args)).catch(error=>this.error(error));}
    error(error){
        const message=error?.message||String(error);
        if(this.modal?.open){let el=this.modal.querySelector('.mn-error');if(!el){el=node('p','mn-error');this.modal.querySelector('.mn-dialog-body').prepend(el);}el.textContent=message;}
        else this.notice(message);
    }
    notice(text){this.message.textContent=text;this.message.hidden=!text;if(!this.opened&&text)this.notify?.(text);}
    async open(){
        this.opened=true;this.panel.inert=false;this.root.dataset.workbench='yes';this.notice('正在读取工作台材料…');
        try{await this.controller.open();if(this.opened){this.notice('');this.render();if(this.input.oninput)this.input.oninput();this.input.focus({preventScroll:true});}}
        catch(error){this.error(error);}
    }
    close(){
        this.modal?.close();this.closePickers();this.opened=false;this.panel.inert=true;this.root.dataset.workbench='no';
        clearTimeout(this.textTimer); // Generation continues; closing a panel does not cancel a run.
        this.textTimer=null;
    }
    dialog(title,className=''){
        this.closePickers();this.modal?.close();const el=node('dialog','mn-dialog mn-wb-dialog '+className),body=node('div','mn-dialog-body');
        el.setAttribute('aria-label',title);el.append(row(node('h3','',title),iconButton('关闭','close',()=>el.close())),body);
        el.addEventListener('close',()=>{
            if(this.modal===el)this.modal=null;el.remove();
            if(this.opened&&this.pendingRender&&!this.modal)queueMicrotask(()=>{
                if(this.opened&&this.pendingRender&&!this.modal)this.render();
            });
        },{once:true});
        this.root.append(el);this.modal=el;el.showModal();return {el,body};
    }
    update(kind){
        if(!this.opened)return;
        if(kind==='text'||kind==='status'){
            if(!this.textTimer)this.textTimer=setTimeout(()=>{this.textTimer=null;this.flushLive();},80);
            return;
        }
        if(kind==='progress'){this.renderProgress();this.renderTaskbar();if(this.controller.running&&!this.live)this.render();return;}
        if(kind==='notice'){this.notice(this.controller.notice||'');return;}
        if(!this.modal)this.render();else{this.pendingRender=true;this.renderProgress();this.renderTaskbar();}
    }
    renderProgress(){
        const c=this.controller;if(!c.state)return;
        const active=c.job&&!['done','abandoned','draft'].includes(c.job.status);
        const mode=active?c.job.mode:c.state.mode;
        this.modePicker.update(mode,mode==='archive'?'归档':'自由',c.starting||c.running||c.saving);
        this.mode.value=mode;
        this.apiPicker.update(c.settings.sourceId,c.settings.sourceId==='main'?'正文 API':c.settings.channels.find(x=>x.id===c.settings.sourceId)?.name||'选择 API',c.starting||c.running||c.saving);
        this.presetPicker.update(c.settings.presetId,c.settings.presetId==='assistant-default'?'默认预设':c.presets?.find(x=>x.id===c.settings.presetId)?.name||'选择预设',c.starting||c.running||c.saving);
        this.send.disabled=c.starting||c.running||c.saving||c.job?.batches?.some(b=>['review','partial'].includes(b.status));
        this.stop.hidden=!c.running;this.send.hidden=c.running;
        this.send.textContent=mode==='archive'&&(!c.job||c.job.status==='draft')?'生成规划':'发送';
        const discuss=mode==='archive'&&(!active||c.job.status==='discussion');
        const placeholder=discuss?'输入规划要求或直接生成…':mode==='free'?'输入问题或修改要求…':'输入本批补充要求…';
        if(this.input.placeholder!==placeholder){
            this.input.placeholder=placeholder;
            if(this.opened&&this.input.oninput&&!this.input.value)this.input.oninput();
        }
        this.progress.replaceChildren();
        if(mode==='archive'){
            const floor=button(String(c.state.archivedFloor||0),this.guard(()=>this.editArchivedFloor()),'mn-wb-floor-link');
            floor.setAttribute('aria-label','修改最后归档楼层');
            this.progress.append(document.createTextNode('已归档 '),floor,document.createTextNode(' / '+Math.max(0,c.lastFloor)+' 楼'));
        }else this.progress.textContent='正文范围 '+(c.state.firstFloor??0)+'–'+(c.state.throughFloor??c.lastFloor)+' 楼';
    }
    closePickers(){this.modePicker?.close();this.apiPicker?.close();this.presetPicker?.close();}
    nearBottom(){return this.body.scrollHeight-this.body.clientHeight-this.body.scrollTop<90;}
    flushLive(){
        if(!this.live||!this.opened)return;
        const c=this.controller,bottom=this.nearBottom(),text=c.liveText||'',reasoning=c.liveReasoning||'';
        if(this.live.textContent!==text.slice(-24000))this.live.textContent=text.slice(-24000);
        this.live.hidden=!text;
        this.liveStatus.textContent=c.liveStatus||(text?'正在输出回复':reasoning?'模型正在推理':'正在等待模型响应');
        this.liveReasoning.hidden=!reasoning;
        if(reasoning&&this.liveReasoning.open)this.liveReasoningText.textContent=reasoning.slice(-24000);
        this.liveTail.hidden=text.length<=24000&&reasoning.length<=24000;
        if(bottom)this.body.scrollTop=this.body.scrollHeight;
    }
    reasoningBlock(text){
        const details=node('details','mn-wb-reasoning');details.append(node('summary','','模型推理'));
        let loaded=false;details.ontoggle=()=>{if(details.open&&!loaded){loaded=true;details.append(markdown(text));}};
        return details;
    }
    messageBlock(message){
        const cached=this.messageCache.get(message);if(cached)return cached;
        if(message.kind==='failure'&&message.failure){
            const block=this.failureBlock(message.failure);this.messageCache.set(message,block);return block;
        }
        const block=node('section','mn-wb-message '+(message.role==='user'?'mn-wb-user':''));
        block.append(node('small','mn-wb-speaker',message.role==='user'?'你':'助手'+(message.incomplete?' · 未完整结束':'')));
        if(message.reasoning)block.append(this.reasoningBlock(message.reasoning));
        if(message.content)block.append(markdown(message.content));
        this.messageCache.set(message,block);return block;
    }
    failureBlock(failure){
        const block=node('section','mn-wb-message');
        block.append(node('strong','mn-wb-error',failureLabel(failure)+' · 已停止'));
        const detail=node('details');detail.open=true;
        detail.append(node('summary','','错误原因与原始报错'),node('pre','mn-wb-prose',failureDetails(failure)),
            button('导出错误记录',()=>downloadText('mnemosyne-error-'+(failure.createdAt||Date.now())+'.json',JSON.stringify(failure,null,2),'application/json;charset=utf-8')));
        block.append(detail);return block;
    }
    planBlock(job){
        if(this.planCache?.plan===job.plan&&this.planCache.explanation===job.planExplanation)return this.planCache.block;
        const block=node('section','mn-wb-message mn-wb-plan-message');
        block.append(node('small','mn-wb-speaker','助手 · 归档计划'));
        const card=node('div','mn-wb-plan');card.append(row(node('strong','','分批计划'),node('small','mn-hint',job.plan.length+' 批')));
        if(job.planExplanation){
            const explanation=node('details','mn-wb-plan-explanation');explanation.append(node('summary','','规划说明与待确认事项'));
            let loaded=false;explanation.ontoggle=()=>{if(explanation.open&&!loaded){loaded=true;explanation.append(markdown(job.planExplanation));}};card.append(explanation);
        }
        const table=node('table'),head=node('thead'),headRow=node('tr'),body=node('tbody');
        for(const label of ['批次','主题','目标','条数']){const th=node('th','',label);th.setAttribute('scope','col');headRow.append(th);}head.append(headRow);table.append(head,body);
        const byId=new Map((this.controller.targets||[]).map(t=>[t.id,t]));
        const targetLabel=id=>{const t=byId.get(id),label=t?.metadata?.comment||t?.title||id;return label.match(/\b[SPR]-\d{3}\b/)?.[0]||label;};
        for(const [index,batch] of job.plan.entries()){
            const tr=node('tr'),title=node('td');
            const shortTitle=batch.title.replace(/^\s*(?:\d+[.、．]\s*)+/,'').replace(/^第[一二三四五六七八九十\d]+批\s*[:：·.\-]?\s*/,'')||batch.title;
            tr.append(node('td','mn-wb-batch-index',String(index+1)),title,node('td','mn-wb-batch-targets',batch.targets?.length?batch.targets.map(targetLabel).join('、'):'见详情'),node('td','mn-wb-batch-count',batch.targets?.length?String(batch.targets.length):'—'));
            body.append(tr);
            if(!batch.instructions){title.textContent=shortTitle;continue;}
            const detailRow=node('tr','mn-wb-plan-detail'),detail=node('td');detail.setAttribute('colspan','4');detailRow.hidden=true;detailRow.append(detail);body.append(detailRow);
            const toggle=button(shortTitle,()=>{
                detailRow.hidden=!detailRow.hidden;toggle.setAttribute('aria-expanded',String(!detailRow.hidden));
                if(!detailRow.hidden&&!detail.childNodes.length)detail.append(markdown(batch.instructions));
            },'mn-wb-batch-title');toggle.setAttribute('aria-expanded','false');toggle.title='展开本批备注';title.append(toggle);
        }
        const wrap=node('div','mn-wb-table');wrap.append(table);card.append(wrap);
        block.append(card);this.planCache={plan:job.plan,explanation:job.planExplanation,block};return block;
    }
    renderTaskbar(){
        const c=this.controller,job=c.job;this.taskbar.replaceChildren();this.taskbar.hidden=!job;if(!job)return;
        const controls=node('div','mn-wb-task-controls');
        if(job.status==='planned')controls.append(button('开始第一批',this.guard(()=>c.send(this.takeInput(),{execute:true})),'mn-primary'));
        if(job.status==='ready')controls.append(button('生成下一批',this.guard(()=>c.send(this.takeInput(),{execute:true})),'mn-primary'));
        if(job.status==='review'||job.status==='interrupted'&&c.currentBatch()?.items?.length){
            const review=button(c.running?'本批仍在生成…':job.failure?.kind==='tool'?'审核已保留草案':'审核本批修改',this.guard(async()=>{await c.prepareReview();reviewBatch(this);}),'mn-primary');
            review.disabled=c.running||c.starting||c.saving;controls.append(review);
        }
        if(job.status==='interrupted')controls.append(button(job.failure?.kind==='tool'?'手动重新提交':'重试当前阶段',this.guard(()=>c.send(this.takeInput(),{retry:true})),'mn-primary'));
        if(!c.running&&job.error&&job.nativeRunId&&job.config?.sourceId==='main')controls.append(button('查看上次 TT 运行记录',this.guard(()=>this.showRunLog(job.nativeRunId))));
        if(job.status==='saved')controls.append(button('完成归档记录',this.guard(()=>c.finishJob()),'mn-primary'));
        if(!c.running&&!c.saving)controls.append(button(job.status==='done'?'新任务':'放下任务',this.guard(()=>c.abandon())));
        for(const control of controls.children)if(c.starting||c.saving)control.disabled=true;
        this.taskbar.append(node('small','mn-wb-task-state',(job.mode==='archive'?'归档':'自由')+' · '+job.firstFloor+'–'+job.lastFloor+' 楼 · '+(labelStatus[job.status]||job.status)),controls);
    }
    render(){
        const c=this.controller;if(!c.settings)return;
        this.pendingRender=false;
        clearTimeout(this.textTimer);this.textTimer=null;
        const bottom=this.nearBottom(),top=this.body.scrollTop;
        this.body.replaceChildren();
        const job=c.job;
        if(!job){
            this.messageCache=new WeakMap();this.visibleMessages=new Set();this.planCache=null;
            const empty=node('div','mn-wb-welcome');
            empty.append(node('h3','','把设定整理成可审核的改动'),node('p','mn-hint','归档模式先规划，再逐批整理 rolling；自由模式可直接查询和编辑世界书、User 与 Char 设定。'),
                node('p','mn-hint','已选 '+c.selected.size+' 个设定字段/条目。可在输入区切换模式、API 和预设。'),
                button('检查本次材料',this.guard(()=>this.materials())));
            this.body.append(empty);
        }else{
            const messages=job.messages||[],offset=Math.max(0,messages.length-24);
            const visible=new Set(messages.slice(offset).filter(m=>m.kind!=='plan'));
            for(const old of this.visibleMessages||[])if(!visible.has(old))this.messageCache.delete(old);
            this.visibleMessages=visible;
            if(offset)this.body.append(button('查看更早的工作台对话（'+offset+'条）',()=>this.showMessages(messages.slice(0,offset))));
            const hasPlanMessage=messages.slice(offset).some(m=>m.kind==='plan');
            if(job.plan?.length&&!hasPlanMessage)this.body.append(this.planBlock(job));
            for(const message of messages.slice(offset)){
                this.body.append(message.kind==='plan'?this.planBlock(job):this.messageBlock(message));
            }
            if(job.error)this.body.append(node('p','mn-wb-error',job.error));
            if(job.nativeCancelError)this.body.append(node('p','mn-wb-error','TT 取消请求未获确认：'+job.nativeCancelError+'。本批已停止接收修改。'));
            if(job.history?.warnings?.length)this.body.append(node('p','mn-hint',job.history.warnings.join('\n')));
            if(job.finalReport)this.body.append(this.archiveReport(job));
        }
        if(c.running){
            if(!this.liveBlock){
                this.liveBlock=node('section','mn-wb-message mn-wb-live-message');this.liveStatus=node('div','mn-wb-run-status');this.liveStatus.setAttribute('role','status');
                this.liveReasoning=node('details','mn-wb-reasoning');this.liveReasoning.append(node('summary','','模型推理'));
                this.liveReasoningText=node('div','mn-wb-prose');this.liveReasoning.append(this.liveReasoningText);
                this.liveReasoning.ontoggle=()=>{if(this.liveReasoning?.open)this.liveReasoningText.textContent=(c.liveReasoning||'').slice(-24000);};
                this.live=node('div','mn-wb-prose mn-wb-live');this.liveTail=node('small','mn-hint','生成中暂显示最新一段，完成后显示全文。');
                this.liveBlock.append(this.liveStatus,this.liveReasoning,this.live,this.liveTail);
            }
            this.body.append(this.liveBlock);this.flushLive();
        }else{this.liveBlock=null;this.live=null;}
        this.renderProgress();this.renderTaskbar();
        this.body.scrollTop=bottom?this.body.scrollHeight:top;
    }
    fitInput(){
        if(!this.opened)return;
        this.input.style.height='auto';
        this.input.style.height=this.input.scrollHeight+'px';
    }
    takeInput(){
        const value=this.input.value;this.input.value='';
        this.input.style.removeProperty('height');if(this.input.oninput)this.fitInput();return value;
    }
    async showRunLog(runId){
        const {el,body}=this.dialog('上次 TT 运行记录');
        const log=node('div','mn-wb-run-log','正在读取…');body.append(log);
        try{
            const entries=await this.controller.api.readWorkbenchRunLog(runId);
            if(!el.open)return;
            log.replaceChildren();
            let firstFailure=true;
            for(const {label,detail} of entries){
                if(!detail){log.append(node('div','',label));continue;}
                const row=node('details');row.open=firstFailure;firstFailure=false;
                row.append(node('summary','',label),node('pre','mn-wb-prose',detail));log.append(row);
            }
            if(!entries.length)log.textContent='最近记录中没有可显示的阶段，或 TT 已清理此运行。';
        }catch(error){if(el.open)log.textContent='无法读取此次运行记录。'+(error?.message||'');}
    }
    archiveReport(job){
        const panel=node('section','mn-wb-report');
        panel.append(node('h3','','本次归档结果'));
        if(job.report&&job.mode==='archive'){
            const lists=node('div','mn-wb-markdown');
            for(const group of reportGroups(job.report,this.controller.reportTitles(job))){
                const title=node('p');title.append(node('strong','',group.title));lists.append(title);
                const list=node('ul');
                for(const row of group.rows){
                    const item=node('li');
                    if(row.key){
                        const action=iconButton('标记为已归档','circleCheck',()=>this.confirmArchivedKey(job,row.key));
                        action.setAttribute('aria-label','标记为已归档 · '+row.key);
                        action.classList.add('mn-wb-archive-check');
                        const entry=node('div','mn-wb-report-row');
                        entry.append(node('span','',row.text),action);
                        item.append(entry);
                    }else item.textContent=row.text;
                    list.append(item);
                }
                if(!group.rows.length)list.append(node('li','','无'));
                lists.append(list);
            }
            panel.append(lists);
        }else panel.append(markdown(job.finalReport));
        panel.append(button('导出本次 key 清单',()=>downloadText('mnemosyne-archive-'+job.lastFloor+'.md',job.finalReport)));
        return panel;
    }
    confirmArchivedKey(job,key){
        const {el,body}=this.dialog('标记为已归档');
        const save=button('确认',this.guard(async()=>{
            if(save.disabled)return;
            save.disabled=true;
            try{
                const removed=await this.controller.markArchivedKey(job,key);
                el.close();
                this.notice(removed?'已更新本次清单和下次保留清单。':'已更新本次清单。');
            }finally{save.disabled=false;}
        }),'mn-primary');
        body.append(node('p','','将「'+key+'」移到本次已清除清单？'),
            row(button('取消',()=>el.close()),save));
    }
    showMessages(messages){const {body}=this.dialog('工作台对话');for(const m of messages)if(m.kind!=='plan'){
        if(m.kind==='failure'){body.append(this.failureBlock(m.failure));continue;}
        const block=node('section','mn-wb-message');block.append(node('small','mn-wb-speaker',m.role==='user'?'你':'助手'));
        if(m.reasoning)block.append(this.reasoningBlock(m.reasoning));if(m.content)block.append(markdown(m.content));body.append(block);
    }}
    editArchivedFloor(){
        const {el,body}=this.dialog('设置最后归档楼层'),c=this.controller;
        const number=input(c.state.archivedFloor||0,'楼层数');number.type='number';number.inputMode='numeric';number.min='0';number.max=String(c.lastFloor);
        const manual=input();manual.type='checkbox';manual.checked=c.state.manualArchive===true;
        body.append(field('最后归档楼层（本次含该楼）',number),field('从手动归档处接续',manual),
            node('p','mn-hint','本聊天后续归档用「材料」中选定的设定衔接前情，跳过起始楼之前的记忆总结。取消勾选可恢复读取总结。'),
            button('确认',this.guard(async()=>{await c.setArchivedFloor(number.value===''?NaN:Number(number.value),manual.checked);el.close();this.render();}),'mn-primary'));number.focus();
    }
    range(){
        const c=this.controller,{el,body}=this.dialog('工作台楼层与历史');
        const locked=c.job&&!['done','abandoned','draft'].includes(c.job.status);
        const manualArchive=locked?c.job.mode==='archive'&&c.job.manualArchive:c.state.mode==='archive'&&c.state.manualArchive;
        body.append(node('p','mn-hint','楼层编号从0开始，包含已隐藏的正文。'+(manualArchive
            ?'当前从手动归档处接续，前情取自所选设定。':'历史总结取自起始楼之前。已手动归档的聊天可点工作台下方「已归档」数字设置接续方式。')));
        const first=input(c.state.mode==='archive'?c.state.archivedFloor||0:c.state.firstFloor??0,''),last=input(c.state.throughFloor??'','留空为最新楼');
        first.type=last.type='number';first.min=last.min='0';first.disabled=locked||c.state.mode==='archive';last.disabled=locked;
        body.append(field(c.state.mode==='archive'?'起始楼（跟随已归档楼层）':'起始楼',first),field('截止楼',last));
        if(locked)body.append(node('p','mn-hint','当前任务范围已固定。新楼层留给下一次任务。'));
        const preview=button('查看实际请求材料',this.guard(async()=>{
            if(!locked)await c.saveState({firstFloor:Number(first.value),throughFloor:last.value===''?null:Number(last.value)});
            const capture=await c.preview();el.close();const {body}=this.dialog('本次请求材料预览');
            body.append(node('p','mn-hint',capture.firstFloor+'–'+capture.lastFloor+'楼 · '+capture.rawMessages.length+'条原文 · '+capture.selectedTargets.length+'个设定字段/条目'));
            const all=[capture.historyBlock||(c.job.mode==='archive'&&c.job.manualArchive?'（手动归档接续，前情见所选设定）':'（没有历史总结）'),...capture.selectedTargets.map(t=>'['+t.id+']\n'+t.content),...capture.rawMessages.map(m=>'#'+m.floor+' · '+m.role+'\n'+m.content)];
            const show=node('pre','mn-wb-prose',all.join('\n\n'));body.append(show);
        }));
        body.append(preview,button('保存范围',this.guard(async()=>{
            if(!locked)await c.saveState({firstFloor:Number(first.value),throughFloor:last.value===''?null:Number(last.value)});
            el.close();this.renderProgress();
        }),'mn-primary'));
    }
    async materials(){return openMaterials(this);}
    async tasks(){
        const c=this.controller,{body}=this.dialog('任务记录'),list=node('div','mn-entries mn-wb-records');body.append(list);let cursor;
        const load=async()=>{
            const jobs=await c.api.storage.listJobs(c.scope,{limit:30,before:cursor});
            for(const job of jobs)list.append(button((job.mode==='archive'?'归档':'自由')+' · '+job.firstFloor+'–'+job.lastFloor+'楼 · '+(labelStatus[job.status]||job.status)+'\n'+date(job.createdAt),this.guard(async()=>{await c.resume(job.id);this.modal?.close();this.render();}),'mn-entry'));
            cursor=jobs.at(-1);more.hidden=jobs.length<30;
            if(!jobs.length&&!cursor)list.append(node('p','mn-empty','还没有工作台任务'));
        };
        const more=button('查看更多',this.guard(load));body.append(more);await load();
    }
    async snapshots(){
        const c=this.controller,{body}=this.dialog('旧快照'),picked=new Set(),list=node('div','mn-entries mn-wb-records');let cursor;
        body.append(node('p','mn-hint','每次已审核的写入保存完整新旧版本。默认保留'+c.settings.retentionDays+'天。多选可导出为一个Markdown文档。'));
        const exportButton=button('导出所选（0）',this.guard(async()=>{
            if(!picked.size)throw Error('请先选择快照');
            downloadText('mnemosyne-snapshots-'+new Date().toISOString().slice(0,10)+'.md',await c.api.storage.exportSnapshots([...picked]));
        }));body.append(exportButton,list);
        const load=async()=>{
            const snapshots=await c.api.storage.listSnapshots(c.scope,{limit:40,before:cursor});
            for(const snapshot of snapshots){
                const check=input('','');check.type='checkbox';check.setAttribute('aria-label','选择快照 '+snapshot.title);
                check.onchange=()=>{if(check.checked)picked.add(snapshot.id);else picked.delete(snapshot.id);exportButton.textContent='导出所选（'+picked.size+'）';};
                list.append(row(check,button(snapshot.title+'\n'+date(snapshot.createdAt)+' · '+snapshot.status,this.guard(async()=>{
                    const full=await c.api.storage.getSnapshot(snapshot.id);if(!full)throw Error('快照已过期，请刷新列表');
                    const {body}=snapshotDiff(this,full);
                    if(full.status==='applied')body.append(button('用旧版本创建回退草案',this.guard(async()=>{
                        await c.stageRestore(full);this.modal?.close();this.render();reviewBatch(this);
                    }),'mn-primary'));
                }),'mn-entry')));
            }
            cursor=snapshots.at(-1);more.hidden=snapshots.length<40;
            if(!snapshots.length&&!cursor)list.append(node('p','mn-empty','还没有修改快照'));
        };
        const more=button('查看更多',this.guard(load));body.append(more);await load();
    }
    settings(){
        const c=this.controller,s=clone(c.settings),{el,body}=this.dialog('工作台设置'),controls={};
        body.append(node('h4','','生成参数'),node('p','mn-hint','正文主 API 仅借用当前连接与模型。所有通道的生成参数使用这里的插件配置，不读取记忆插件 API 列表。'));
        const grid=node('div','mn-wb-properties');
        for(const [key,label] of [['temperature','温度'],['maxTokens','最大输出 token'],['contextSize','上下文 token'],['timeoutSec','无进展超时（秒）']]){
            const control=input(s.generation[key],'');control.type='number';if(key==='temperature')control.step='0.1';controls[key]=control;grid.append(field(label,control));
        }
        const stream=input('','');stream.type='checkbox';stream.checked=s.generation.stream;grid.append(field('流式显示',stream));
        const reasoning=select([['','由模型默认'],['none','none'],['low','low'],['medium','medium'],['high','high'],['xhigh','xhigh']],s.generation.reasoningEffort||'');grid.append(field('推理强度',reasoning));body.append(grid);
        body.append(node('h4','','API 配置'),node('p','mn-hint','选择一个 API 编辑；添加、测试和模型列表均使用当前填写的配置。'));
        const channels=node('div','mn-wb-channels');body.append(channels);
        const apiEditor=mountApiSettings(this,channels,s,{generation:()=>({
            ...s.generation,...Object.fromEntries(Object.entries(controls).map(([key,control])=>[key,Number(control.value)])),
            stream:stream.checked,reasoningEffort:reasoning.value,
        })});
        const days=input(s.retentionDays,'30');days.type='number';days.min='1';body.append(field('旧快照保留天数',days));
        const prompts=node('details');prompts.append(node('summary','','职责说明与常用任务提示词'));
        prompts.append(node('p','mn-hint','归档字数、用词与正式编号由提示词及人工审核决定，插件不作内容拦截。'));
        const promptControls=[];
        for(const [group,key,label] of [['duties','common','共同职责'],['duties','archive','归档模式职责'],['duties','free','自由模式职责'],['tasks','plan','归档规划提示'],['tasks','archiveBatch','逐批归档提示'],['tasks','free','自由模式提示']]){
            const control=input(s[group][key],'',true);control.classList.add('mn-wb-prompt');prompts.append(field(label,control));promptControls.push({group,key,control});
        }
        prompts.append(button('恢复内置职责和任务提示',()=>{for(const p of promptControls)p.control.value=DEFAULT_SETTINGS[p.group][p.key];}));
        body.append(prompts,button('保存设置',this.guard(async()=>{
            for(const [key,control] of Object.entries(controls))s.generation[key]=Number(control.value);
            s.generation.stream=stream.checked;s.generation.reasoningEffort=reasoning.value;s.retentionDays=Number(days.value);
            for(const p of promptControls)s[p.group][p.key]=p.control.value;
            await apiEditor.flush();await c.saveSettings(s);el.close();this.render();
        }),'mn-primary'));
    }
}
export function createWorkbench(root,options){return new WorkbenchView(root,options);}
