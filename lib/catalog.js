import { blankFolder, unique } from './model.js';

const collator=new Intl.Collator('zh');
export const splitPeople = text => unique((text || '').split(/[,，;；、\n]/u).map(s=>s.trim()));

// Keys used in the index and in old bookmarks stay stable across renames and moves.
export function catalog(book, dimension, extra = []) {
    const people = dimension === 'person';
    const records = people ? book.personNodes || [] : book.folders;
    const byId = new Map(records.map(r=>[r.name,r]));
    for (const id of [...(people ? book.people : []), ...extra]) {
        if (id && !byId.has(id)) byId.set(id,blankFolder(id));
    }
    function path(id) {
        const chain = [];
        while (id && !chain.includes(id) && chain.length < 3) {
            chain.unshift(id);
            id = byId.get(id)?.parent;
        }
        return chain;
    }
    const title = id => byId.get(id)?.title || id || '未分类';
    const label = id => id ? path(id).map(title).join(' / ') : '未分类';
    const all = [...byId.values()];
    const options = () => all.map(n=>[n.name,label(n.name)]).sort((a,b)=>collator.compare(a[1],b[1]));
    let heights;
    function validParent(id,parent) {
        if (!parent) return true;
        if (!heights) {
            heights=new Map();
            for(const item of all) {
                const chain=path(item.name);
                chain.forEach((key,i)=>heights.set(key,Math.max(heights.get(key)||1,chain.length-i)));
            }
        }
        const chain=path(parent);
        return byId.has(parent) && !chain.includes(id) && chain.length+(heights.get(id)||1)<=3;
    }
    function personId(text) {
        const matches=all.filter(n=>label(n.name)===text);
        if(matches.length===1)return matches[0].name;
        const short=all.filter(n=>title(n.name)===text);
        if(short.length>1)throw Error('有多个「'+text+'」，请填写完整人物路径');
        return short[0]?.name || text;
    }
    return {byId,all,path,title,label,options,validParent,personId};
}
export function rootDirectory(cat,title) {
    const known=cat.all.find(n=>!n.parent && cat.title(n.name)===title);
    if(known)return known;
    return {...blankFolder(cat.byId.has(title)?crypto.randomUUID():title),title};
}
export function putNode(book, dimension, record) {
    const prop=dimension==='folder'?'folders':'personNodes';
    const nodes=book[prop] ||= [];
    const i=nodes.findIndex(n=>n.name===record.name);
    if(i<0)nodes.push(record);else nodes[i]=record;
    if(dimension==='person')book.people=unique([...book.people,record.name]);
}

export function deleteFolder(book,id) {
    const old=book.folders.find(f=>f.name===id);
    if(!old)throw Error('合集已删除');
    book.folders=book.folders.filter(f=>f.name!==id);
    const promoted=book.folders.filter(f=>f.parent===id);
    const occupied=new Set(book.folders.filter(f=>(f.parent||'')===(old.parent||'')).map(f=>f.title||f.name));
    for(const child of promoted){
        child.parent=old.parent || '';
        // Promoting a child may collide with an existing sibling.
        const base=child.title||child.name;
        for(let n=2;occupied.has(child.title||child.name);n++)child.title=base+'（'+n+'）';
        occupied.add(child.title||child.name);
    }
    // Unmatched messages stay discoverable under 未分类, even for custom markup.
    const markers=book.discoveryMarkers ||= [];
    for(const {tag,attr} of [old,...(old.extra || [])]){
        if(tag==='div' && attr==='data-nvwa-ui')continue;
        if(!markers.some(m=>m.tag===tag && m.attr===attr))markers.push({tag,attr});
    }
}
