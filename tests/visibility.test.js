import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { Host,chatKey } from '../lib/host.js';
import { changeVisibility,visibilityCount } from '../lib/visibility.js';

function fixture(total,offset=0) {
    const all=Array.from({length:total},(_,i)=>({mes:'消息'+i}));
    const state={offset,id:'当前',saves:0,pages:0,refresh:0};
    const ctx={characterId:1,getCurrentChatId:()=>state.id,chat:all.slice(offset),
        saveChat:async()=>{state.saves++;},swipe:{refresh:()=>state.refresh++}};
    globalThis.SillyTavern={getContext:()=>ctx};
    const page=(first,end)=>{state.pages++;return {totalCount:total,startIndex:first,messages:all.slice(first,end),hasMoreBefore:first>0};};
    const history={tail:async({limit})=>page(Math.max(0,total-limit),total),
        before:async(p,{limit})=>page(Math.max(0,p.startIndex-limit),p.startIndex)};
    globalThis.__TAURITAVERN__={api:{chat:{current:{windowInfo:async()=>({windowStartIndex:state.offset,totalCount:total}),handle:()=>({history})}}}};
    const {document}=parseHTML('<html><body><div id="chat"><div class="mes" mesid="1"></div></div></body></html>');
    globalThis.document=document;
    const host=new Host(chatKey()),live=()=>host.active();
    const apply=opts=>changeVisibility(host,opts,live,async n=>{
        ctx.chat.unshift(...all.slice(state.offset-n,state.offset));state.offset-=n;
    });
    return {all,state,ctx,host,live,apply,count:()=>visibilityCount(host,live)};
}

test('1970楼按全局范围处理，最近20楼和开场白可恢复，重复点击不再保存',async()=>{
    const {all,state,apply,count}=fixture(1970);
    all[1969].is_system=true;
    assert.deepEqual(await count(),{hidden:1,total:1970});
    assert.equal(await apply({action:'recent',keep:20,opening:true}),1950);
    assert.deepEqual(await count(),{hidden:1949,total:1970});
    assert.ok(!all[0].is_system && all[1].is_system && all[1949].is_system && !all[1950].is_system && !all[1969].is_system);
    assert.equal(document.querySelector('.mes').getAttribute('is_system'),'true');
    assert.equal(await apply({action:'recent',keep:20,opening:true}),0);
    assert.deepEqual([state.saves,state.refresh,state.pages],[1,1,0]);
    assert.equal(await apply({action:'show',start:1,end:1949}),1949);
    assert.equal(await apply({action:'hide',start:0,end:0,opening:true}),0);
    assert.equal(await apply({action:'hide',start:0,end:0,opening:false}),1);
    assert.equal((await count()).hidden,1);
});

test('旧分页宿主合并历史与当前窗口，缓存早期计数并按绝对楼层写入',async()=>{
    const {all,state,apply,count}=fixture(145,135);
    all[2].is_system=true;all[144].is_system=true;
    assert.equal((await count()).hidden,2);
    assert.equal(state.pages,3);
    assert.equal((await count()).hidden,2);
    assert.equal(state.pages,3);
    assert.equal(await apply({action:'hide',start:71,end:72}),2);
    assert.equal(state.offset,71);
    assert.ok(all[71].is_system && all[72].is_system && !all[70].is_system && !all[73].is_system);
    assert.equal((await count()).hidden,4);
    assert.equal(state.saves,1);
});

test('范围校验、保存失败后重试、切换聊天和重复提交均不会误改楼层',async()=>{
    const {all,state,ctx,host,live,apply}=fixture(6);
    for(const [start,end] of [[-1,3],[2,6],[NaN,5],[4,1],[1.5,4]])
        await assert.rejects(apply({action:'hide',start,end}),/起止楼层/);
    const range={action:'hide',start:1,end:2};
    ctx.saveChat=async()=>{throw Error('写入失败');};
    await assert.rejects(apply(range),/写入失败/);
    assert.ok(all.every(m=>!Object.hasOwn(m,'is_system')));
    assert.equal(document.querySelector('.mes').getAttribute('is_system'),'false');
    let resolve;ctx.saveChat=()=>new Promise(r=>{resolve=r;});
    const first=apply(range);await new Promise(r=>setImmediate(r));
    await assert.rejects(apply(range),/正在保存/);resolve();assert.equal(await first,2);
    state.offset=2;ctx.chat=all.slice(2);
    await assert.rejects(changeVisibility(host,{action:'hide',start:0,end:0},live,async()=>{
        state.id='其他聊天';
    }),/取消|切换/);
    assert.ok(!all[0].is_system);
});
