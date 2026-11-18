import test from 'node:test';
import assert from 'node:assert/strict';
import { Host,chatKey } from '../lib/host.js';
test('窗口化聊天分页读取早期楼层并复用邻页，切换后拒绝旧结果',async()=>{
    const all=Array.from({length:200},(_,i)=>({mes:'楼'+i})),calls=[];
    let id='branch-a';
    const page=(a,b)=>({messages:all.slice(a,b),startIndex:a,hasMoreBefore:a>0});
    const history={tail:async({limit})=>{calls.push('tail');return page(200-limit,200);},
        before:async(p,{limit})=>{calls.push('before');return page(Math.max(0,p.startIndex-limit),p.startIndex);}};
    globalThis.SillyTavern={getContext:()=>({chat:all.slice(180),getCurrentChatId:()=>id})};
    globalThis.__TAURITAVERN__={api:{chat:{current:{ref:()=>({kind:'character',characterId:'A',fileName:id}),
        handle:()=>({history}),windowInfo:async()=>({totalCount:200,windowStartIndex:180})}}}};
    const h=new Host(chatKey());await h.sync();
    assert.deepEqual(await h.read(181,183),all.slice(181,183));assert.deepEqual(calls,[]);
    assert.deepEqual(await h.read(125,145),all.slice(125,145));assert.deepEqual(calls,['tail','before']);
    assert.deepEqual(await h.read(110,125),all.slice(110,125));assert.equal(calls.length,2);
    id='branch-b';await assert.rejects(h.read(10,11),/切换/);
});
test('原生引用尚未就绪时用实际角色或群聊文件名，忽略空档名',async()=>{
    const ctx={characterId:0,groupId:'',chat:[{mes:'正文'}],characters:[{avatar:'a.png',chat:'分支 B'}],
        chatId:'',getCurrentChatId:()=>''};
    globalThis.SillyTavern={getContext:()=>ctx};
    globalThis.__TAURITAVERN__={api:{chat:{current:{
        ref:()=>({kind:'character',characterId:null,fileName:''}),handle:()=>{throw Error('SDK 尚未就绪');},
        windowInfo:async()=>{throw Error('窗口尚未就绪');},
    }}}};
    const key=chatKey();assert.equal(key,JSON.stringify(['character','a.png','分支 B']));
    const h=new Host(key);assert.equal(await h.sync(),1);assert.deepEqual(await h.read(0,1),ctx.chat);
    ctx.groupId='g';ctx.groups=[{id:'g',chat_id:'群聊 B'}];ctx.getCurrentChatId=()=>{throw Error('恢复中');};
    assert.equal(chatKey(),JSON.stringify(['group','g','群聊 B']));
    ctx.groups=[];assert.equal(chatKey(),'');
});
