import { button, field, input, node } from '../dom.js';
import { clone } from './model.js';
import { diffText } from './diff-worker.js';

export function createDiffer(receive){
    let worker,seq=0,disposed=false,latest;
    const fallback=(before,after,id)=>queueMicrotask(()=>{
        if(!disposed&&id===seq)receive(before.length+after.length>50000?[{type:'remove',text:before},{type:'add',text:after}]:diffText(before,after));
    });
    try{if(typeof Worker!=='undefined')worker=new Worker(new URL('./diff-worker.js',import.meta.url),{type:'module'});}catch{}
    const failed=()=>{
        worker?.terminate();worker=null;
        if(latest)fallback(latest.before,latest.after,latest.id);
    };
    if(worker){
        worker.onmessage=e=>{if(!disposed&&e.data.id===seq)receive(e.data.segments);};
        worker.onerror=event=>{event?.preventDefault?.();failed();};
    }
    return {
        update(before,after){
            latest={id:++seq,before,after};
            if(worker){try{worker.postMessage(latest);}catch{failed();}}
            else fallback(before,after,seq);
        },
        dispose(){disposed=true;latest=null;worker?.terminate();},
    };
}

function paint(container,segments,side){
    const fragment=document.createDocumentFragment();
    for(const segment of segments){
        if(side==='old'&&segment.type==='add'||side==='new'&&segment.type==='remove')continue;
        fragment.append(node('span',segment.type==='same'?'':'mn-wb-'+segment.type,segment.text));
    }
    // The extra newline keeps a final editable blank line aligned with the textarea.
    if(side==='new')fragment.append(document.createTextNode('\n'));
    container.replaceChildren(fragment);
}
const row=(...children)=>{const el=node('div','mn-row');el.append(...children);return el;};
function nativeSelect(options,value){
    const select=node('select');for(const [id,label] of options){const o=node('option','',label);o.value=String(id);select.append(o);}select.value=String(value);return select;
}
export function metadataEditor(item){
    const grid=node('div','mn-wb-properties'),metadata=item.after?.metadata;if(!metadata||item.target.kind!=='world')return grid;
    const labels={comment:'条目名称',outletName:'Outlet 名称',key:'主关键词（每行一个）',keysecondary:'次关键词（每行一个）',position:'插入位置',depth:'深度',order:'顺序',role:'注入角色',disable:'禁用条目'};
    const change=(name,control,read=()=>control.value)=>{control.addEventListener('change',()=>{metadata[name]=read();});grid.append(field(labels[name]||name,control));};
    change('comment',input(metadata.comment||'','条目名称'));
    change('outletName',input(metadata.outletName||'','仅 Outlet 位置需要'));
    const keys=input((metadata.key||[]).join('\n'),'每行一个关键词',true);change('key',keys,()=>keys.value.split('\n').map(s=>s.trim()).filter(Boolean));
    const second=input((metadata.keysecondary||[]).join('\n'),'每行一个次关键词',true);change('keysecondary',second,()=>second.value.split('\n').map(s=>s.trim()).filter(Boolean));
    const light=nativeSelect([['blue','蓝灯 · 常驻'],['green','绿灯 · 关键词'],['vector','向量']],metadata.constant?'blue':metadata.vectorized?'vector':'green');
    light.onchange=()=>{metadata.constant=light.value==='blue';metadata.vectorized=light.value==='vector';};grid.append(field('灯号',light));
    const position=nativeSelect([[0,'角色前'],[1,'角色后'],[2,'作者注前'],[3,'作者注后'],[4,'指定深度'],[5,'示例前'],[6,'示例后'],[7,'Outlet']],metadata.position??0);
    change('position',position,()=>Number(position.value));
    for(const key of ['depth','order']){
        const fallback=item.after.raw&&Object.hasOwn(item.after.raw,key)?item.after.raw[key]:(key==='depth'?4:100);
        const el=input(metadata[key]??'',item.action==='create'?'TT 默认':'');el.type='number';
        change(key,el,()=>item.action==='create'&&el.value===''?fallback:Number(el.value));
    }
    const role=nativeSelect([['','不适用'],[0,'system'],[1,'user'],[2,'assistant']],position.value==='4'?(metadata.role??0):'');
    role.firstElementChild.disabled=true;
    role.disabled=position.value!=='4';
    change('role',role,()=>Number(role.value));
    position.addEventListener('change',()=>{
        role.disabled=position.value!=='4';
        metadata.role=role.disabled?null:([0,1,2].includes(metadata.role)?metadata.role:0);
        role.value=role.disabled?'':String(metadata.role);
    });
    const disabled=input('','');disabled.type='checkbox';disabled.checked=!!metadata.disable;change('disable',disabled,()=>disabled.checked);
    return grid;
}
export function reviewBatch(view){
    const c=view.controller,batch=c.currentBatch();if(!batch?.items?.length)throw Error('当前没有完整的待审核改动');
    if(c.running||c.starting||c.saving)throw Error('请等待本批生成或保存完成后再审核');
    const expected={jobId:c.job.id,batchId:batch.id};
    const items=clone(batch.items),{el,body}=view.dialog('审核本批修改','mn-wb-review');
    let index=Math.min(batch.reviewIndex||0,items.length-1),differ,typingTimer,persistTimer,editor,composing=false,busy=false;
    let saveDraftOnClose=true;
    const draft=()=>c.saveDraft(items,index,expected).catch(e=>view.error(e));
    const cleanup=()=>{clearTimeout(typingTimer);clearTimeout(persistTimer);differ?.dispose();};
    el.addEventListener('close',()=>{cleanup();if(saveDraftOnClose)draft();},{once:true});
    const remember=()=>{clearTimeout(persistTimer);if(saveDraftOnClose)persistTimer=setTimeout(draft,900);};
    function render(){
        cleanup();body.replaceChildren();const item=items[index];
        const outcome=batch.outcomes?.find(o=>o.itemId===item.id||o.id===item.id),applied=outcome?.status==='applied',locked=applied||!!outcome?.snapshotId,skipLocked=applied||outcome?.status==='unknown';
        const title=node('h4','',item.title||item.target.id);
        const kind=item.target.kind==='world'?'世界书 · '+item.target.world:item.target.kind==='user'?'User 设定':'Char 设定';
        body.append(node('small','mn-hint','第'+(batch.index+1)+' / '+c.job.batches.length+'批 · '+kind),title);
        if(item.reason)body.append(node('p','mn-hint',item.reason));
        if(outcome&&outcome.status!=='skipped')body.append(node('p',applied?'mn-hint':'mn-error',applied?'本项已保存，重试时自动跳过。如需撤销，请在旧快照中创建回退草案。':outcome.error||({prepared:'已记录保存意图，尚待核对最终写入结果。',unknown:'写入结果尚不明确，重试会先核对原保存意图。',failed:'本项保存失败，可重试或跳过。',conflict:'目标内容已变化，请核对后处理。'}[outcome.status]||outcome.status)));
        const old=node('pre','mn-wb-diff mn-wb-old'),oldSection=node('details','mn-wb-old-section');
        oldSection.open=true;oldSection.append(node('summary','','旧内容 · 红色为删除'),old);body.append(oldSection);
        const after=item.after?.content??'';
        const highlight=node('pre','mn-wb-highlight');
        editor=input(after,'点击这里直接编辑最终内容',true);editor.classList.add('mn-wb-editor');editor.spellcheck=false;
        editor.setAttribute('aria-label','最终内容，可直接编辑');
        const wrap=node('div','mn-wb-editor-wrap mn-wb-editing');wrap.append(highlight,editor);
        differ=createDiffer(segments=>{paint(old,segments,'old');paint(highlight,segments,'new');wrap.classList.remove('mn-wb-editing');});
        const update=()=>differ.update(item.before?.content||'',item.after?.content||'');
        editor.onscroll=()=>{highlight.scrollTop=editor.scrollTop;highlight.scrollLeft=editor.scrollLeft;};
        editor.oncompositionstart=()=>{composing=true;wrap.classList.add('mn-wb-editing');};
        editor.oncompositionend=()=>{composing=false;changed();};
        function changed(){
            if(item.after)item.after.content=editor.value;wrap.classList.add('mn-wb-editing');clearTimeout(typingTimer);
            if(!composing)typingTimer=setTimeout(update,180);remember();
        }
        editor.oninput=changed;
        if(item.action==='delete')body.append(node('p','mn-wb-remove','本项将删除；完整旧内容会保存在快照中。'));
        else{body.append(node('small','mn-hint','最终内容 · 绿色为新增 · 点击文字即可编辑'),wrap);editor.readOnly=locked;}
        if(item.target.kind==='world'){
            const details=node('details');details.append(node('summary','','条目属性变化与编辑'));
            const metaBefore=node('pre','mn-wb-meta'),metaAfter=node('pre','mn-wb-meta');
            const showMetadata=()=>{
                const a=JSON.stringify(item.before?.metadata||{},null,2),b=JSON.stringify(item.after?.metadata||{},null,2);
                const segments=a.length+b.length>50000?[{type:'remove',text:a},{type:'add',text:b}]:diffText(a,b);paint(metaBefore,segments,'old');paint(metaAfter,segments,'new');
            };
            details.append(node('small','mn-hint','修改前'),metaBefore,node('small','mn-hint','修改后'),metaAfter);
            details.open=JSON.stringify(item.before?.metadata)!==JSON.stringify(item.after?.metadata);
            details.addEventListener('change',showMetadata);showMetadata();
            if(item.after){const props=metadataEditor(item);props.addEventListener('change',remember);details.append(props);if(locked)for(const el of props.querySelectorAll('input,textarea,select'))el.disabled=true;}
            body.append(details);
        }
        const skipped=node('small','mn-hint',item.accepted===false?'本项已选择跳过，其他修改仍可保存。':'');
        body.append(skipped);
        const footer=node('div','mn-wb-review-footer'),progress=node('small','mn-hint','待处理 '+(index+1)+' / '+items.length);
        const back=button('上一个',view.guard(async()=>{await draft();index--;render();}));back.disabled=index===0;
        const skip=button(item.accepted===false?'改为通过':'跳过本项',view.guard(async()=>{
            item.accepted=item.accepted===false;await draft();
            if(item.accepted===false&&index<items.length-1){index++;render();}else render();
        }));skip.disabled=skipLocked;
        const next=button(index===items.length-1?(batch.patchRepair?'暂存并返回':'全部保存'):'继续下一个',view.guard(async()=>{
            if(busy)return;busy=true;clearTimeout(persistTimer);next.disabled=skip.disabled=back.disabled=true;
            const final=index===items.length-1;
            // The final submit persists this draft and owns the close, including partial saves.
            // Native dialogs may deliver 'close' after this handler's finally has run.
            if(final){saveDraftOnClose=false;body.inert=true;}
            try{
                if(item.accepted!==false)item.accepted=true;
                if(!final){await c.saveDraft(items,index,expected);index++;render();}
                else if(batch.patchRepair){
                    await c.saveDraft(items,index,expected);el.close();view.render();
                }else{
                    const result=await c.saveReviewed(items,expected);
                    if(result.complete){el.close();view.render();view.notice('本批已保存'+(c.job.status==='done'?'，本次任务完成。':'，可以继续下一批。'));}
                    else{el.close();view.render();view.notice('部分项未保存，可重新打开审核查看原因。');}
                }
            }finally{busy=false;if(el.open){saveDraftOnClose=true;body.inert=false;next.disabled=false;skip.disabled=skipLocked;back.disabled=index===0;}}
        }),'mn-primary');
        footer.append(progress,row(back,skip,next));body.append(footer);update();
    }
    render();return el;
}
export function snapshotDiff(view,snapshot){
    const {el,body}=view.dialog('快照原文与修改','mn-wb-review');
    body.append(node('h4','',snapshot.title||snapshot.target?.id||'快照'));
    const before=snapshot.before?.content||'',after=snapshot.after?.content||'';
    const old=node('pre','mn-wb-diff'),next=node('pre','mn-wb-diff');
    body.append(node('small','mn-hint','旧版本'),old,node('small','mn-hint','新版本'),next);
    const diff=createDiffer(segments=>{paint(old,segments,'old');paint(next,segments,'new');});
    const properties=node('details');properties.append(node('summary','','属性与完整原始记录'));
    let propertyDiff,loaded=false;
    properties.ontoggle=()=>{
        if(!properties.open||loaded)return;loaded=true;
        const oldMeta=node('pre','mn-wb-diff mn-wb-meta'),newMeta=node('pre','mn-wb-diff mn-wb-meta');
        properties.append(node('small','mn-hint','旧属性'),oldMeta,node('small','mn-hint','新属性'),newMeta);
        propertyDiff=createDiffer(segments=>{paint(oldMeta,segments,'old');paint(newMeta,segments,'new');});
        const metadata=value=>value?JSON.stringify({metadata:value.metadata,raw:value.raw,original:value.original},null,2):'（条目不存在）';
        propertyDiff.update(metadata(snapshot.before),metadata(snapshot.after));
    };
    body.append(properties);
    diff.update(before,after);el.addEventListener('close',()=>{diff.dispose();propertyDiff?.dispose();},{once:true});return {el,body};
}
