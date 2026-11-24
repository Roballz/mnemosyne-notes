import { button, field, input, node, iconButton } from '../dom.js';
import { WorkbenchController } from './controller.js';
import { clone, DEFAULT_SETTINGS, makeId, selectedIds, interruptedArchiveSetup } from './model.js';
import { reviewBatch, snapshotDiff } from './review.js';

const row=(...children)=>{const el=node('div','mn-row');el.append(...children);return el;};
const labelStatus={draft:'待开始',planned:'计划待确认',discussion:'讨论中',running:'生成中',review:'待审核',ready:'可继续下一批',interrupted:'已中断，可恢复',saved:'待完成归档记录',done:'已完成',abandoned:'已放下'};
const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const select=(options,value)=>{const el=node('select');for(const [id,label] of options){const option=node('option','',label);option.value=String(id);el.append(option);}el.value=String(value);return el;};
export function downloadText(name,text){
    const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download=name;a.hidden=true;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export class WorkbenchView {
    constructor(root,{notice,controller}={}){
        this.root=root;this.controller=controller||new WorkbenchController();this.notify=notice;this.opened=false;
        this.scrim=button('',()=>this.close(),'mn-wb-scrim');this.scrim.setAttribute('aria-label','收起工作台');
        this.panel=node('section','mn-workbench');this.panel.setAttribute('aria-label','记事簿工作台');this.panel.inert=true;
        const title=node('div','mn-wb-title');title.append(node('small','mn-hint','MNEMOSYNE / WORKSPACE'),node('h2','','记事簿工作台'));
        const header=row(title,iconButton('收起工作台','close',()=>this.close()));
        const actions=node('div','mn-wb-actions');
        for(const [name,fn] of [['材料',()=>this.materials()],['楼层与历史',()=>this.range()],['任务记录',()=>this.tasks()],['旧快照',()=>this.snapshots()],['设置',()=>this.settings()]])
            actions.append(button(name,this.guard(fn)));
        this.config=node('div','mn-wb-config');this.body=node('div','mn-wb-body');this.body.setAttribute('aria-live','off');
        this.message=node('div','mn-wb-notice');this.message.setAttribute('role','status');this.message.hidden=true;
        this.composer=node('div','mn-wb-composer');this.mode=select([['archive','归档模式'],['free','自由模式']],'archive');
        this.mode.setAttribute('aria-label','工作台模式');
        this.mode.onchange=this.guard(()=>this.controller.saveState({mode:this.mode.value}));
        this.input=input('','输入要求，或先生成归档规划…',true);this.input.setAttribute('aria-label','工作台任务要求');
        this.progress=node('div','mn-wb-progress');
        this.send=button('生成规划',this.guard(async()=>{const text=this.input.value;this.input.value='';await this.controller.send(text);}));
        this.stop=button('停止',()=>this.controller.stop());this.stop.hidden=true;
        this.composer.append(row(this.mode,node('small','mn-hint','独立于正文聊天')),this.input,row(this.progress,row(this.stop,this.send)));
        this.panel.append(header,actions,this.config,this.message,this.body,this.composer);root.append(this.scrim,this.panel);
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
        try{await this.controller.open();if(this.opened){this.notice('');this.render();this.input.focus({preventScroll:true});}}
        catch(error){this.error(error);}
    }
    close(){
        this.modal?.close();this.opened=false;this.panel.inert=true;this.root.dataset.workbench='no';
        clearTimeout(this.textTimer); // Generation continues; closing a panel does not cancel a run.
    }
    dialog(title,className=''){
        this.modal?.close();const el=node('dialog','mn-dialog mn-wb-dialog '+className),body=node('div','mn-dialog-body');
        el.setAttribute('aria-label',title);el.append(row(node('h3','',title),iconButton('关闭','close',()=>el.close())),body);
        el.addEventListener('close',()=>{if(this.modal===el)this.modal=null;el.remove();},{once:true});
        this.root.append(el);this.modal=el;el.showModal();return {el,body};
    }
    update(kind){
        if(!this.opened)return;
        if(kind==='text'){
            if(!this.textTimer)this.textTimer=setTimeout(()=>{this.textTimer=null;if(this.live)this.live.textContent=this.controller.liveText.slice(-16000);},80);
            return;
        }
        if(kind==='progress'){this.renderProgress();if(this.controller.running&&!this.live)this.render();return;}
        if(kind==='notice'){this.notice(this.controller.notice||'');return;}
        if(!this.modal)this.render();else this.renderProgress();
    }
    renderProgress(){
        const c=this.controller;if(!c.state)return;
        const active=c.job&&!['done','abandoned','draft'].includes(c.job.status);
        const mode=active?c.job.mode:c.state.mode;
        this.mode.value=mode;this.mode.disabled=c.starting||c.running||c.saving||!!active;
        this.send.disabled=c.starting||c.running||c.saving||c.job?.batches?.some(b=>['review','partial'].includes(b.status));
        this.stop.hidden=!c.running;this.send.hidden=c.running;
        this.send.textContent=mode==='archive'&&!c.job?.plan?.length?'生成规划':'发送';
        this.progress.replaceChildren();
        if((c.job?.mode||c.state.mode)==='archive'){
            const floor=button(String(c.state.archivedFloor||0),this.guard(()=>this.editArchivedFloor()),'mn-wb-floor-link');
            floor.setAttribute('aria-label','修改最后归档楼层');
            this.progress.append(document.createTextNode('已归档 '),floor,document.createTextNode(' / '+Math.max(0,c.lastFloor)+' 楼'));
        }else this.progress.textContent='正文范围 '+(c.state.firstFloor??0)+'–'+(c.state.throughFloor??c.lastFloor)+' 楼';
    }
    render(){
        const c=this.controller;if(!c.settings)return;
        clearTimeout(this.textTimer);this.textTimer=null;
        const api=select([['main','正文主 API · 参数使用插件配置'],...c.settings.channels.map(x=>[x.id,x.name])],c.settings.sourceId);
        const preset=select([['assistant-default','助手默认预设'],...(c.presets||[]).map(x=>[x.id,x.name])],c.settings.presetId);
        api.setAttribute('aria-label','工作台API');preset.setAttribute('aria-label','提示词预设');
        api.disabled=preset.disabled=c.running||c.saving;
        api.onchange=this.guard(()=>c.saveSettings({sourceId:api.value}));preset.onchange=this.guard(()=>c.saveSettings({presetId:preset.value}));
        this.config.replaceChildren(field('API',api),field('提示词预设',preset));
        this.body.replaceChildren();this.live=null;
        const job=c.job;
        if(!job){
            const empty=node('div','mn-wb-welcome');
            empty.append(node('h3','','把设定整理成可审核的改动'),node('p','mn-hint','归档模式先规划，再逐批整理 rolling；自由模式可直接查询和编辑世界书、User 与 Char 设定。'),
                node('p','mn-hint','已选 '+c.selected.size+' 个设定字段/条目。工作台读取所选楼层原文，包含正文界面已隐藏的楼层。'),
                button('检查本次材料',this.guard(()=>this.materials())));
            this.body.append(empty);
        }else{
            const card=node('div','mn-wb-task');
            card.append(row(node('strong','',(job.mode==='archive'?'归档':'自由编辑')+' · '+job.firstFloor+'–'+job.lastFloor+'楼'),
                node('small','mn-hint',labelStatus[job.status]||job.status)));
            if(job.error)card.append(node('p','mn-error',job.error));
            if(job.history?.warnings?.length)card.append(node('p','mn-hint',job.history.warnings.join('\n')));
            if(job.plan?.length){
                const details=node('details');details.open=['planned','discussion'].includes(job.status);
                details.append(node('summary','','分批计划 · '+job.plan.length+'批'));
                if(job.planExplanation)details.append(node('p','mn-wb-prose',job.planExplanation));
                const list=node('ol');for(const [index,b] of job.plan.entries()){const li=node('li');li.append(node('strong','',(index+1)+'. '+b.title),node('p','mn-hint',b.instructions));list.append(li);}details.append(list);card.append(details);
            }
            const controls=node('div','mn-chips');
            if(job.status==='planned')controls.append(button('按计划开始第一批',this.guard(()=>c.send(this.takeInput(),{execute:true})),'mn-primary'));
            if(job.status==='ready')controls.append(button('生成下一批',this.guard(()=>c.send(this.takeInput(),{execute:true})),'mn-primary'));
            if(job.status==='review'){
                const review=button(c.running?'本批仍在生成…':'审核本批修改',this.guard(async()=>{await c.prepareReview();reviewBatch(this);}),'mn-primary');
                review.disabled=c.running||c.starting||c.saving;controls.append(review);
            }
            if(job.status==='interrupted')controls.append(button('重试当前阶段',this.guard(()=>c.send(this.takeInput(),{retry:true})),'mn-primary'));
            if(job.status==='saved')controls.append(button('完成归档记录',this.guard(()=>c.finishJob()),'mn-primary'));
            if(!c.running&&!c.saving)controls.append(button(job.status==='done'?'开始新任务':'放下本任务',this.guard(()=>c.abandon())));
            card.append(controls);this.body.append(card);
            const messages=job.messages||[],offset=Math.max(0,messages.length-24);
            if(offset)this.body.append(button('查看更早的工作台对话（'+offset+'条）',()=>this.showMessages(messages.slice(0,offset))));
            for(const message of messages.slice(offset)){
                const block=node('section','mn-wb-message '+(message.role==='user'?'mn-wb-user':''));
                block.append(node('small','mn-hint',message.role==='user'?'你':'助手'+(message.incomplete?' · 未完整结束':'')),node('pre','mn-wb-prose',message.content));this.body.append(block);
            }
            if(job.finalReport){
                const report=node('section','mn-wb-report');report.append(node('h3','','本次归档结果'),node('pre','mn-wb-prose',job.finalReport),
                    button('导出本次 key 清单',()=>downloadText('mnemosyne-archive-'+job.lastFloor+'.md',job.finalReport)));
                this.body.append(report);
            }
        }
        if(c.running){this.live=node('pre','mn-wb-prose mn-wb-live',c.liveText.slice(-16000)||'正在准备本次请求…');this.body.append(this.live);}
        this.renderProgress();
    }
    takeInput(){const value=this.input.value;this.input.value='';return value;}
    showMessages(messages){const {body}=this.dialog('工作台对话');for(const m of messages)body.append(node('small','mn-hint',m.role==='user'?'你':'助手'),node('pre','mn-wb-prose',m.content));}
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
    async materials(){
        const c=this.controller;await c.refreshTargets();
        const {el,body}=this.dialog('选择给助手看的设定');
        const unstarted=interruptedArchiveSetup(c.job);
        const locked=c.job&&!['done','abandoned','draft'].includes(c.job.status)&&!unstarted,picked=new Set(locked||unstarted?c.job.selectedTargetIds:c.selected);
        const search=input('','搜索名称、关键词或编号'),list=node('div','mn-wb-materials'),count=node('small','mn-hint');let shown=50,timer;
        const controls=node('div','mn-chips');
        const choose=ids=>{picked.clear();for(const id of ids)picked.add(id);draw();};
        for(const [label,ids] of [['全选',()=>c.targets.map(t=>t.id)],['全不选',()=>[]],['默认选择',()=>[...selectedIds(c.targets)]]]){
            const b=button(label,()=>choose(ids()));b.disabled=locked;controls.append(b);
        }
        body.append(node('p','mn-hint',locked?'当前任务材料已固定。放下当前任务后可重新选择。':'默认选中 User、Char 和常驻蓝灯条目；绿灯可手动勾选，选中后会完整发送。'),search,controls,count,list);
        function draw(){
            count.textContent='已选 '+picked.size+' / '+c.targets.length;
            const q=search.value.trim().toLocaleLowerCase();
            const matches=c.targets.filter(t=>!q||(t.title+' '+t.id+' '+(t.metadata?.key||[]).join(' ')).toLocaleLowerCase().includes(q));
            list.replaceChildren();
            for(const t of matches.slice(0,shown)){
                const item=node('div','mn-wb-material'),check=input('','');check.type='checkbox';check.checked=picked.has(t.id);check.disabled=locked;check.setAttribute('aria-label','选择 '+t.title);
                check.onchange=()=>{if(check.checked)picked.add(t.id);else picked.delete(t.id);count.textContent='已选 '+picked.size+' / '+c.targets.length;};
                const detail=node('details'),summary=node('summary','',t.title);
                const m=t.metadata||{},kind=t.kind==='world'?(m.constant?'蓝灯':m.vectorized?'向量':'绿灯')+' · '+t.world+' · 深度 '+(m.depth??4)+' · 顺序 '+(m.order??100):t.kind.toUpperCase();
                detail.append(summary,node('small','mn-hint',kind+(m.disable?' · 已禁用':'')+'\n'+t.id));
                let loaded=false;detail.ontoggle=()=>{if(detail.open&&!loaded){loaded=true;detail.append(node('pre','mn-wb-prose',t.content||'（空）'),node('pre','mn-wb-meta',JSON.stringify(t.metadata||{},null,2)));}};
                item.append(check,detail);list.append(item);
            }
            if(matches.length>shown)list.append(button('再显示50项',()=>{shown+=50;draw();}));
        }
        search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{shown=50;draw();},120);};
        el.addEventListener('close',()=>clearTimeout(timer),{once:true});
        body.append(button('使用所选材料',this.guard(async()=>{
            if(!locked)await c.select(picked);
            el.close();this.render();
        }),'mn-primary'));draw();
    }
    async tasks(){
        const c=this.controller,{body}=this.dialog('任务记录'),list=node('div','mn-entries');body.append(list);let cursor;
        const load=async()=>{
            const jobs=await c.api.storage.listJobs(c.scope,{limit:30,before:cursor});
            for(const job of jobs)list.append(button((job.mode==='archive'?'归档':'自由')+' · '+job.firstFloor+'–'+job.lastFloor+'楼 · '+(labelStatus[job.status]||job.status)+'\n'+date(job.createdAt),this.guard(async()=>{await c.resume(job.id);this.modal?.close();this.render();}),'mn-entry'));
            cursor=jobs.at(-1);more.hidden=jobs.length<30;
            if(!jobs.length&&!cursor)list.append(node('p','mn-empty','还没有工作台任务'));
        };
        const more=button('查看更多',this.guard(load));body.append(more);await load();
    }
    async snapshots(){
        const c=this.controller,{body}=this.dialog('旧快照'),picked=new Set(),list=node('div','mn-entries');let cursor;
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
        for(const [key,label] of [['temperature','温度'],['maxTokens','最大输出 token'],['contextSize','上下文 token'],['timeoutSec','超时（秒）']]){
            const control=input(s.generation[key],'');control.type='number';if(key==='temperature')control.step='0.1';controls[key]=control;grid.append(field(label,control));
        }
        const stream=input('','');stream.type='checkbox';stream.checked=s.generation.stream;grid.append(field('流式显示',stream));
        const reasoning=select([['','由模型默认'],['none','none'],['low','low'],['medium','medium'],['high','high'],['xhigh','xhigh']],s.generation.reasoningEffort||'');grid.append(field('推理强度',reasoning));body.append(grid);
        body.append(node('h4','','独立 API 通道'),node('p','mn-hint','支持 OpenAI 兼容聊天补全接口。密钥只保存在本机插件设置中，不随快照或任务导出。'));
        const channels=node('div','mn-wb-channels');body.append(channels);
        const renderChannels=()=>{
            channels.replaceChildren();
            for(const channel of s.channels){
                const card=node('fieldset','mn-wb-channel');card.append(node('legend','',channel.name||'新 API'));
                for(const [key,label,placeholder] of [['name','名称','例如：归档助手'],['url','API 地址','https://example.com/v1'],['model','模型','模型标识'],['key','密钥','API Key']]){
                    const control=input(channel[key]||'',placeholder);if(key==='key'){control.type='password';control.autocomplete='off';}
                    control.oninput=()=>{channel[key]=control.value;};card.append(field(label,control));
                }
                card.append(button('移除此通道',()=>{s.channels=s.channels.filter(x=>x.id!==channel.id);if(s.sourceId===channel.id)s.sourceId='main';renderChannels();}));channels.append(card);
            }
        };renderChannels();
        body.append(button('添加 API',()=>{s.channels.push({id:makeId('api'),name:'',url:'',model:'',key:''});renderChannels();}));
        const days=input(s.retentionDays,'30');days.type='number';days.min='1';body.append(field('旧快照保留天数',days));
        const prompts=node('details');prompts.append(node('summary','','职责说明与常用任务提示词'));
        const styleCheck=input('','');styleCheck.type='checkbox';styleCheck.checked=s.validateArchiveStyle!==false;
        prompts.append(field('检查归档草案文风（单条800字、禁用“了”）',styleCheck),node('p','mn-hint','改用其他归档写法时可关闭；正式编号重复与写入冲突仍会检查。审核中的人工修订不受文风检查限制。'));
        const promptControls=[];
        for(const [group,key,label] of [['duties','common','共同职责'],['duties','archive','归档模式职责'],['duties','free','自由模式职责'],['tasks','plan','归档规划提示'],['tasks','archiveBatch','逐批归档提示'],['tasks','free','自由模式提示']]){
            const control=input(s[group][key],'',true);control.classList.add('mn-wb-prompt');prompts.append(field(label,control));promptControls.push({group,key,control});
        }
        prompts.append(button('恢复内置职责和任务提示',()=>{for(const p of promptControls)p.control.value=DEFAULT_SETTINGS[p.group][p.key];}));
        body.append(prompts,button('保存设置',this.guard(async()=>{
            for(const [key,control] of Object.entries(controls))s.generation[key]=Number(control.value);
            s.generation.stream=stream.checked;s.generation.reasoningEffort=reasoning.value;s.retentionDays=Number(days.value);
            s.validateArchiveStyle=styleCheck.checked;
            for(const p of promptControls)s[p.group][p.key]=p.control.value;
            await c.saveSettings(s);el.close();this.render();
        }),'mn-primary'));
    }
}
export function createWorkbench(root,options){return new WorkbenchView(root,options);}
