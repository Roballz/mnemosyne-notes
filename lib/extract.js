import { DEFAULT_ATTR, digest, identity, unique, validToken } from './model.js';

import { splitPeople } from './catalog.js';

const voids = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const raw = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
function decode(value) {
    return value.replace(/&(amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, (entity, n) => {
        if (n[0] !== '#') return ({amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' '})[n.toLowerCase()];
        const point = n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : Number(n.slice(1));
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
}
function attrs(source) {
    const result = new Map();
    const pairs = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const m of source.matchAll(pairs)) {
        const k = m[1].toLowerCase();
        if (!result.has(k)) result.set(k, decode(m[2] ?? m[3] ?? m[4] ?? '').trim());
    }
    return result;
}
export function parseFilter(text) {
    text=text.trim();
    if(validToken(text)) return {tag:'',attr:text.toLowerCase()};
    const tagOnly=/^<([a-z][\w:-]*)>$/i.exec(text);
    if(tagOnly)return {tag:tagOnly[1].toLowerCase(),attr:''};
    const marker=/^([a-z][\w:-]*)?\[([a-z][\w:-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]$/i.exec(text);
    if(!marker)throw Error('过滤标记格式无效：'+text);
    return {tag:(marker[1]||'').toLowerCase(),attr:marker[2].toLowerCase(),value:marker[3]??marker[4]??marker[5]};
}
export function compile(book) {
    const targets = [...book.folders,...(book.personNodes || []).map(f=>({...f,personRule:true}))];
    const rules = targets.flatMap(f => [f, ...(f.extra || []).map(x => ({...f,...x,pattern:''}))]).map(f => ({...f, tag:f.tag.toLowerCase(), attr:f.attr.toLowerCase(),
        fixedPeople:f.persons || splitPeople(f.person), rx:f.pattern ? new RegExp(f.pattern, 'u') : null}));
    const markers = new Map();
    for (const r of [{tag:'div', attr:DEFAULT_ATTR}, ...(book.discoveryMarkers || []), ...rules]) {
        if (!markers.has(r.tag)) markers.set(r.tag, new Set());
        markers.get(r.tag).add(r.attr);
    }
    return {rules, markers, tabNames:new Set(book.tabNames || []), filters:book.ignoreAttrs.map(parseFilter),
        ignoreNames:new Set(book.ignoreNames), start:book.startTag.toLowerCase(), end:book.endTag.toLowerCase(),
        startRx:book.startPattern ? new RegExp(book.startPattern,'u') : null,
        endRx:book.endPattern ? new RegExp(book.endPattern,'u') : null};
}
export function extract(msg, cfg) {
    const source = String(msg.mes ?? '');
    const rows = [], stack = [];
    let unmarkedDiv = false, start = '', end = '';
    // Quoted attribute values may contain >. Only complete element tokens are accepted.
    const tokens = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    function classified(tag,fields,labels,from) {
        const folders=[],people=[];
        let [attr,name]=labels[0];
        for(const rule of cfg.rules){
            const value=fields.get(rule.attr);
            if(rule.tag!==tag || !value)continue;
            const hit=rule.rx?.exec(value);
            if(!hit && !rule.names.includes(value))continue;
            if(!folders.length){attr=rule.attr;name=value;}
            if(rule.personRule)people.push(rule.name);else folders.push(rule.name);
            people.push(...rule.fixedPeople,...splitPeople(hit?.groups?.person || hit?.[1]));
        }
        return {tag,attr,name,folders:unique(folders),people:unique(people),from,to:source.length};
    }
    function finish(frame, at, after) {
        if (frame.date && !frame.ignore) {
            const value = decode(source.slice(frame.after, at).replace(/<[^>]+>/g, '').trim()).slice(0, 160);
            if (frame.tag === cfg.start && !start) start = value;
            if (frame.tag === cfg.end) end = value;
        }
        if (frame.row) {
            frame.row.to = after;
            if (!frame.isPage) {
                if (frame.hasPages) {
                    for(const page of frame.pages)rows.push(page);
                } else rows.push(frame.row);
            }
        }
        const parent = stack.at(-1);
        if (frame.covered && parent) parent.covered = true;
        if (frame.tag === 'div' && !frame.ignore && !frame.inside && !frame.covered) unmarkedDiv = true;
    }
    let m;
    while ((m = tokens.exec(source))) {
        if (!m[2]) continue;
        const tag = m[2].toLowerCase();
        if (m[1]) {
            let n = stack.length - 1;
            while (n >= 0 && stack[n].tag !== tag) n--;
            if (n >= 0) while (stack.length > n) finish(stack.pop(), m.index, tokens.lastIndex);
            continue;
        }
        const parent = stack.at(-1);
        const frame = {tag, after:tokens.lastIndex, ignore:!!parent?.ignore,
            inside:!!(parent?.inside || parent?.row), covered:false, date:tag === cfg.start || tag === cfg.end};
        // Inspect just two levels inside opted-in wrappers. Other nested UI
        // blocks keep their original single-source locator.
        const isGroup=tag==='div' && parent?.pages;
        const outer=tag==='div' && parent?.tabGroup;
        if ((!frame.ignore && !frame.inside) || isGroup || outer) {
            const fields = attrs(m[3]);
            const markers=cfg.markers.get(tag);
            frame.ignore ||= cfg.filters.some(f=>(!f.tag || f.tag===tag) &&
                (!f.attr || fields.has(f.attr) && (f.value==null || fields.get(f.attr)===f.value))) ||
                [...fields].some(([k,v])=>(markers?.has(k) || k.startsWith('data-') || k==='title' || k==='aria-label') && cfg.ignoreNames.has(v));
            if(isGroup && fields.has('data-nvwa-tabs'))frame.tabGroup=parent;
            const tab=outer && fields.get('data-tab');
            if(tab){
                outer.hasPages=true;
                const title=tab.replace(/\s*·\s*[0-9０-９]+$/u,'').trim() || tab;
                const name=outer.tabName+' / '+title;
                if(!frame.ignore && !cfg.ignoreNames.has(name)){
                    frame.row=classified(tag,new Map([[DEFAULT_ATTR,name]]),[[DEFAULT_ATTR,name]],m.index);
                    frame.isPage=true;outer.pages.push(frame.row);
                }
            } else if(!frame.ignore && !frame.inside) {
                const labels=[...(markers || [])].map(k=>[k,fields.get(k)]).filter(([,value])=>value);
                if(labels.length){
                    frame.row=classified(tag,fields,labels,m.index);
                    const ui=fields.get(DEFAULT_ATTR);
                    if(tag==='div' && cfg.tabNames.has(ui)){
                        frame.tabName=ui;frame.pages=[];
                    }
                }
            }
        }
        frame.covered = frame.ignore || frame.inside || !!frame.row;
        stack.push(frame);
        if (raw.has(tag)) {
            const close = new RegExp('</' + tag + '\\s*>', 'ig');
            close.lastIndex = tokens.lastIndex;
            const hit = close.exec(source);
            tokens.lastIndex = hit ? close.lastIndex : source.length;
            finish(stack.pop(), hit?.index ?? source.length, tokens.lastIndex);
        } else if (voids.has(tag) || /\/\s*$/.test(m[3])) finish(stack.pop(), tokens.lastIndex, tokens.lastIndex);
    }
    while (stack.length) finish(stack.pop(), source.length, source.length);
    if (rows.length) {
        const a=cfg.startRx?.exec(source), b=cfg.endRx?.exec(source);
        start=(a?.[1] || a?.[0] || start).slice(0,160);
        end=(b?.[1] || b?.[0] || end).slice(0,160);
    }
    const hash = rows.length ? digest(source) : '';
    return {unmarkedDiv, rows:rows.map((r,slot) => ({...r, slot, start, end, hash, identity:identity(msg), swipe:msg.swipe_id || 0}))};
}
export function validateRule(folder) {
    if (!validToken(folder.tag) || !validToken(folder.attr)) throw Error('请填写有效的元素名和属性名');
    if (folder.pattern.length > 400) throw Error('正则最长 400 字符');
    if (folder.pattern) new RegExp(folder.pattern, 'u');
}
