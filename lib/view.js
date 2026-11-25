import { FloorSettings } from './floor-settings.js';
import { readingModes } from './reading-preview.js';
import { catalog, putNode, rootDirectory, splitPeople } from './catalog.js';
import { manage, editDirectory } from './directory-ui.js';
import { enableSwipeToClose } from './drawer.js';
import { fontSettings } from './font-settings.js';
import { bubbleSettings } from './appearance.js';
import * as db from './db.js';
import { digest, identity, lines, matchSource, tagPage, touchTags, unique, validToken } from './model.js';
import { parseFilter, validateRule } from './extract.js';
import { button, field, icon, iconButton, input, node, reader, select } from './dom.js';

const dimensions = {person:'人物',folder:'合集',tag:'关键词'};
const section = (title) => node('h3','mn-section',title);
const row = (...children) => { const el=node('div','mn-row');el.append(...children);return el; };
const choice = (label,active,fn) => {
    const b=button(label,fn,'mn-chip');b.setAttribute('aria-pressed',String(active));return b;
};
function dateOf(value) {
    return value?.match(/\d{2,4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}日?/)?.[0] || value?.split(/[ T]/)[0] || '';
}
function day(row) {
    const a=dateOf(row.start), b=dateOf(row.end);
    return a && b && a!==b ? a+' 至 '+b : a || b || '剧情日期未标注';
}
export class View {
    constructor(root,prefs,savePrefs,connect,version) {
        Object.assign(this,{root,prefs,savePrefs,connect,version,tab:'note',mode:'all',blockMode:'folder',path:[],filters:{},seq:0});
        this.panel=node('section','mn-panel');this.panel.setAttribute('aria-label','Mnemosyne记事簿');
        this.scrim=button('',()=>this.close(),'mn-scrim');this.scrim.setAttribute('aria-label','关闭记事簿');
        this.panel.inert=true;
        const brand=node('div','mn-brand');brand.append(icon('book'),node('h2','','Mnemosyne记事簿'));
        this.panel.append(row(brand,button('工作台',()=>this.openWorkbench?.(),'mn-link'),iconButton('关闭','close',()=>this.close())));
        this.nav=node('nav','mn-nav');
        for(const [id,label,key] of [['note','收藏','mark'],['block','消息','inbox'],['settings','设置','settings']]) {
            const b=button(label,()=>{if(id==='settings')this.version?.check(true);this.tab=id;this.path=[];this.filters={};this.render();});
            b.prepend(icon(key));b.dataset.tab=id;this.nav.append(b);
            if(id==='settings'&&version)version.indicator=b;
        }
        this.content=node('div','mn-content');this.status=node('div','mn-status');
        this.progressLabel=node('span');this.floorSettings=new FloorSettings(this);
        this.status.append(this.progressLabel,this.floorSettings.group);
        this.panel.append(this.nav,this.content,this.status);root.append(this.scrim,this.panel);
        enableSwipeToClose(this);
    }
    setEngine(engine) {
        this.floorSettings.clear();this.progressLabel.textContent='';
        this.root.querySelector('.mn-picker')?.remove();this.root.querySelector('.mn-confirm-dialog')?.remove();clearTimeout(this.refreshTimer); this.seq++;this.modal?.remove();this.modal=null;
        this.toastNode?.remove();this.engine=engine;this.filters={};this.path=[];
        if(this.opened){this.render();this.changed('progress');this.floorSettings.refresh();}
    }
    guard(fn) { return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>this.error(e)); }
    open() {
        if(this.tab==='settings')this.version?.check(true);
        this.opened=true;this.panel.inert=false;this.root.dataset.open='yes';
        const current=this.engine;
        this.guard(async()=>{const engine=await this.connect();if(this.opened && current && current===engine){engine.open();this.floorSettings.refresh();}})();
        this.render(); this.panel.querySelector('button')?.focus({preventScroll:true});
    }
    close() {
        this.floorSettings.clear();
        this.root.querySelector('.mn-picker')?.remove();this.root.querySelector('.mn-confirm-dialog')?.remove();this.modal?.remove();this.modal=null;this.opened=false;this.seq++;
        this.root.dataset.open='no';this.panel.inert=true;this.panel.style.removeProperty('transform');
    }
    error(e) {
        const text=e?.message || String(e);
        if(this.modal?.open) {
            let message=this.modal.querySelector('.mn-error');
            if(!message){message=node('p','mn-error');message.setAttribute('role','alert');this.modal.querySelector('.mn-dialog-body').prepend(message);}
            message.textContent=text;message.scrollIntoView?.({block:'nearest'});
        } else this.toast(text,null,true);
    }
    toast(text,fn,persistent=false) {
        clearTimeout(this.toastTimer); this.toastNode?.remove();
        const el=fn ? button('',()=>{el.remove();this.guard(fn)();},'mn-toast mn-glass') : node('div','mn-toast mn-glass');
        el.append(node('span','mn-toast-text',text));
        el.setAttribute('role','status'); this.root.append(el);this.toastNode=el;
        this.toastTimer=setTimeout(()=>el.remove(),persistent || fn ? 7000 : 2900);
    }
    notice(floor,scan) {
        if (!scan.rows.length) return this.toast('#'+floor+' 检出 div，未匹配外层标记');
        const unknown=scan.rows.filter(r=>!r.folders.length), known=scan.rows.filter(r=>r.folders.length);
        const clauses=[];
        if(known.length) clauses.push(known.length===1 ? known[0].name+' → '+known[0].folders.map(catalog(this.engine.book,'folder').title).join('、') : known.length+' 个消息块已归入合集');
        if(unknown.length) clauses.push(unknown[0].name+(unknown.length>1?' 等 '+unknown.length+' 项':'')+'待归类');
        this.toast('#'+floor+' · '+clauses.join('，'),unknown.length ? ()=>this.assign({...unknown[0],floor}) : null);
    }
    changed(kind) {
        if(!this.opened || !this.engine?.book) return;
        const p=this.engine.progress, n=this.engine.host.size();
        this.progressLabel.textContent=p.revisit!=null ? '正在更新已有消息的分类' : p.back ? '正在整理历史 · '+(p.next+p.target-p.back)+' / '+n+' 楼' :
            (p.next>=n?'历史已整理':'已整理 '+p.next+' / '+n+' 楼');
        if (kind==='progress' || this.tab==='settings' || this.modal) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer=setTimeout(()=>{if(this.opened&&!this.modal&&!this.content.querySelector('.mn-batch-active'))this.render();},100);
    }
    async render() {
        const seq=++this.seq, e=this.engine;
        for(const b of this.nav.children) b.setAttribute('aria-current',String(b.dataset.tab===this.tab));
        if(!this.opened) return;
        if(this.tab==='settings'){this.content.replaceChildren(this.settings(e));return;}
        if(!e?.book) {this.content.replaceChildren(node('p','mn-empty','打开聊天后即可查看记事簿'));this.progressLabel.textContent='';return;}
        try {
            const page=node('div','mn-page'), kind=this.tab;
            const title=node('h3','mn-title',kind==='note'?'楼层收藏':'消息摘录');
            page.append(row(title,button('目录管理',()=>manage(this,this.path.at(-1)?.dim || ((kind==='note'?this.mode:this.blockMode)==='person'?'person':'folder')),'mn-link')));
            const modes=node('div','mn-modes');
            const mode=kind==='note'?this.mode:this.blockMode;
            for(const [id,label] of [['all','全部'],['person','按人物'],['folder','按合集']])
                modes.append(choice(label,mode===id,()=>{
                    if(kind==='note')this.mode=id;else this.blockMode=id;
                    this.path=[];this.filters={};this.render();
                }));
            page.append(modes);
            const second=mode==='folder'?'person':'folder';
            const cats={folder:catalog(e.book,'folder'),person:catalog(e.book,'person')};
            const display=(dim,id)=>cats[dim]?.label(id) || id || '未分类';
            const active={...this.filters};
            for(const step of this.path)active[step.dim]=step.id;
            const current=this.path.at(-1);
            if(current) {
                const back=button('‹  '+[mode,second].filter(d=>active[d]!=null).map(d=>display(d,active[d])).join('  ›  '),
                    ()=>{this.path.pop();this.render();},'mn-back');
                const controls=row(back);page.append(controls);
                if(current.id)controls.append(button('编辑目录',()=>editDirectory(this,current.dim,current.id),'mn-link'));
            }
            async function children(dim,parent,other) {
                const names=await db.groups(e.key,kind,dim,other);
                const ids=new Set(),cat=cats[dim];
                for(const key of names){
                    if(dim==='folder' && key && !cat.byId.has(key) && e.progress.revisitFolder===key)continue;
                    if(!key){if(parent==null)ids.add('');continue;}
                    const path=cat.path(key);
                    if(parent==null)ids.add(path[0]);
                    else {const i=path.indexOf(parent);if(i>=0 && i+1<path.length)ids.add(path[i+1]);}
                }
                return [...ids].sort((a,b)=>cat.title(a).localeCompare(cat.title(b),'zh'));
            }
            const showGroups=(dim,ids)=>{
                if(!ids.length)return;
                const grid=node('div','mn-grid');
                for(const id of ids){
                    const b=button('',()=>{this.path.push({dim,id});this.render();},'mn-group');
                    b.append(icon(dim==='person'?'people':'folder'),node('strong','',cats[dim].title(id)),icon('arrow'));grid.append(b);
                }
                page.append(grid);
            };
            if(mode!=='all'){
                const dim=current?.dim || mode;
                const [dirs,cross]=await Promise.all([
                    children(dim,current?.id,dim===second?active[mode]:undefined),
                    kind==='note' && current?.dim===mode?children(second,null,active[mode]):[]
                ]);
                if(seq!==this.seq)return;
                showGroups(dim,dirs);
                if(cross.length){page.append(section('按'+dimensions[second]+'查看'));showGroups(second,cross);}
                if(!current && !dirs.length)page.append(node('p','mn-empty',kind==='note'?'收藏楼层后，可在这里按标签浏览。':'尚无消息摘录。可先建目录和识别规则。'));
            }
            if(mode==='all' || current) {
                if(kind==='note'){
                    const bar=node('div','mn-filter'),dims=Object.keys(dimensions).filter(dim=>!this.path.some(p=>p.dim===dim));
                    const options=await Promise.all(dims.map(dim=>db.groups(e.key,kind,dim)));
                    dims.forEach((dim,i)=>{
                        const s=select([['*',dimensions[dim]+' · 全部'],...options[i].map(v=>['='+v,display(dim,v)])],
                            this.filters[dim]==null?'*':'='+this.filters[dim],v=>{
                                if(v==='*')delete this.filters[dim];else this.filters[dim]=v.slice(1);this.render();
                            });s.setAttribute('aria-label',dimensions[dim]+'筛选');bar.append(s);
                    });page.append(bar);
                }
                const ignored=kind==='block' && e.book.ignoreNames.length?new Set(e.book.ignoreNames):null;
                const entries=node('div','mn-entries');
                let selected, batchAction;
                const updateCount=()=>{
                    batchAction.textContent='加入合集（'+selected.size+'）';
                    batchAction.disabled=!selected.size;
                };
                if(kind==='block' && active.folder===''){
                    const controls=node('div','mn-row');
                    const toggle=button('多选',()=>{
                        selected=selected ? null : new Map();
                        controls.classList.toggle('mn-batch-active',!!selected);
                        toggle.textContent=selected?'取消多选':'多选';
                        batchAction.hidden=!selected;
                        for(const b of entries.querySelectorAll('.mn-entry')){
                            if(selected)b.setAttribute('aria-pressed','false');
                            else b.removeAttribute('aria-pressed');
                        }
                        if(selected)updateCount();else this.render();
                    },'mn-link');
                    batchAction=button('',()=>this.assign([...selected.values()]),'mn-link');
                    batchAction.hidden=true;
                    controls.append(toggle,batchAction);page.append(controls);
                }
                page.append(entries);
                let lastDay='';
                const load=async(before)=>{
                    const result=await db.list(e.key,kind,active,before,36,ignored);
                    if(seq!==this.seq||!this.opened)return;
                    if(!before&&!result.rows.length&&!page.querySelector('.mn-group'))entries.append(node('p','mn-empty','这里还没有符合条件的条目'));
                    for(const r of result.rows){
                        if(kind==='block'&&lastDay!==day(r)){lastDay=day(r);entries.append(node('h4','mn-day',lastDay));}
                        const b=button('',this.guard(()=>{
                            if(!selected)return this.detail(r);
                            const key=JSON.stringify(r.key);
                            if(selected.has(key))selected.delete(key);else selected.set(key,r);
                            b.setAttribute('aria-pressed',String(selected.has(key)));
                            updateCount();
                        }),'mn-entry');
                        if(selected)b.setAttribute('aria-pressed','false');
                        const label=node('div','mn-entry-main');
                        label.append(node('strong','',kind==='block'?r.name:r.note||'楼层收藏'),
                            node('small','',[...r.people.map(cats.person.label),...r.folders.map(cats.folder.label),...(r.tags||[]).map(t=>'#'+t)].join(' · ')||'未分类'));
                        b.append(node('span','mn-floor','#'+r.floor),label,icon('arrow'));entries.append(b);
                    }
                    if(result.more){
                        const more=button('查看更多',this.guard(async()=>{more.disabled=true;await load(result.rows.at(-1).order);more.remove();}),'mn-more');
                        entries.append(more);
                    }
                };
                await load(null);
            }
            if(seq===this.seq&&this.opened){this.content.replaceChildren(page);this.changed('progress');}
        } catch(err){if(seq===this.seq)this.error(err);}
    }
    dialog(title) {
        this.root.querySelector('.mn-picker')?.remove();this.root.querySelector('.mn-confirm-dialog')?.remove();this.modal?.remove();
        const el=node('dialog','mn-dialog');
        el.setAttribute('aria-label',title);
        const header=row(node('h3','',title),iconButton('关闭','close',()=>el.close()));
        const body=node('div','mn-dialog-body');el.append(header,body);
        el.addEventListener('close',()=>{if(this.modal===el)this.modal=null;el.remove();},{once:true});
        el.addEventListener('click',ev=>{if(ev.target===el){const r=el.getBoundingClientRect();
            if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)el.close();}});
        this.root.append(el);this.modal=el;el.showModal();
        return {el,body};
    }
    confirmAction(title,message,action,accept) {
        const dialog=node('dialog','mn-dialog mn-confirm-dialog'),body=node('div','mn-dialog-body');
        dialog.setAttribute('aria-label',title);
        const cancel=button('取消',()=>dialog.close()),yes=button(action,this.guard(async()=>{
            yes.disabled=cancel.disabled=true;
            try{await accept();}finally{dialog.close();}
        }),'mn-danger');
        body.append(section(title),node('p','',message),row(cancel,yes));dialog.append(body);
        dialog.addEventListener('close',()=>dialog.remove(),{once:true});
        this.root.append(dialog);dialog.showModal();cancel.focus();
    }
    async bookmark(localFloor,existing) {
        const e=await this.connect();
        if(!e?.book) return this.toast('请先打开聊天');
        if(this.engine!==e || !e.alive())return;
        await e.host.sync();
        let floor,msg;
        if(existing) ({floor,msg}=await e.source(existing,true));
        else {
            if(!Number.isInteger(localFloor)) return this.toast('可视区内没有可收藏的楼层');
            floor=localFloor+e.host.offset;[msg]=await e.host.read(floor,floor+1);
            existing=(await db.notesAt(e.key,floor)).find(n=>matchSource(n,msg));
        }
        if(this.engine!==e||!e.alive())return;

        const marker=msg.mes, savedIdentity=identity(msg);
        const {el,body}=this.dialog(existing?'编辑收藏':'收藏楼层');
        const preview=reader(marker.slice(0,2500)).textContent.trim().slice(0,128);
        body.append(node('span','mn-floor','#'+floor),node('p','mn-preview',preview||'（无文字预览）'));
        const note=input(existing?.note||'','写下要记住的线索…',true);body.append(field('备注',note));
        const people=new Set(existing?.people||[]), folders=new Set(existing?.folders||[]), tags=new Set(existing?.tags||[]);
        const addedPeople=new Map(),addedFolders=new Map();
        function picks(title,names,selected,added){
            const cat=catalog(e.book,title==='人物'?'person':'folder');
            const chips=node('div','mn-chips'), editor=node('div','mn-inline');editor.hidden=true;
            const box=input('','输入新'+title+'名称');
            let showThird=false;
            const draw=()=>{
                const visible=unique([...names,...added.keys(),...selected]).filter(n=>
                    title!=='合集' || showThird || cat.path(n).length<3);
                chips.replaceChildren(...visible.map(n=>choice(added.get(n)?.title || cat.label(n),selected.has(n),()=>{
                    if(selected.has(n))selected.delete(n);else selected.add(n);draw();
                })));
            };
            const add=()=>{
                const title=box.value.trim();if(!title)return;
                const item=[...added.values()].find(n=>n.title===title) || rootDirectory(cat,title);
                if(!cat.byId.has(item.name))added.set(item.name,item);
                selected.add(item.name);box.value='';editor.hidden=true;draw();
            };
            editor.append(box,button('添加',add));
            box.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();add();}};
            const actions=node('div','mn-modes');
            if(title==='合集' && names.some(n=>cat.path(n).length===3)){
                const toggle=choice('显示三级',false,()=>{
                    showThird=!showThird;toggle.setAttribute('aria-pressed',String(showThird));draw();
                });
                actions.append(toggle);
            }
            actions.append(button('＋ 新建',()=>{editor.hidden=!editor.hidden;if(!editor.hidden)box.focus();},'mn-link'));
            body.append(row(section(title),actions),chips,editor);draw();
        }
        picks('人物',unique([...e.book.people,...e.book.folders.flatMap(f=>f.persons || splitPeople(f.person))]),people,addedPeople);picks('合集',e.book.folders.map(f=>f.name),folders,addedFolders);
        let page=0;
        const chips=node('div','mn-chips'), custom=input('','输入关键词，多个可用逗号分隔');
        const draw=()=>{
            const names=unique([...tags,...tagPage(e.book.tags,page)]);
            chips.replaceChildren(...names.map(t=>choice(t,tags.has(t),()=>{
                if(tags.has(t))tags.delete(t);else tags.add(t);draw();
            })));
        };
        const cycle=button('换一批',()=>{page++;draw();},'mn-link');cycle.disabled=e.book.tags.length<=10;
        body.append(row(section('关键词'),cycle),chips,custom);draw();
        const save=button('确认收藏',this.guard(async()=>{
            if(!e.alive()||this.engine!==e)return;
            save.disabled=true;
            try{
                const [current]=await e.host.read(floor,floor+1);
                if(current.mes!==marker||identity(current)!==savedIdentity)throw Error('来源已变化，请重新打开收藏窗口');
                const words=unique([...tags,...custom.value.split(/[，,、\n]/).map(s=>s.trim())]);
                const record={id:existing?.id||crypto.randomUUID(),floor,note:note.value.trim(),
                    people:[...people],folders:[...folders],tags:words,identity:savedIdentity,hash:digest(marker)};
                e.book=await db.saveNote(e.key,record,b=>{
                    for(const item of addedPeople.values())putNode(b,'person',item);
                    for(const item of addedFolders.values())putNode(b,'folder',item);
                    b.people=unique([...b.people,...people]);
                    b.tags=touchTags(b.tags,words);
                });
                if(!e.alive())return;
                el.close();this.toast('已收藏 #'+floor+(folders.size?' · '+[...folders].map(catalog(e.book,'folder').label).join('、'):''));this.changed('live');
            } finally {save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    async detail(r) {
        const e=this.engine,note=r.key[1]==='note';
        const {body,el}=this.dialog(note?'收藏正文':r.name);
        const floorLabel=node('span','mn-floor','#'+r.floor);
        const toolbar=row(floorLabel);
        if(note){
            el.classList.add('mn-note-dialog');toolbar.classList.add('mn-reader-toolbar');
            const edit=button('编辑备注与标签',this.guard(()=>this.bookmark(null,r)),'mn-link');
            const remove=button('取消收藏',this.guard(async()=>{
                if(!confirm('取消这条收藏并移除它的备注与标签？'))return;
                await db.removeNote(e.key,r.id);
                if(e.alive()){el.close();this.toast('已取消收藏');this.render();}
            }),'mn-link');
            const header=el.firstElementChild;
            header.insertBefore(edit,header.lastElementChild);
            header.insertBefore(remove,header.lastElementChild);
            body.append(toolbar);
        }else body.append(floorLabel);
        if(note&&r.note)body.append(node('p','mn-preview',r.note));
        try{
            const {msg,floor}=await e.source(r,note);
            if(!el.open||!e.alive())return;
            floorLabel.textContent='#'+floor;
            if(!note)body.append(node('p','mn-caption',[r.start,r.end].filter(Boolean).join(' → ')||'剧情日期未标注'));
            const source=note?msg.mes:msg.mes.slice(r.from,r.to);
            body.append(readingModes(this,el,source,msg,floor,e,note?null:r,note?toolbar:null));
            if(!note && !r.folders.length){
                body.append(button('选择合集并记住此名称',()=>this.assign(r),'mn-primary'));
                const filter=button('过滤此名称（黑名单）',()=>{
                    this.confirmAction('过滤此名称','过滤「'+r.name+'」后，已有同名消息将隐藏，以后也会自动跳过。','确认过滤',async()=>{
                        await this.editRules(e,b=>{b.ignoreNames=unique([...b.ignoreNames,r.name]);},'existing');
                        if(e.alive()){el.close();this.toast('已过滤「'+r.name+'」');this.render();}
                    });
                },'mn-blacklist');body.append(filter);
            }
        }catch(err){if(el.open)body.append(node('p','mn-empty',err.message));}

    }
    async editRules(e,change, mode = true, unlinkFolder) {
        e.resetting=true;const epoch=++e.epoch;
        e.parser.stop();e.recent.clear();
        try {
            const book=await db.mutateBook(e.key,change,mode,unlinkFolder);
            if(!e.alive()||epoch!==e.epoch)return;
            e.book=book;e.progress=await db.getProgress(e.key);e.history=true;
        } finally {if(e.epoch===epoch){e.resetting=false;e.kick();}}
        this.changed('reset');
    }
    assign(rows) {
        if(!Array.isArray(rows))rows=[rows];
        const first=rows[0], multiple=rows.length>1;
        const e=this.engine;if(!e?.book)return;
        const {el,body}=this.dialog('将消息归入合集');
        const menu=select([['','新建合集'],...catalog(e.book,'folder').options()],'');
        const names=unique(rows.map(r=>r.name));
        const name=input(multiple?'':first.name,'合集名称');
        menu.onchange=()=>{name.hidden=!!menu.value;};
        body.append(node('p','mn-preview',names.join('、')),field('目标合集',menu),name);
        const save=button('归类并记住此名称',this.guard(async()=>{
            const title=name.value.trim();if(!menu.value && !title)throw Error('请填写合集名称');
            if(!el.open || !e.alive() || this.engine!==e)return;
            let dest=menu.value;
            save.disabled=true;
            try {await this.editRules(e,b=>{
                let f=b.folders.find(f=>f.name===dest);
                if(!dest){
                    const item=rootDirectory(catalog(b,'folder'),title);
                    dest=item.name;f=b.folders.find(n=>n.name===dest);
                    if(!f){f={...item,tag:first.tag,attr:first.attr};b.folders.push(f);}
                }
                if(!f)throw Error('所选合集已删除');
                const groups=new Map([f,...(f.extra || [])].map(rule=>[rule.tag+' '+rule.attr,rule]));
                const additions=new Map();
                for(const r of rows){
                    const key=r.tag+' '+r.attr;
                    let rule=groups.get(key);
                    if(!rule){
                        rule={tag:r.tag,attr:r.attr,names:[]};
                        (f.extra ||= []).push(rule);groups.set(key,rule);
                    }
                    if(!additions.has(rule))additions.set(rule,new Set(rule.names));
                    additions.get(rule).add(r.name);
                }
                for(const [rule,values] of additions)rule.names=[...values];
            },'existing');
            if(e.alive()){el.close();this.toast('已记住 '+names.length+' 个 UI 名称 → '+catalog(e.book,'folder').label(dest));this.render();}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    settings(e) {
        const wrap=node('div','mn-page');
        wrap.append(row(node('h3','mn-title','记事簿设置'),this.version.row('notebook')),section('外观'));
        const themes=node('div','mn-themes');
        for(const [key,name] of [['light','白绿 · 浅色'],['dark','深蓝 · 深色'],['neon','墨绿 · 霓虹']]){
            const b=choice(name,this.prefs.theme===key,()=>{this.savePrefs({theme:key});this.render();});
            b.dataset.swatch=key;themes.append(b);
        }
        const toggle=node('input');toggle.type='checkbox';toggle.checked=this.prefs.zero;
        toggle.onchange=()=>this.savePrefs({zero:toggle.checked});
        wrap.append(themes,field('导航栏位置',select([['top','顶部'],['bottom','底部']],this.prefs.nav,v=>this.savePrefs({nav:v}))),section('阅读外观'),fontSettings(this),section('气泡外观'),bubbleSettings(this),field('气泡停靠侧',select([['left','左侧'],['right','右侧']],this.prefs.side,v=>this.savePrefs({side:v}))),
            field('通知位置',select([['edge','收藏头旁'],['top','应用顶部']],this.prefs.toast,v=>this.savePrefs({toast:v}))),
            section('识别与通知'),row(node('span','','有 div 但没有匹配外层标记时提醒'),toggle));
        if(!e?.book)return wrap;
        wrap.append(
            button('管理人物、合集与识别规则',()=>manage(this),'mn-setting'),
            button('拆分多标签消息',()=>this.tabSettings(),'mn-setting'),
            button('过滤标签与剧情日期',()=>this.filterEditor(),'mn-setting'),
            button('重新扫描当前聊天',this.guard(async()=>{await e.reset(0,true);this.toast('已开始分批整理历史');}),'mn-setting'),
            section('本聊天备份'),button('导出收藏、备注与规则',this.guard(async()=>{
                const data=await db.backup(e.key),blob=new Blob([JSON.stringify(data)],{type:'application/json'});
                const a=node('a');a.href=URL.createObjectURL(blob);a.download='mnemosyne-notes.json';a.click();
                setTimeout(()=>URL.revokeObjectURL(a.href),3000);
            }),'mn-setting'));
        const file=node('input');file.type='file';file.accept='.json';file.hidden=true;
        file.onchange=this.guard(async()=>{
            if(!file.files[0])return;
            const data=JSON.parse(await file.files[0].text());
            if(!e.alive())return;
            if(!confirm('导入本聊天的收藏，并用备份中的合集和规则替换当前配置？'))return;
            for(const folder of [...(data.book?.folders||[]),...(data.book?.personNodes||[])])validateRule(folder);
            e.resetting=true;e.epoch++;e.parser.stop();
            try{e.book=await db.restore(e.key,data);e.progress={next:0,revision:e.book.revision};e.history=true;e.recent.clear();}
            finally{e.resetting=false;e.kick();}
            if(e.alive()){this.render();this.toast('备份已导入');}
        });
        wrap.append(file,button('导入本聊天备份',()=>file.click(),'mn-setting'));
        return wrap;
    }
    tabSettings() {
        const e=this.engine,previous=e.book.tabNames || [];
        const {el,body}=this.dialog('拆分多标签消息');
        const names=input(previous.join('\n'),'例如：界内·新消息，每行一个完整名称',true);
        body.append(field('启用拆分的外层 UI 名称',names),
            node('p','mn-hint','每个 data-nvwa-tabs 下的 data-tab 单独显示。名称末尾的消息数会自动去掉，例如「界内·新消息 / 槐下听雨」。可在未分类中为每个名字选择合集。'));
        const save=button('保存',this.guard(async()=>{
            const next=lines(names.value);
            if(next.length===previous.length && next.every(n=>previous.includes(n))){el.close();return;}
            // Removing a split can restore a wrapper whose pages were all filtered,
            // in which case its floor might no longer have an indexed candidate.
            const restore=previous.some(n=>!next.includes(n)) && (e.book.ignoreNames.length || e.book.ignoreAttrs.length);
            save.disabled=true;
            try{
                await this.editRules(e,b=>{b.tabNames=next;},restore ? true : 'existing');
                if(e.alive()){el.close();this.toast('标签页拆分规则已保存');}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    filterEditor() {
        const e=this.engine,b=e.book,{el,body}=this.dialog('过滤与日期');
        const attrs=input(b.ignoreAttrs.join('\n'),'每行一个，如 data-status 或 div[data-role="status"]',true);
        const names=input(b.ignoreNames.join('\n'),'例如 状态栏，每行一个完整名称',true);
        const start=input(b.startTag),end=input(b.endTag),rs=input(b.startPattern||''), re=input(b.endPattern||'');
        body.append(field('跳过的外层标记',attrs),field('跳过的 UI 名称',names),
            node('p','mn-hint','命中任一过滤项会跳过整个块及其内部内容，也不会弹出提醒。'),
            field('剧情起始时间标签',start),field('剧情结束时间标签',end));
        const advanced=node('details');advanced.open=!!(b.startPattern||b.endPattern);
        advanced.append(node('summary','','自定义日期正则'),field('起始日期正则',rs),field('结束日期正则',re),
            node('p','mn-hint','可选。填写后优先取第一捕获组，未命中时使用时间标签。'));body.append(advanced);
        const save=button('保存',this.guard(async()=>{
            const ignored=lines(attrs.value);ignored.forEach(parseFilter);
            if(![start.value.trim(),end.value.trim()].every(validToken))throw Error('属性或标签名无效');
            for(const value of [rs.value,re.value])if(value){if(value.length>400)throw Error('日期正则过长');new RegExp(value,'u');}
            save.disabled=true;try{await this.editRules(e,book=>Object.assign(book,{
                ignoreAttrs:ignored,ignoreNames:lines(names.value),startTag:start.value.trim(),endTag:end.value.trim(),
                startPattern:rs.value.trim(),endPattern:re.value.trim()}));
                if(e.alive()){el.close();this.toast('识别设置已保存');}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
}
