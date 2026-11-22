import { chatKey, context } from '../host.js';

// This adapter is the only place this module imports TT internals. All writes
// use identities captured before generation, never the current chat selection.
const clone=v=>v==null?v:structuredClone(v);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const CHAR_FIELDS=['description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions'];
const CHAR_LABELS={description:'描述',personality:'性格',scenario:'场景',first_mes:'开场白',mes_example:'对话示例',system_prompt:'主提示词',post_history_instructions:'历史后提示词'};
const CHAR_INPUTS={description:'description_textarea',personality:'personality_textarea',scenario:'scenario_pole',first_mes:'firstmessage_textarea',mes_example:'mes_example_textarea',system_prompt:'system_prompt_textarea',post_history_instructions:'post_history_instructions_textarea'};
const DEFAULTS={key:[],keysecondary:[],comment:'',constant:false,vectorized:false,selective:true,selectiveLogic:0,addMemo:false,order:100,position:0,disable:false,ignoreBudget:false,excludeRecursion:false,preventRecursion:false,matchPersonaDescription:false,matchCharacterDescription:false,matchCharacterPersonality:false,matchCharacterDepthPrompt:false,matchScenario:false,matchCreatorNotes:false,delayUntilRecursion:0,probability:100,useProbability:true,depth:4,outletName:'',group:'',groupOverride:false,groupWeight:100,scanDepth:null,caseSensitive:null,matchWholeWords:null,useGroupScoring:null,automationId:'',role:0,sticky:null,cooldown:null,delay:null,triggers:[]};
const WORLD_KEYS=new Set(Object.keys(DEFAULTS));
const ORIGINAL={comment:'comment',key:'keys',keysecondary:'secondary_keys',constant:'constant',selective:'selective',selectiveLogic:'selectiveLogic',order:'insertion_order',position:'extensions.position',depth:'extensions.depth',role:'extensions.role',vectorized:'extensions.vectorized',disable:'enabled',excludeRecursion:'extensions.exclude_recursion',preventRecursion:'extensions.prevent_recursion',delayUntilRecursion:'extensions.delay_until_recursion',probability:'extensions.probability',matchWholeWords:'extensions.match_whole_words',useGroupScoring:'extensions.use_group_scoring',caseSensitive:'extensions.case_sensitive',matchPersonaDescription:'extensions.match_persona_description',matchCharacterDescription:'extensions.match_character_description',matchCharacterPersonality:'extensions.match_character_personality',matchCharacterDepthPrompt:'extensions.match_character_depth_prompt',matchScenario:'extensions.match_scenario',matchCreatorNotes:'extensions.match_creator_notes',scanDepth:'extensions.scan_depth',automationId:'extensions.automation_id',groupOverride:'extensions.group_override',groupWeight:'extensions.group_weight',sticky:'extensions.sticky',cooldown:'extensions.cooldown',delay:'extensions.delay',triggers:'extensions.triggers',ignoreBudget:'extensions.ignore_budget'};
const encode=v=>encodeURIComponent(String(v));
const targetId=r=>r.kind==='world'?`world:${encode(r.world)}:${r.uid}`:`${r.kind}:${encode(r.avatar)}:${r.field}`;
export function stableValue(v){if(Array.isArray(v))return `[${v.map(stableValue).join(',')}]`;if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stableValue(v[k])}`).join(',')}}`;return JSON.stringify(v);}
export const sameValue=(a,b)=>stableValue(a)===stableValue(b);
export const scopeKey=s=>typeof s==='string'?s:String(s?.chatKey||s?.key||'');
const comparable=v=>v==null?null:{content:String(v.content??''),metadata:v.metadata||{}};
const equalState=(a,b)=>sameValue(comparable(a),comparable(b));
function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);Object.values(v).forEach(deepFreeze);}return v;}
function textValue(v){if(typeof v!=='string')throw Error('内容必须是文本');if(v.length>2_000_000)throw Error('单条内容过大，请分批处理');return v;}
function integer(v,min,max,label){if(!Number.isSafeInteger(v)||v<min||v>max)throw Error(`${label}超出允许范围`);return v;}
function metadata(input,kind){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('条目属性必须是对象');const result=clone(input);
 if(own(result,'light')){if(!['blue','green','vector'].includes(result.light))throw Error('灯号必须为 blue、green 或 vector');result.constant=result.light==='blue';result.vectorized=result.light==='vector';delete result.light;}
 for(const [k,v] of Object.entries(result)){
  if(kind==='char')throw Error('角色设定只允许修改指定文本字段');
  if(!(kind==='world'?WORLD_KEYS:new Set(['position','depth','role','lorebook','title'])).has(k))throw Error(`不支持的属性：${k}`);
  if(['key','keysecondary','triggers'].includes(k)){if(!Array.isArray(v)||v.length>500||v.some(x=>typeof x!=='string'))throw Error(`${k} 必须是文本数组`);continue;}
  if(k==='position')integer(v,0,kind==='world'?7:9,'插入位置');else if(k==='depth')integer(v,0,1000000,'深度');else if(k==='order')integer(v,-1000000,1000000,'顺序');else if(k==='role')integer(v,0,2,'消息角色');
  else if(['comment','outletName','group','automationId','lorebook','title'].includes(k))textValue(v);
  else if(kind==='world'&&typeof DEFAULTS[k]==='boolean'&&typeof v!=='boolean')throw Error(`${k} 必须是布尔值`);
  else if(kind==='world'&&typeof DEFAULTS[k]==='number'&&!Number.isFinite(v))throw Error(`${k} 必须是有限数字`);
  else if(kind==='world'&&DEFAULTS[k]===null&&v!==null&&typeof v!=='boolean'&&!Number.isFinite(v))throw Error(`${k} 属性值无效`);
 }
 return result;
}
const originalIndexes=new WeakMap();
function originalIndex(book){
 const entries=book?.originalData?.entries;if(!Array.isArray(entries))return null;
 let index=originalIndexes.get(book);if(!index||index.entries!==entries){const byUid=new Map();for(const entry of entries)if(!byUid.has(String(entry.uid)))byUid.set(String(entry.uid),entry);index={entries,byUid};originalIndexes.set(book,index);}return index.byUid;
}
function worldState(entry,book){if(!entry)return null;const original=originalIndex(book)?.get(String(entry.uid));return {content:String(entry.content??''),metadata:Object.fromEntries(Object.entries(entry).filter(([k])=>WORLD_KEYS.has(k))),raw:clone(entry),...(original?{original:clone(original)}:{})};}
const characterText=(card,field)=>String(card?.data?.[field]??card?.[field]??'');
const charState=(card,field)=>card?{content:characterText(card,field),metadata:{}}:null;
const userState=p=>p?{content:String(p.description??''),metadata:Object.fromEntries(['position','depth','role','lorebook','title'].filter(k=>own(p,k)).map(k=>[k,p[k]]))}:null;
export function personaDescriptor(powerUser,avatar,activeAvatar){
 const descriptor=powerUser.persona_descriptions?.[avatar];if(descriptor)return clone(descriptor);
 if(avatar&&avatar===activeAvatar){const fallback={description:String(powerUser.persona_description??'')};for(const key of ['position','depth','role','lorebook'])if(powerUser[`persona_description_${key}`]!==undefined)fallback[key]=powerUser[`persona_description_${key}`];return fallback;}
 return own(powerUser.personas||{},avatar)?{description:''}:null;
}
export function syncCharacterState(avatar,card,items,{ctx=context(),document:doc=globalThis.document}={}){
 const fields=[...new Set(items.map(item=>item.target.field).filter(field=>CHAR_FIELDS.includes(field)))];
 const current=ctx?.characters?.find(value=>value.avatar===avatar),priorJson=current?.json_data;
 if(current){for(const field of fields){current[field]=characterText(card,field);current.data??={};current.data[field]=characterText(card,field);}if(card.json_data!==undefined)current.json_data=card.json_data;}
 if(doc?.getElementById('avatar_url_pole')?.value===avatar){
  for(const field of fields){const item=items.find(value=>value.target.field===field),el=doc.getElementById(CHAR_INPUTS[field]);if(el&&(el.value===item.before?.content||el.value===item.after?.content))el.value=characterText(card,field);}
  const json=doc.getElementById('character_json_data');if(json&&card.json_data!==undefined&&(json.value===priorJson||json.value===card.json_data))json.value=card.json_data;
 }
}
let hostAdapterPromise;
async function hostAdapter(){
 if(!hostAdapterPromise)hostAdapterPromise=Promise.all([import('/scripts/world-info.js'),import('/scripts/power-user.js'),import('/scripts/personas.js'),import('/script.js'),import('/tauri-bridge.js')]).then(([wi,{power_user},personas,script,bridge])=>{
  const post=async(path,body)=>{const response=await fetch(path,{method:'POST',headers:context()?.getRequestHeaders?.()||{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});if(!response.ok)throw Error(`宿主保存/读取失败 (${response.status})`);return response.json();};
  return {
   captureScope(){const ctx=context(),key=chatKey();if(!ctx||!key)throw Error('请先打开一个聊天');const card=ctx.characters?.[ctx.characterId],avatar=personas.user_avatar;let ref;try{ref=globalThis.__TAURITAVERN__?.api?.chat?.current?.ref?.();}catch{}
    const filename=card?.avatar?.replace(/\.[^.]+$/,'');const extras=wi.world_info?.charLore?.find(e=>e.name===filename)?.extraBooks||[];
    const worldNames=[...new Set([...(wi.selected_world_info||[]),card?.data?.extensions?.world,...extras,ctx.chatMetadata?.world_info,power_user.persona_description_lorebook].filter(Boolean))];
    return {chatKey:key,key,chatRef:clone(ref),characterAvatar:card?.avatar||null,characterName:card?.name||'',personaAvatar:avatar||null,personaName:power_user.personas?.[avatar]||ctx.name1||'',worldNames,availableWorlds:[...(wi.world_names||worldNames)],capturedAt:Date.now()};},
   readWorld:name=>(context()?.loadWorldInfo||wi.loadWorldInfo)(name),readWorldPersisted:name=>post('/api/worldinfo/get',{name}),
   saveWorld:(name,data)=>(context()?.saveWorldInfo||wi.saveWorldInfo)(name,data,true),refreshWorld:name=>{(context()?.reloadWorldInfoEditor||wi.reloadEditor)?.(name);},
   readCharacter:avatar=>post('/api/characters/get',{avatar_url:avatar}),
   syncCharacter:(avatar,card,items)=>syncCharacterState(avatar,card,items),
   checkCharacterEditor(avatar,items){const doc=globalThis.document;if(doc?.getElementById('avatar_url_pole')?.value!==avatar)return;for(const item of items){const el=doc.getElementById(CHAR_INPUTS[item.target.field]);if(el&&el.value!==item.before?.content&&el.value!==item.after?.content)throw Error('角色编辑器存在未保存修改，请先保存后重新审核');}},
   async saveCharacter(avatar,updates,items=[]){
    await post('/api/characters/merge-attributes',{avatar,...updates,data:updates});const card=await post('/api/characters/get',{avatar_url:avatar});
    syncCharacterState(avatar,card,items);return card;},
   readPersona(avatar){return personaDescriptor(power_user,avatar,personas.user_avatar);},
   async readPersonaPersisted(avatar){return (await bridge.invoke('get_personas'))?.[avatar]?.description||null;},
   async savePersona(avatar,state){
    if(!own(power_user.personas||{},avatar)&&!power_user.persona_descriptions?.[avatar]&&avatar!==personas.user_avatar)throw Error('已捕获的 User 设定不存在');power_user.persona_descriptions??={};const descriptor=power_user.persona_descriptions[avatar]??={};for(const field of ['position','depth','role','lorebook','title'])if(!own(state.metadata,field))delete descriptor[field];Object.assign(descriptor,state.metadata,{description:state.content});
    if(personas.user_avatar===avatar){power_user.persona_description=state.content;for(const field of ['position','depth','role','lorebook']){if(own(state.metadata,field))power_user[`persona_description_${field}`]=state.metadata[field];else delete power_user[`persona_description_${field}`];}personas.setPersonaDescription();}
    script.cancelPendingSettingsSave?.();if(await script.saveSettings()!==true)throw Error('User 设定保存未完成，可稍后重试同一批次');
    const persisted=(await bridge.invoke('get_personas'))?.[avatar]?.description;if(!equalState(userState(persisted),state))throw Error('User 设定尚未获得独立持久化回执');const ctx=context();await ctx?.eventSource?.emit?.(ctx.eventTypes.PERSONA_UPDATED,avatar);return persisted;
   },
  };
 }).catch(error=>{hostAdapterPromise=null;throw Error(`当前宿主缺少工作台编辑接口：${error.message}`);});return hostAdapterPromise;
}
const adapterFor=a=>a?Promise.resolve(a):hostAdapter();
export async function captureScope({adapter}={}){return deepFreeze(clone(await(await adapterFor(adapter)).captureScope()));}
function verifyTarget(ref,scope){
 if(!ref||!['world','char','user'].includes(ref.kind))throw Error('编辑目标无效');if(!scopeKey(scope))throw Error('缺少固定聊天身份');
 if(ref.kind==='world'){if(typeof ref.world!=='string'||!ref.world)throw Error('必须指定世界书');if(!scope.worldNames?.includes(ref.world))throw Error('目标世界书不在本次工作台已选择的范围内');if(ref.uid!=null)integer(Number(ref.uid),0,Number.MAX_SAFE_INTEGER,'条目 UID');}
 else{if(!ref.avatar||ref.avatar!==(ref.kind==='char'?scope.characterAvatar:scope.personaAvatar))throw Error('目标身份与本次工作台不一致');if(ref.kind==='char'&&!CHAR_FIELDS.includes(ref.field))throw Error('不支持的角色设定字段');if(ref.kind==='user'&&ref.field!=='description')throw Error('不支持的 User 设定字段');}return ref;
}
export async function listTargets(scope,{adapter,worldNames=scope.worldNames||[]}={}){
 const host=await adapterFor(adapter),targets=[],worlds=[];
 if(scope.personaAvatar){const ref={kind:'user',avatar:scope.personaAvatar,field:'description'},value=userState(await host.readPersona(ref.avatar));if(value)targets.push({...ref,id:targetId(ref),title:`User · ${scope.personaName||ref.avatar}`,selected:true,...value});}
 if(scope.characterAvatar){const card=await host.readCharacter(scope.characterAvatar);if(card)for(const field of CHAR_FIELDS){const ref={kind:'char',avatar:scope.characterAvatar,field};targets.push({...ref,id:targetId(ref),title:`Char · ${scope.characterName||ref.avatar} · ${CHAR_LABELS[field]}`,selected:true,...charState(card,field)});}}
 // Read each bound book once; never scan chat history or every installed book.
 for(const name of [...new Set(worldNames)]){const data=await host.readWorld(name),entries=Object.entries(data?.entries||{});worlds.push({name,count:entries.length,active:(scope.worldNames||[]).includes(name)});for(const [uid,value] of entries){const entry={...value,uid:Number(value.uid??uid)},ref={kind:'world',world:name,uid:entry.uid};targets.push({...ref,id:targetId(ref),title:entry.comment||`${name} #${entry.uid}`,selected:entry.constant===true&&!entry.disable,...worldState(entry,data)});}}
 return {targets,worlds};
}
export async function readTarget(ref,scope,{adapter,persisted=false}={}){verifyTarget(ref,scope);const h=await adapterFor(adapter);if(ref.kind==='world'){const b=await(persisted&&h.readWorldPersisted?h.readWorldPersisted(ref.world):h.readWorld(ref.world));return worldState(b?.entries?.[ref.uid],b);}if(ref.kind==='char')return charState(await h.readCharacter(ref.avatar),ref.field);return userState(await(persisted&&h.readPersonaPersisted?h.readPersonaPersisted(ref.avatar):h.readPersona(ref.avatar)));}
function reference(v){return v?Object.fromEntries(['id','kind','world','uid','avatar','field'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]])):null;}
function parseRef(value,targets){if(typeof value==='string'){const found=targets.find(t=>t.id===value);if(found)return reference(found);const [kind,encoded,...rest]=value.split(':');if(['world','char','user'].includes(kind)&&encoded&&rest.length===1)return kind==='world'?{kind,world:decodeURIComponent(encoded),uid:Number(rest[0]),id:value}:{kind,avatar:decodeURIComponent(encoded),field:rest[0],id:value};throw Error('未找到指定目标，请使用已展示的目标 ID');}if(value?.id){const found=targets.find(t=>t.id===value.id);if(found)return reference(found);}return reference(value);}
function patchText(content,edits){
 if(!Array.isArray(edits)||!edits.length||edits.length>200)throw Error('补丁必须包含 1–200 处修改');
 const ranges=edits.map(e=>{const from=textValue(e.oldText),to=textValue(e.newText??'');if(!from)throw Error('补丁原文不得为空');const at=content.indexOf(from);if(at<0||content.indexOf(from,at+1)>=0)throw Error('补丁原文未唯一命中；请扩大包含上下文的原文范围');return {at,end:at+from.length,to};}).sort((a,b)=>a.at-b.at);
 for(let i=1;i<ranges.length;i++)if(ranges[i].at<ranges[i-1].end)throw Error('同一操作中的补丁范围重叠');for(const e of ranges.reverse())content=content.slice(0,e.at)+e.to+content.slice(e.end);return textValue(content);
}
export async function prepareOperations(operations,{scope,targets=[],adapter}={}){
 if(!Array.isArray(operations)||!operations.length||operations.length>100)throw Error('每批需包含 1–100 项操作');const staged=new Map();let index=0;
 for(const op of operations){const action=op.action||op.op;if(!['create','replace','patch','delete'].includes(action))throw Error('不支持的编辑操作');const ref=parseRef(op.target||{kind:op.kind,world:op.world,uid:op.uid,avatar:op.avatar,field:op.field},targets);verifyTarget(ref,scope);
  if(action==='create'&&ref.kind!=='world')throw Error('只能创建世界书条目；User/Char 请修改已有字段');if(action==='create'){if(ref.uid!=null)throw Error('创建条目不能指定现有 UID');ref.id=ref.id||`world:${encode(ref.world)}:new:${index}`;}else ref.id=ref.id||targetId(ref);
  let item=staged.get(ref.id);if(!item){const known=targets.find(t=>t.id===ref.id),before=action==='create'?null:known?{content:known.content,metadata:clone(known.metadata||{}),...(known.raw?{raw:clone(known.raw)}:{}),...(known.original?{original:clone(known.original)}:{})}:await readTarget(ref,scope,{adapter});if(action!=='create'&&!before)throw Error('目标条目已不存在');item={id:op.id||`item-${index}`,target:ref,title:known?.title||op.title||op.metadata?.comment||ref.world||ref.field,action,before:clone(before),after:clone(before),accepted:true};staged.set(ref.id,item);}
  if(item.after===null&&action!=='create')throw Error('不能继续修改本批已删除的目标');if(action==='delete')item.after=ref.kind==='world'?null:{...item.after,content:''};
  else{const prior=item.after||{content:'',metadata:clone(DEFAULTS)},meta={...prior.metadata,...metadata(op.metadata||op.after?.metadata||{},ref.kind)},content=action==='patch'?patchText(prior.content,op.edits):textValue(op.content??op.after?.content??(action==='create'?'':prior.content));item.after={...prior,content,metadata:meta};}
  item.action=item.before===null?'create':item.after===null?'delete':'replace';item.baseHash=stableValue(comparable(item.before));index++;
 }
 return [...staged.values()].filter(i=>!(i.before===null&&i.after===null));
}
function putPath(object,path,value){const keys=path.split('.'),last=keys.pop();for(const key of keys)object=object[key]??={};object[last]=clone(value);}
function getPath(object,path){for(const key of path.split('.')){if(!object||!own(object,key))return {present:false};object=object[key];}return {present:true,value:object};}
function removePath(object,path){const keys=path.split('.'),last=keys.pop();for(const key of keys){object=object?.[key];if(!object)return;}if(object)delete object[last];}
function updateWorld(book,item){
 const uid=item.target.uid;if(item.after===null){delete book.entries[uid];if(Array.isArray(book.originalData?.entries)){const byUid=originalIndex(book);byUid.delete(String(uid));book.originalData.entries=book.originalData.entries.filter(e=>String(e.uid)!==String(uid));originalIndexes.set(book,{entries:book.originalData.entries,byUid});}return;}
 const base={...(book.entries[uid]||item.after.raw||{})};for(const key of WORLD_KEYS)delete base[key];
 const entry={...base,...clone(item.after.metadata),uid:Number(uid),content:item.after.content};book.entries[uid]=entry;
 if(Array.isArray(book.originalData?.entries)){const byUid=originalIndex(book);let original=byUid.get(String(uid));if(!original){original=clone(item.after.original)||{uid:Number(uid),id:Number(uid),extensions:{}};book.originalData.entries.push(original);byUid.set(String(uid),original);}original.content=entry.content;
  for(const [key,path] of Object.entries(ORIGINAL)){if(own(item.after.metadata,key))putPath(original,path,key==='disable'?!item.after.metadata[key]:item.after.metadata[key]);else{const prior=getPath(item.after.original,path);if(prior.present)putPath(original,path,prior.value);else removePath(original,path);}}
 }
}
let writeQueue=Promise.resolve();
export function applyReviewedItems(items,options={}){const task=()=>applyItems(items,options),operation=writeQueue.then(task,task);writeQueue=operation.catch(()=>{});return operation;}
// A user's rejection cancels an uncertain intent; it never authorizes replaying
// its proposed text. Reconcile disk and working cache under the same write queue.
export function reconcileSkippedItems(items,options={}){const task=()=>reconcileSkips(items,options),operation=writeQueue.then(task,task);writeQueue=operation.catch(()=>{});return operation;}
async function reconcileSkips(items,{scope,adapter,onResult=async()=>{}}){
 if(!items.length)return [];const host=await adapterFor(adapter),outcomes=[],groups=new Map();
 const report=async(item,status,extra={})=>{const result={id:item.id,itemId:item.id,target:clone(item.target),status,...extra};await onResult(result,item);outcomes.push(result);};
 for(const value of items){const item=clone(value);verifyTarget(item.target,scope);const key=item.target.kind==='world'?`world:${item.target.world}`:`${item.target.kind}:${item.target.avatar}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 for(const group of groups.values()){
  const first=group[0],kind=first.target.kind;
  const read=async(persisted)=>kind==='world'?clone(await(persisted?host.readWorldPersisted(first.target.world):host.readWorld(first.target.world))):kind==='char'?await host.readCharacter(first.target.avatar):await(persisted?host.readPersonaPersisted(first.target.avatar):host.readPersona(first.target.avatar));
  const state=(value,item)=>kind==='world'?worldState(value?.entries?.[item.target.uid],value):kind==='char'?charState(value,item.target.field):userState(value);
  const applied=(item,card)=>{if(kind==='char')host.syncCharacter?.(first.target.avatar,card,[item]);return report(item,'applied',{recovered:true,alreadyApplied:true,error:'本项已于先前保存，跳过不能撤销已生效内容；可使用快照创建回退草案'});};
  try{
   // No fallback to a working cache is permitted for cancellation evidence.
   const durable=await read(true),working=await read(false),pending=[];
   for(const item of group){
    const disk=state(durable,item),live=state(working,item);
    if(equalState(disk,item.after)&&!equalState(item.before,item.after)){await applied(item,durable);continue;}
    if(!equalState(disk,item.before)){await report(item,'unknown',{error:'目标持久化版本与本次前后版本均不一致，未取消保存意图；请核对快照'});continue;}
    if(equalState(live,item.before)){await report(item,'skipped',{reconciled:true});continue;}
    if(equalState(live,item.after)){pending.push(item);continue;}
    await report(item,'unknown',{error:'宿主工作文档还有其他修改，无法安全撤销本次未落盘内容；未写入任何新内容'});
   }
   if(!pending.length)continue;
   // The cache may still contain the proposed text in TT's dirty queue. Restore
   // only those targets, preserve every other entry, and await the queue flush.
   const latest=await read(false),reset=[];
   for(const item of pending){const current=state(latest,item);if(equalState(current,item.before))await report(item,'skipped',{reconciled:true});else if(equalState(current,item.after))reset.push(item);else await report(item,'unknown',{error:'取消保存前目标再次变化，保留待核对状态'});}
   if(!reset.length)continue;
   if(kind==='world'){for(const item of reset)updateWorld(latest,{target:item.target,after:item.before});await host.saveWorld(first.target.world,latest);}
   else if(kind==='user')await host.savePersona(first.target.avatar,reset[0].before);
   else throw Error('无法确认角色编辑器的未保存状态，请保存或回退宿主编辑器后重试');
   const confirmed=await read(true),confirmedWorking=await read(false);
   for(const item of reset){if(equalState(state(confirmed,item),item.before)&&equalState(state(confirmedWorking,item),item.before))await report(item,'skipped',{reconciled:true,revertedWorkingCopy:true});else await report(item,'unknown',{error:'取消后的工作文档或持久化回执未匹配，保留待核对状态'});}
   if(kind==='world')host.refreshWorld?.(first.target.world);
  }catch(error){for(const item of group)if(!outcomes.some(o=>o.itemId===item.id))await report(item,'unknown',{error:'跳过前未能确认宿主持久化状态：'+String(error?.message||error)});}
 }
 return outcomes;
}
async function applyItems(items,{scope,batchId,adapter,beforeWrite=async()=>{},onResult=async()=>{}}){
 if(!Array.isArray(items)||items.length>100)throw Error('审核项数量无效');if(!items.length)return [];
 const host=await adapterFor(adapter),outcomes=[],groups=new Map();
 const report=async(item,status,extra={})=>{const result={id:item.id,itemId:item.id,target:clone(item.target),status,...extra};await onResult(result,item);outcomes.push(result);};
 for(const source of items){const item=clone(source);if(item.accepted===false){await report(item,'skipped');continue;}verifyTarget(item.target,scope);if(item.after){textValue(item.after.content);metadata(item.after.metadata||{},item.target.kind);}const key=item.target.kind==='world'?`world:${item.target.world}`:`${item.target.kind}:${item.target.avatar}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 for(const group of groups.values()){
  const first=group[0],kind=first.target.kind;let source,ready=[],recoverySource,writeStarted=false;
  const read=async(persisted=false)=>kind==='world'?clone(await(persisted&&host.readWorldPersisted?host.readWorldPersisted(first.target.world):host.readWorld(first.target.world))):kind==='char'?await host.readCharacter(first.target.avatar):await(persisted&&host.readPersonaPersisted?host.readPersonaPersisted(first.target.avatar):host.readPersona(first.target.avatar));
  const state=(value,item)=>kind==='world'?worldState(value?.entries?.[item.target.uid],value):kind==='char'?charState(value,item.target.field):userState(value);
  try{
   source=await read();if(!source)throw Error('目标世界书/设定不存在');if(kind==='world'&&!source.entries)throw Error('世界书结构无效');
   const allocated=new Set(kind==='world'?Object.keys(source.entries):[]);let nextUid=0;
   for(const item of group){
    if(kind==='world'&&item.before===null&&item.target.uid==null){while(allocated.has(String(nextUid)))nextUid++;const uid=nextUid++;allocated.add(String(uid));item.target={...item.target,uid,id:targetId({...item.target,uid})};source.entries[uid]={uid,__reserved:true};}
    const current=kind==='world'&&source.entries[item.target.uid]?.__reserved?null:state(source,item);
    if(equalState(current,item.after)&&item.intent){recoverySource??=await read(true);const durable=state(recoverySource,item);if(equalState(durable,item.after)){if(kind==='char')host.syncCharacter?.(first.target.avatar,recoverySource,[item]);await report(item,'applied',{recovered:true});continue;}if(equalState(durable,item.before)){item.cacheRetry=true;ready.push(item);continue;}}
    if(!equalState(current,item.before)){await report(item,'conflict',{error:'目标在生成或审核期间已有其他修改，请重新读取后审核'});continue;}
    if(equalState(item.before,item.after)){await report(item,'skipped',{reason:'unchanged'});continue;}
    if(kind==='world'){item.before=clone(current);if(source.entries[item.target.uid]?.__reserved)delete source.entries[item.target.uid];updateWorld(source,item);item.after=worldState(source.entries[item.target.uid],source);}
    ready.push(item);
   }
   if(!ready.length)continue;if(kind==='char')host.checkCharacterEditor?.(first.target.avatar,ready);
   await beforeWrite(ready,{scope,batchId});
   // Journalling yields; re-read once and merge targets into the newest book.
   // Other entries may have changed. A changed reviewed target is left alone.
   source=await read();const writable=[];
   for(const item of ready){const current=state(source,item);if(!equalState(current,item.before)&&!equalState(current,item.after)){await report(item,'conflict',{error:'保存前目标发生变化，已保留该项等待重新审核'});}else if(kind==='world'&&equalState(current,item.before)&&item.before?.raw&&!sameValue(current,item.before)){await report(item,'conflict',{error:'保存前该条目的其他属性发生变化，请重新审核'});}else writable.push(item);}
   ready=writable;if(!ready.length)continue;writeStarted=true;
   if(kind==='world'){for(const item of ready)updateWorld(source,item);await host.saveWorld(first.target.world,source);}
   else if(kind==='char'){host.checkCharacterEditor?.(first.target.avatar,ready);await host.saveCharacter(first.target.avatar,Object.fromEntries(ready.map(i=>[i.target.field,i.after.content])),ready);}
   else await host.savePersona(first.target.avatar,ready[0].after);
   const persisted=await read(true);for(const item of ready){const ok=equalState(state(persisted,item),item.after);await report(item,ok?'applied':'unknown',ok?{}:{error:'持久化内容未匹配；请重试恢复同一批次'});}if(kind==='world')host.refreshWorld?.(first.target.world);
  }catch(error){
   const pending=ready.length?ready:group.filter(item=>!outcomes.some(o=>o.id===item.id));let persisted;
   if(writeStarted||pending.some(i=>i.intent))try{persisted=await read(true);}catch{}
   for(const item of pending){if(outcomes.some(o=>o.id===item.id))continue;const current=persisted===undefined?undefined:state(persisted,item);if(current!==undefined&&equalState(current,item.after)){if(kind==='char')host.syncCharacter?.(first.target.avatar,persisted,[item]);await report(item,'applied',{recovered:true});}else await report(item,!writeStarted||(current!==undefined&&equalState(current,item.before))?'failed':'unknown',{error:String(error?.message||error)});}
  }
 }
 return outcomes;
}
