import test from 'node:test';
import assert from 'node:assert/strict';
import { captureScope,listTargets,prepareOperations,applyReviewedItems,personaDescriptor,syncCharacterState,materialScope } from '../lib/workbench/targets.js';

const copy=v=>structuredClone(v);
const scope={chatKey:'target-tests',worldNames:['合成书'],characterAvatar:'actor.png',personaAvatar:'user.png',characterName:'合成人物',personaName:'合成用户'};
function fixture(){
 let book={entries:{0:{uid:0,comment:'甲',content:'前段A。中间保持。后段B。',key:['甲'],constant:true,vectorized:false,position:0,depth:4,order:100,unknown:{keep:true}},1:{uid:1,comment:'乙',content:'乙原文',key:['乙'],constant:false,vectorized:false,position:1,depth:2,order:50}},originalData:{entries:[{uid:0,content:'前段A。中间保持。后段B。',keys:['甲'],extensions:{keep:'原始扩展'}},{uid:1,content:'乙原文',keys:['乙']}]},custom:'保留整书属性'};
 let durable=copy(book),card={description:'角色原文',personality:'安静',data:{description:'角色原文',personality:'安静',extensions:{keep:true}}},persona={description:'User原文',position:0,depth:2,role:0};
 const calls={reads:0,saves:0,charSaves:0,userSaves:0};
 const adapter={captureScope:()=>scope,readWorld:async()=>{calls.reads++;return copy(book);},readWorldPersisted:async()=>copy(durable),saveWorld:async(name,data)=>{assert.equal(name,'合成书');calls.saves++;book=copy(data);durable=copy(data);},readCharacter:async avatar=>{assert.equal(avatar,'actor.png');return copy(card);},saveCharacter:async(avatar,updates)=>{assert.equal(avatar,'actor.png');calls.charSaves++;Object.assign(card,updates);Object.assign(card.data,updates);},readPersona:async avatar=>{assert.equal(avatar,'user.png');return copy(persona);},readPersonaPersisted:async()=>copy(persona),savePersona:async(avatar,value)=>{assert.equal(avatar,'user.png');calls.userSaves++;persona={...persona,...value.metadata,description:value.content};}};
 return {adapter,calls,get book(){return book;},get card(){return card;},get persona(){return persona;},change(fn){fn(book);durable=copy(book);}};
}
async function setup(){const f=fixture(),{targets}=await listTargets(scope,{adapter:f.adapter});return {...f,fixture:f,targets};}
test('default selection includes User/Char and enabled blue entries, with one read per book',async()=>{
 const f=fixture(),frozen=await captureScope({adapter:f.adapter}),{targets,worlds}=await listTargets(frozen,{adapter:f.adapter});
 assert.ok(Object.isFrozen(frozen)&&Object.isFrozen(frozen.worldNames));assert.equal(f.calls.reads,1);assert.equal(worlds[0].count,2);
 assert.equal(targets.filter(t=>t.kind==='char'&&t.selected).length,7);assert.equal(targets.find(t=>t.kind==='user').selected,true);
 assert.equal(targets.find(t=>t.kind==='world'&&t.uid===0).selected,true);assert.equal(targets.find(t=>t.kind==='world'&&t.uid===1).selected,false);
});
test('legacy active User description is displayed without borrowing another avatar',()=>{
 const p={personas:{},persona_descriptions:{},persona_description:'旧式User原文',persona_description_position:0,persona_description_depth:4};
 assert.deepEqual(personaDescriptor(p,'active.png','active.png'),{description:'旧式User原文',position:0,depth:4});
 assert.equal(personaDescriptor(p,'other.png','active.png'),null);assert.deepEqual(p.persona_descriptions,{});
});
test('disjoint exact patches coalesce per target, retaining unknown fields',async()=>{
 const {fixture:f,targets}=await setup(),ref=targets.find(t=>t.kind==='world'&&t.uid===0);
 const items=await prepareOperations([{action:'patch',target:ref.id,edits:[{oldText:'前段A',newText:'首段新文'},{oldText:'后段B',newText:'末段新文'}]},{action:'replace',target:ref.id,metadata:{light:'green',position:4,depth:7,order:88,key:['新词']}}],{scope,targets});
 assert.equal(items.length,1);assert.equal(items[0].after.content,'首段新文。中间保持。末段新文。');assert.equal(items[0].after.metadata.constant,false);
 const outcomes=await applyReviewedItems(items,{scope,adapter:f.adapter});assert.equal(outcomes[0].status,'applied');assert.equal(f.calls.saves,1);assert.deepEqual(f.book.entries[0].unknown,{keep:true});
 assert.equal(f.book.originalData.entries[0].extensions.keep,'原始扩展');assert.equal(f.book.originalData.entries[0].extensions.position,4);assert.deepEqual(f.book.originalData.entries[0].keys,['新词']);
});
test('proposals accept TT recursion flags and levels while other numeric fields remain strict',async()=>{
 const {targets}=await setup(),target=targets.find(t=>t.kind==='world').id;
 const propose=metadata=>prepareOperations([{action:'replace',target,metadata}],{scope,targets});
 for(const value of [false,true,0,2]){
  const [item]=await propose({delayUntilRecursion:value});
  assert.equal(item.after.metadata.delayUntilRecursion,value);
 }
 for(const value of [null,'false','2',NaN,Infinity]){
  await assert.rejects(()=>propose({delayUntilRecursion:value}),/delayUntilRecursion/);
 }
 await assert.rejects(()=>propose({probability:false}),/probability/);
});
test('ambiguous/overlapping patches and wrong captured identities reject before writes',async()=>{
 const {fixture:f,targets}=await setup(),target=targets.find(t=>t.kind==='world'&&t.uid===0);
 await assert.rejects(()=>prepareOperations([{action:'patch',target:target.id,edits:[{oldText:'段',newText:'节'}]}],{scope,targets}),/唯一/);
 await assert.rejects(()=>prepareOperations([{action:'patch',target:target.id,edits:[{oldText:'前段A',newText:'X'},{oldText:'段A',newText:'Y'}]}],{scope,targets}),/重叠/);
 await assert.rejects(()=>prepareOperations([{action:'replace',target:{kind:'char',avatar:'someone-else.png',field:'description'},content:'bad'}],{scope,targets}),/身份/);
 assert.equal(f.calls.saves,0);
});
test('disabled worldbooks and unselected entries reject before any host read',async()=>{
 const f=fixture(),bounded=materialScope({...scope,worldNames:['合成书','未选全局'],availableWorlds:['合成书','未选全局','其他书']},['合成书']);
 assert.deepEqual(bounded.worldNames,['合成书']);assert.equal(Object.hasOwn(bounded,'availableWorlds'),false);
 await assert.rejects(()=>prepareOperations([{action:'create',target:{kind:'world',world:'未选全局'},content:'不得创建'}],{scope:bounded,adapter:f.adapter}),/未启用/);
 await assert.rejects(()=>prepareOperations([{action:'replace',target:'world:'+encodeURIComponent('合成书')+':1',content:'不得读取'}],{scope:bounded,targets:[],allowedIds:new Set(),adapter:f.adapter}),/未选中/);
 assert.equal(f.calls.reads,0);assert.equal(f.calls.saves,0);
});
test('one grouped save preserves unrelated in-flight edits and isolates changed target conflicts',async()=>{
 const {fixture:f,targets}=await setup(),worlds=targets.filter(t=>t.kind==='world');
 const items=await prepareOperations(worlds.map(t=>({action:'replace',target:t.id,content:t.uid===0?'甲新文':'乙新文'})),{scope,targets});
 const result=await applyReviewedItems(items,{scope,adapter:f.adapter,beforeWrite:async()=>{f.change(b=>{b.entries[0].content='用户先改甲';b.entries[9]={uid:9,content:'并行创建',key:[]};});}});
 assert.equal(result.find(r=>r.itemId===items[0].id).status,'conflict');assert.equal(result.find(r=>r.itemId===items[1].id).status,'applied');
 assert.equal(f.book.entries[0].content,'用户先改甲');assert.equal(f.book.entries[1].content,'乙新文');assert.equal(f.book.entries[9].content,'并行创建');assert.equal(f.calls.saves,1);
});
test('closed deletion and multiple creates retain imported bookkeeping and distinct UIDs',async()=>{
 const {fixture:f,targets}=await setup();
 const items=await prepareOperations([{action:'delete',target:targets.find(t=>t.kind==='world'&&t.uid===0).id},{action:'create',target:{kind:'world',world:'合成书'},content:'新增甲',metadata:{comment:'新增甲',key:['新'],light:'blue'}},{action:'create',target:{kind:'world',world:'合成书'},content:'新增乙',metadata:{comment:'新增乙'}}],{scope,targets});
 const result=await applyReviewedItems(items,{scope,adapter:f.adapter});assert.ok(result.every(r=>r.status==='applied'));assert.equal(f.calls.saves,1);assert.equal(f.book.entries[0],undefined);
 assert.equal(Object.values(f.book.entries).filter(e=>e.content.startsWith('新增')).length,2);assert.equal(new Set(result.map(r=>r.target.uid)).size,3);assert.equal(f.book.custom,'保留整书属性');assert.equal(f.book.originalData.entries.some(e=>e.uid===0),false);
});
test('several character fields use one merge, User delete only clears its description',async()=>{
 const {fixture:f,targets}=await setup(),char=targets.filter(t=>t.kind==='char');
 const items=await prepareOperations([{action:'replace',target:char.find(t=>t.field==='description').id,content:'新角色内容'},{action:'replace',target:char.find(t=>t.field==='personality').id,content:'新性格'},{action:'delete',target:targets.find(t=>t.kind==='user').id}],{scope,targets});
 const outcomes=await applyReviewedItems(items,{scope,adapter:f.adapter});assert.ok(outcomes.every(r=>r.status==='applied'));assert.equal(f.calls.charSaves,1);assert.equal(f.calls.userSaves,1);assert.equal(f.card.data.extensions.keep,true);assert.equal(f.persona.description,'');assert.equal(f.persona.depth,2);
});
test('journal failure blocks host mutation, and rejected items never write',async()=>{
 const {fixture:f,targets}=await setup();const items=await prepareOperations([{action:'replace',target:targets.find(t=>t.kind==='world').id,content:'新文'}],{scope,targets});
 const result=await applyReviewedItems(items,{scope,adapter:f.adapter,beforeWrite:async()=>{throw Error('quota');}});assert.equal(result[0].status,'failed');assert.equal(f.calls.saves,0);
 items[0].accepted=false;assert.equal((await applyReviewedItems(items,{scope,adapter:f.adapter}))[0].status,'skipped');assert.equal(f.calls.saves,0);
});
test('failed post-write snapshot acknowledgement never reports a completed batch',async()=>{
 const {fixture:f,targets}=await setup(),items=await prepareOperations([{action:'replace',target:targets.find(t=>t.kind==='world').id,content:'已写入'}],{scope,targets});
 await assert.rejects(()=>applyReviewedItems(items,{scope,adapter:f.adapter,onResult:async()=>{throw Error('snapshot acknowledgement failed');}}),/acknowledgement/);
 assert.equal(f.calls.saves,1);assert.equal(f.book.entries[0].content,'已写入');
});
test('character lost acknowledgement recovery syncs host state without overwriting late form input',async()=>{
 const {fixture:f,targets}=await setup(),char=targets.filter(t=>t.kind==='char');
 const items=await prepareOperations([{action:'replace',target:char.find(t=>t.field==='description').id,content:'已持久化描述'},{action:'replace',target:char.find(t=>t.field==='personality').id,content:'已持久化性格'}],{scope,targets});
 const current={avatar:'actor.png',description:'角色原文',personality:'安静',data:{description:'角色原文',personality:'安静',extensions:{keep:'前端扩展'}},json_data:'before-json'};
 const inputs={avatar_url_pole:{value:'actor.png'},description_textarea:{value:'角色原文'},personality_textarea:{value:'安静'},character_json_data:{value:'before-json'}};
 const document={getElementById:id=>inputs[id]},ctx={characters:[current]};let syncs=0;
 f.adapter.syncCharacter=(avatar,card,reviewed)=>{syncs++;syncCharacterState(avatar,card,reviewed,{ctx,document});};
 f.adapter.saveCharacter=async(avatar,updates)=>{Object.assign(f.card,updates);Object.assign(f.card.data,updates);f.card.json_data='after-json';inputs.description_textarea.value='请求期间用户新输入';throw Error('merge response lost');};
 const result=await applyReviewedItems(items,{scope,adapter:f.adapter});assert.ok(result.every(r=>r.status==='applied'&&r.recovered));assert.ok(syncs>0);
 assert.equal(current.description,'已持久化描述');assert.equal(current.data.personality,'已持久化性格');assert.equal(current.data.extensions.keep,'前端扩展');assert.equal(current.json_data,'after-json');
 assert.equal(inputs.description_textarea.value,'请求期间用户新输入');assert.equal(inputs.personality_textarea.value,'已持久化性格');assert.equal(inputs.character_json_data.value,'after-json');
});
test('listing an imported world builds its original-data UID index only once',async()=>{
 let scans=0;const originals=Array.from({length:500},(_,uid)=>({uid,content:'原始'+uid,extensions:{keep:uid}}));
 originals[Symbol.iterator]=function*(){scans++;yield* Array.prototype.values.call(this);};
 const book={entries:Object.fromEntries(originals.map(e=>[e.uid,{uid:e.uid,content:e.content,key:[]} ])),originalData:{entries:originals}};
 const {targets}=await listTargets({chatKey:'linear-original-index',worldNames:['大书']},{adapter:{readWorld:async()=>book}});
 assert.equal(targets.length,500);assert.equal(scans,1);assert.equal(targets.at(-1).original.extensions.keep,499);
});
