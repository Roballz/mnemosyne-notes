import { button, input, node } from '../dom.js';
import { interruptedArchiveSetup, materialSelection, selectedIds } from './model.js';

const groupRow=(...children)=>{const el=node('div','mn-wb-material-toolbar');el.append(...children);return el;};

/** One local catalogue read per opening; expanding, checking and searching do
 * not read the host or rebuild the workbench's chat history. */
export async function openMaterials(view) {
    const c=view.controller;
    await c.refreshTargets();
    const {el,body}=view.dialog('选择工作台材料');
    const setup=interruptedArchiveSetup(c.job);
    const locked=!!(c.job&&!['done','abandoned','draft'].includes(c.job.status)&&!setup);
    const source=locked||setup?c.job:{selectedTargetIds:[...c.selected],enabledWorlds:c.enabledWorlds?[...c.enabledWorlds]:c.state?.enabledWorlds};
    const names=[...new Set([...(c.scope?.worldNames||[]),...(c.worlds||[]).map(w=>w.name),...c.targets.filter(t=>t.kind==='world').map(t=>t.world)])];
    const {selected:picked,enabledWorlds:enabled}=materialSelection(c.targets,source,names);
    const books=new Map(names.map(name=>[name,[]])),people=[];
    for(const target of c.targets){if(target.kind==='world'){if(books.has(target.world))books.get(target.world).push(target);}else people.push(target);}
    const targetIndex=new Map(c.targets.map(target=>[target.id,target]));
    const search=input('','搜索世界书、条目或关键词');
    search.setAttribute('aria-label','搜索工作台材料');
    const count=node('small','mn-hint mn-wb-material-count'),list=node('div','mn-wb-material-groups');
    let searchTimer,shownBooks=20;
    const opened=new Set(['__people']);
    const countSelected=targets=>targets.reduce((total,target)=>total+Number(picked.has(target.id)),0);
    const updateCount=()=>{count.textContent=`已启用 ${enabled.size} 本世界书 · 已选 ${picked.size} 项材料`;};
    const allowed=target=>target.kind!=='world'||enabled.has(target.world);
    const applyPreset=mode=>{
        picked.clear();
        const defaults=selectedIds(c.targets);
        if(mode!=='none')for(const target of c.targets)if(allowed(target)&&(mode==='all'||defaults.has(target.id)))picked.add(target.id);
        draw();
    };
    const actions=groupRow();
    for(const [label,mode] of [['全选已启用','all'],['全部取消','none'],['选择常驻项','default']]){
        const action=button(label,()=>applyPreset(mode));action.disabled=locked;actions.append(action);
    }
    body.append(node('p','mn-hint',locked?'当前任务材料已固定。开始新任务后可以调整。':'先启用世界书，再勾选要发送的条目。未启用的世界书不作为材料，也不能创建或修改其中的条目。'),search,actions,count,list);

    function entry(target,bookEnabled,onChange) {
        const item=node('div','mn-wb-material'),check=input('','');
        check.type='checkbox';check.checked=picked.has(target.id);check.disabled=locked||!bookEnabled;
        check.setAttribute('aria-label','选择 '+target.title);
        check.onchange=()=>{if(check.checked)picked.add(target.id);else picked.delete(target.id);updateCount();onChange();};
        const detail=node('details','mn-wb-material-entry'),summary=node('summary','',target.title);
        const metadata=target.metadata||{};
        detail.append(summary,node('small','mn-hint',target.kind==='world'
            ?(metadata.constant?'常驻蓝灯':metadata.vectorized?'向量条目':'关键词绿灯')+(metadata.disable?' · 正文中已禁用':'')
            :target.kind==='user'?'用户设定':'角色设定'));
        let loaded=false;
        detail.ontoggle=()=>{
            if(!detail.open||loaded)return;
            loaded=true;
            detail.append(node('div','mn-wb-material-preview',target.content||'（空）'));
            if(target.kind==='world')detail.append(node('small','mn-hint',`关键词：${(metadata.key||[]).join('、')||'无'} · 深度 ${metadata.depth??4} · 顺序 ${metadata.order??100}`));
        };
        item.append(check,detail);return item;
    }
    function group(name,targets,matches,isPeople=false,searching=false,autoOpen=false) {
        const key=isPeople?'__people':name;
        const wrapper=node('section','mn-wb-material-group');
        wrapper.dataset.kind=isPeople?'identity':'world';
        const details=node('details','mn-wb-book'),summary=node('summary','mn-wb-book-heading');
        const label=node('span','mn-wb-book-name',name),selectedCount=node('small','mn-hint'),contents=node('div','mn-wb-book-entries');
        let shown=40,check,drawn=false;
        const updateGroupCount=()=>{selectedCount.textContent=(isPeople?'':enabled.has(name)?'已启用 · ':'未启用 · ')+countSelected(targets)+' / '+targets.length+(searching?' · 匹配 '+matches.length:'');};
        if(!isPeople){
            check=input('','');check.type='checkbox';check.checked=enabled.has(name);check.disabled=locked;
            check.setAttribute('aria-label','启用世界书 '+name);
            check.onclick=event=>event.stopPropagation();
            check.onchange=()=>{
                if(check.checked){enabled.add(name);details.open=true;opened.add(key);}
                else{enabled.delete(name);for(const target of targets)picked.delete(target.id);}
                updateCount();updateGroupCount();drawEntries();
            };
            summary.append(check);
        }
        summary.append(label,selectedCount);details.append(summary,contents);wrapper.append(details);
        function drawEntries() {
            drawn=true;contents.replaceChildren();
            const active=isPeople||enabled.has(name);
            if(!active)contents.append(node('p','mn-hint','启用这本世界书后选择条目。当前不会发送其中的内容。'));
            if(!isPeople&&active){
                const controls=groupRow();
                for(const [text,predicate] of [['全选本书',()=>true],['选择蓝灯',t=>!!t.metadata?.constant&&!t.metadata?.disable],['取消本书',()=>false]]){
                    const action=button(text,()=>{for(const target of targets){if(predicate(target))picked.add(target.id);else picked.delete(target.id);}updateCount();updateGroupCount();drawEntries();});
                    action.disabled=locked;controls.append(action);
                }
                contents.append(controls);
            }
            for(const target of matches.slice(0,shown))contents.append(entry(target,active,updateGroupCount));
            if(matches.length>shown)contents.append(button('再显示40项',()=>{shown+=40;drawEntries();}));
            if(!matches.length)contents.append(node('p','mn-hint',searching?'没有匹配的条目':'这本世界书暂无条目；启用后可由助手提交新建草案。'));
        }
        details.ontoggle=()=>{if(details.open){opened.add(key);if(!drawn)drawEntries();}else opened.delete(key);};
        details.open=opened.has(key)||autoOpen;
        updateGroupCount();
        if(details.open)drawEntries();
        return wrapper;
    }
    function draw() {
        updateCount();list.replaceChildren();
        const query=search.value.trim().toLocaleLowerCase();
        const matches=target=>!query||(target.title+' '+target.id+' '+(target.metadata?.key||[]).join(' ')).toLocaleLowerCase().includes(query);
        const personal=people.filter(matches);
        if(personal.length)list.append(group('User 与 Char 设定',people,personal,true,!!query));
        const visible=[];
        for(const [name,targets] of books){
            const found=!query||name.toLocaleLowerCase().includes(query)?targets:targets.filter(matches);
            if(!query||name.toLocaleLowerCase().includes(query)||found.length)visible.push({name,targets,found});
        }
        // Searching many books must not instantiate hundreds of entry previews
        // in one frame. More matching books stay as compact expandable headers.
        for(const [index,book] of visible.slice(0,shownBooks).entries())list.append(group(book.name,book.targets,book.found,false,!!query,!!query&&index<3));
        if(visible.length>shownBooks)list.append(button('再显示20本世界书',()=>{shownBooks+=20;draw();}));
        if(!personal.length&&!visible.length)list.append(node('p','mn-empty','没有匹配的材料'));
    }
    search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{shownBooks=20;draw();},120);};
    el.addEventListener('close',()=>clearTimeout(searchTimer),{once:true});
    const save=button(locked?'关闭':'使用所选材料',view.guard(async()=>{
        if(!locked){
            // Apply both permissions together; stale selected IDs cannot enable a book.
            const effective=new Set([...picked].filter(id=>{const target=targetIndex.get(id);return target&&allowed(target);}));
            await c.select(effective,enabled);
        }
        el.close();view.render();
    }),'mn-primary');
    body.append(save);draw();
    return el;
}
