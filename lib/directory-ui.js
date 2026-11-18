import { button, field, icon, input, node, select } from './dom.js';
import { catalog, deleteFolder, putNode, splitPeople } from './catalog.js';
import { blankFolder, lines, unique } from './model.js';
import { validateRule } from './extract.js';
import { mutateBook } from './db.js';

const kindName=dim=>dim==='folder'?'合集':'人物';

export function manage(view, dim='folder', expanded=new Set()) {
    const {body}=view.dialog('目录管理'),book=view.engine.book;
    const tabs=node('div','mn-modes');
    for(const key of ['folder','person']){
        const tab=button(kindName(key),()=>manage(view,key),'mn-chip');
        tab.setAttribute('aria-pressed',String(dim===key));tabs.append(tab);
    }
    const cat=catalog(book,dim), search=input('','搜索名称或完整路径');
    search.setAttribute('aria-label','搜索目录');
    const tree=node('div','mn-tree');
    const children=new Map();
    for(const [id] of cat.options()){
        const parent=cat.byId.get(id).parent || '';
        if(!children.has(parent))children.set(parent,[]);
        children.get(parent).push(id);
    }
    function edit(id) {
        editDirectory(view,dim,id,'',saved=>{
            for(const ancestor of catalog(view.engine.book,dim).path(saved))expanded.add(ancestor);
            manage(view,dim,expanded);
        });
    }
    function draw(){
        const query=search.value.trim().toLocaleLowerCase();
        tree.replaceChildren();
        function add(id,level){
            const branch=children.has(id),line=node('div','mn-tree-row');
            line.style.setProperty('--level',String(level));
            if(branch && !query) {
                const toggle=button(expanded.has(id)?'▾':'▸',()=>{
                    if(expanded.has(id))expanded.delete(id);else expanded.add(id);draw();
                },'mn-tree-toggle');
                toggle.setAttribute('aria-label',(expanded.has(id)?'收起':'展开')+cat.title(id));
                toggle.setAttribute('aria-expanded',String(expanded.has(id)));line.append(toggle);
            } else line.append(node('span','mn-tree-indent'));
            const entry=button('',()=>edit(id),'mn-tree-entry');
            entry.append(icon(dim==='folder'?'folder':'people'),node('span','',query?cat.label(id):cat.title(id)));
            line.append(entry);
            if(cat.path(id).length<3){
                const addChild=button('＋',()=>editDirectory(view,dim,null,id,()=>{
                    expanded.add(id);manage(view,dim,expanded);
                }),'mn-link');
                addChild.setAttribute('aria-label','在「'+cat.title(id)+'」新建子目录');line.append(addChild);
            }
            tree.append(line);
            if(!query && branch && expanded.has(id))for(const child of children.get(id))add(child,level+1);
        }
        if(query){for(const n of cat.all)if(cat.label(n.name).toLocaleLowerCase().includes(query))add(n.name,0);}
        else for(const id of children.get('') || [])add(id,0);
        if(!tree.children.length)tree.append(node('p','mn-empty',query?'没有匹配的目录':'还没有'+kindName(dim)+'目录'));
    }
    search.oninput=draw;
    body.append(tabs,search,button('＋ 新建'+kindName(dim),()=>edit(null),'mn-setting'),tree);draw();
}

export function editDirectory(view,dim,id,initialParent='',onSaved) {
    const e=view.engine,book=e.book,cat=catalog(book,dim),kind=kindName(dim);
    const old=id ? cat.byId.get(id) || blankFolder(id) : null;
    const f=old || blankFolder('');
    const {el,body}=view.dialog((old?'编辑':'新建')+kind);
    const name=input(old?cat.title(id):'','目录名称');
    const parents=cat.options().filter(([p])=>cat.validParent(id,p));
    const parent=select([['','顶层目录'],...parents],old?.parent || initialParent);
    const people=catalog(book,'person');
    const person=input((f.persons || splitPeople(f.person)).map(people.label).join('、'),'例如：玦、崔冬');
    const tag=input(f.tag),attr=input(f.attr),names=input(f.names.join('\n'),'每行一个完整 UI 名称',true);
    const pattern=input(f.pattern,'例如：^与(.+?)的微信$');
    body.append(field(kind+'名称',name),field('上级目录',parent),field('匹配任一 UI 名称',names),
        field('人物标签',person),node('p','mn-hint','多个人物可用 , ， ; ； 或 、 分隔。同名人物可填完整路径。'));
    const advanced=node('details');advanced.open=!!f.pattern || f.tag!=='div' || f.attr!=='data-nvwa-ui';
    advanced.append(node('summary','','高级匹配'),field('外层元素',tag),field('名称所在属性',attr),field('名称正则',pattern),
        node('p','mn-hint','完整名称和正则任一命中即归类。第一组括号或命名组 person 可提取人物。'));
    body.append(advanced);
    if(f.extra?.length)body.append(node('p','mn-hint','其他已记住的标记：'+f.extra.map(x=>x.attr+' · '+x.names.join('、')).join('；')));
    const save=button('保存'+kind,view.guard(async()=>{
        const title=name.value.trim(),up=parent.value;
        if(!title)throw Error('请填写'+kind+'名称');
        if(!cat.validParent(id,up))throw Error('目录最多三级，且不能移入自身或子目录');
        if(cat.all.some(n=>n.name!==id && (n.parent || '')===up && cat.title(n.name)===title))
            throw Error('本层已有同名'+kind);
        const key=id || (cat.byId.has(title)?crypto.randomUUID():title);
        const persons=unique(splitPeople(person.value).map(people.personId));
        const updated={...f,name:key,title,parent:up,tag:tag.value.trim().toLowerCase(),attr:attr.value.trim().toLowerCase(),
            names:lines(names.value),pattern:pattern.value.trim(),persons,person:''};
        validateRule(updated);
        const before=[...(book.personNodes || []),...book.folders];
        const marker=n=>[n.tag,n.attr].join(' ');
        const markerSet=items=>new Set(['div data-nvwa-ui',...(book.discoveryMarkers || []).map(marker),...items.flatMap(n=>[n,...(n.extra || [])].map(marker))]);
        const previous=markerSet(before),next=markerSet([...before.filter(n=>n!==old),updated]);
        const markerChanged=previous.size!==next.size || [...previous].some(m=>!next.has(m));
        const ruleChanged=JSON.stringify([updated.names,updated.pattern,persons,marker(updated)])!==
            JSON.stringify([f.names,f.pattern,f.persons || splitPeople(f.person),marker(f)]);
        const update=b=>{putNode(b,dim,updated);b.people=unique([...b.people,...persons]);};
        save.disabled=true;
        try {
            if(markerChanged || ruleChanged)await view.editRules(e,update,markerChanged || 'existing');
            else e.book=await mutateBook(e.key,update);
            if(!e.alive() || view.engine!==e)return;
            el.close();view.toast('已保存「'+title+'」');view.render();onSaved?.(key);
        } finally {save.disabled=false;}
    }),'mn-primary');body.append(save);
    if(old && dim==='folder'){
        const remove=button('删除合集',()=>view.confirmAction('删除合集','删除「'+cat.label(id)+'」？子目录上移一级，楼层收藏和备注保留。仅归入此合集的消息将回到未分类。','确认删除',async()=>{
            await view.editRules(e,b=>deleteFolder(b,id),'existing',id);
            if(!e.alive())return;
            el.close();view.path=[];view.filters={};view.render();manage(view,'folder');
            view.toast('已删除「'+cat.title(id)+'」');
        }),'mn-blacklist mn-danger');
        body.append(remove);
    }
}
