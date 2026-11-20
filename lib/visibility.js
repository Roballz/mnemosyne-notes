// The host uses is_system for /hide and /unhide. Work on the current chat's
// message objects, with absolute floor numbers even on older windowed builds.
import { context } from './host.js';

const yieldPage = () => new Promise(resolve=>setTimeout(resolve,0));

async function windowOf(host) {
    const info = await globalThis.__TAURITAVERN__?.api?.chat?.current?.windowInfo?.();
    const ctx = context();
    if (!host.active() || !Array.isArray(ctx?.chat)) throw Error('聊天已切换');
    const offset = info?.windowStartIndex ?? 0;
    const total = info?.totalCount ?? ctx.chat.length;
    if (!Number.isSafeInteger(offset) || offset<0 || offset+ctx.chat.length!==total)
        throw Error('聊天楼层正在变化，请稍后重试');
    return {ctx,offset,total};
}

const hiddenIn = (messages,limit=messages.length) => {
    let count=0;
    for(let i=0;i<limit;i++) if(messages[i]?.is_system) count++;
    return count;
};

export async function visibilityCount(host, live) {
    const {ctx,offset,total}=await windowOf(host);
    if(!live() || !host.active())return null;
    let prefix=0;
    if(offset && host.hiddenPrefix?.offset!==offset){
        const history=globalThis.__TAURITAVERN__?.api?.chat?.current?.handle?.()?.history;
        if(!history)throw Error('当前宿主无法读取较早楼层的隐藏状态');
        let page=await history.tail({limit:64}), end=total;
        while(true){
            if(!live() || !host.active())return null;
            if(page.totalCount!==total || page.startIndex+page.messages.length!==end || page.startIndex>=end)
                throw Error('聊天历史已变化，请重新查看');
            prefix+=hiddenIn(page.messages,Math.max(0,Math.min(offset-page.startIndex,page.messages.length)));
            if(page.startIndex===0)break;
            if(!page.hasMoreBefore)throw Error('历史楼层未完整返回');
            end=page.startIndex;
            await yieldPage();
            if(!live() || !host.active())return null;
            page=await history.before(page,{limit:64});
        }
        host.hiddenPrefix={offset,count:prefix};
    }else if(offset)prefix=host.hiddenPrefix.count;
    if(!live() || !host.active() || ctx.chat.length!==total-offset)return null;
    return {total,hidden:prefix+hiddenIn(ctx.chat)};
}

export async function changeVisibility(host, options, live, loadEarlier=loadEarlierPage) {
    if(host.visibilityWriting)throw Error('正在保存隐藏设置');
    host.visibilityWriting=true;
    try {
        let win=await windowOf(host);
        const {total}=win, {action,start,end,keep,opening}=options;
        if(!live() || !total)throw Error('当前没有可操作的楼层');
        const recent=action==='recent';
        if(recent){
            if(!Number.isSafeInteger(keep) || keep<0)throw Error('保留楼数须为非负整数');
        }else if(!['hide','show'].includes(action) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start<0 || end<start || end>=total)throw Error('请输入有效的起止楼层，范围为 0 至 '+(total-1));
        const first=recent ? 0 : action==='hide' && opening ? Math.max(1,start) : start;
        const last=recent ? total-1 : end;
        if(first>last)return 0;
        // Old windowed builds expose read-only history pages. Ask the host to
        // prepend bounded pages only for an explicit edit outside its window.
        while(first<win.offset){
            const prior=win.offset;
            await loadEarlier(Math.min(32,prior-first),live);
            if(!live() || !host.active())throw Error('操作已取消');
            win=await windowOf(host);
            if(win.total!==total || win.offset>=prior)throw Error('未能载入目标楼层，请重新打开设置');
            host.offset=win.offset;host.page=null;host.hiddenPrefix=null;
            await yieldPage();
        }
        if(!live() || !host.active() || win.ctx.chat.length!==total-win.offset)throw Error('聊天已变化，请重试');
        const {ctx,offset}=win;
        if(typeof ctx.saveChat!=='function')throw Error('当前宿主未提供聊天保存接口');
        const changes=[];
        for(let i=first;i<=last;i++){
            const message=ctx.chat[i-offset];
            if(!message)throw Error('目标楼层尚未载入');
            const hide=recent ? i<total-keep && !(opening && i===0) : action==='hide';
            if(Boolean(message.is_system)!==hide)changes.push({message,old:message.is_system,hide});
        }
        if(!changes.length)return 0;
        const repaint=()=>{
            // Touch only mounted elements. Older and virtualized floors read
            // their authoritative message flag the next time the host mounts them.
            for(const el of document.querySelectorAll('#chat .mes[mesid]')){
                const id=Number(el.getAttribute('mesid')),floor=id+offset;
                if(floor>=first && floor<=last && ctx.chat[id]){
                    const value=String(Boolean(ctx.chat[id].is_system));
                    if(el.getAttribute('is_system')!==value)el.setAttribute('is_system',value);
                }
            }
            ctx.swipe?.refresh?.();
        };
        for(const item of changes)item.message.is_system=item.hide;
        try{
            repaint();
            await ctx.saveChat();
        }catch(error){
            for(const {message,old,hide} of changes){
                if(message.is_system!==hide)continue;
                if(old===undefined)delete message.is_system;else message.is_system=old;
            }
            if(host.active())repaint();
            throw error;
        }
        return changes.length;
    }finally{host.visibilityWriting=false;}
}

async function loadEarlierPage(limit,live) {
    const core=await import('/script.js');
    if(!live())throw Error('操作已取消');
    if(typeof core.showMoreMessages!=='function')throw Error('请在聊天区载入较早楼层后重试');
    await core.showMoreMessages(limit);
}
