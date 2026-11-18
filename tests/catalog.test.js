import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import * as db from '../lib/db.js';
import { blankBook,blankFolder } from '../lib/model.js';
import { catalog,deleteFolder,putNode,splitPeople } from '../lib/catalog.js';
import { compile,extract } from '../lib/extract.js';

test('三级人物和合集同时命中；同名目录独立、移动不改键、禁止循环和第四级',()=>{
    const b=blankBook();
    for(const dim of ['folder','person']){
        for(const [name,title,parent,names] of [['root','崔冬','',[]],['parent','往来','root',[]],['leaf','微信','parent',['微信·崔冬']]]){
            putNode(b,dim,{...blankFolder(name),title,parent,names,persons:dim==='folder'?['玦']:[]});
        }
    }
    putNode(b,'folder',{...blankFolder('other'),title:'微信',parent:'root'});
    const cat=catalog(b,'folder');
    assert.equal(cat.label('leaf'),'崔冬 / 往来 / 微信');
    assert.equal(cat.validParent('parent','leaf'),false);
    assert.equal(cat.validParent('root','other'),false);
    assert.equal(cat.validParent(null,'leaf'),false);
    assert.equal(cat.validParent('leaf','root'),true);
    assert.equal(cat.validParent('root',''),true);
    const [row]=extract({mes:'<div data-nvwa-ui="微信·崔冬">消息</div>'},compile(b)).rows;
    assert.deepEqual(row.folders,['leaf']);assert.deepEqual(row.people,['玦','leaf']);
    assert.deepEqual(splitPeople(' 玦,崔冬，甲;乙；丙、玦 '),['玦','崔冬','甲','乙','丙']);
});

test('删除合集只解除对应收藏，保留备注、多重归属、同名子目录和自定义标记未分类消息',async()=>{
    const key=crypto.randomUUID(),custom={...blankFolder('旧目录'),tag:'section',attr:'data-chat',names:['微信']};
    await db.mutateBook(key,b=>{b.folders.push(custom,blankFolder('保留'),{...blankFolder('child'),title:'保留',parent:'旧目录'});});
    for(const id of ['a','b'])await db.saveNote(key,{id,floor:1,people:['甲'],folders:['旧目录','保留'],tags:['线索'],note:id},()=>{});
    const b=await db.mutateBook(key,b=>deleteFolder(b,'旧目录'),'existing','旧目录');
    assert.equal((await db.list(key,'note',{folder:'旧目录'})).rows.length,0);
    assert.equal((await db.list(key,'note',{folder:'保留'})).rows.length,2);
    assert.deepEqual((await db.list(key,'note')).rows.map(r=>r.note).sort(),['a','b']);
    assert.equal(catalog(b,'folder').label('child'),'保留（2）');
    const [row]=extract({mes:'<section data-chat="微信">内容</section>'},compile(b)).rows;
    assert.deepEqual(row.folders,[]);
});

test('旧多人规则仅安排一次候选重分类，保留历史扫描进度',async()=>{
    const key=crypto.randomUUID();
    await db.mutateBook(key,b=>b.folders.push({...blankFolder('群聊'),person:'玦，崔冬',names:['群聊']}));
    await db.writeBatch(key,[],{next:1100,revision:1},()=>true);
    const b=await db.getBook(key);
    assert.deepEqual(b.people,['玦','崔冬']);assert.deepEqual(b.folders[0].persons,b.people);
    assert.deepEqual(await db.getProgress(key),{next:1100,revision:2,revisit:0,revisitFolder:null});
    assert.equal((await db.getBook(key)).revision,2);
});
