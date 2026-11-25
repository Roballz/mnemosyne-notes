import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { openMaterials } from '../lib/workbench/materials.js';
import { captureWorkbenchContext, assembleWorkbenchPrompt, runtimeCapture } from '../lib/workbench/context.js';

const copy=value=>structuredClone(value);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('grouped material picker enables books before entries and only renders bounded expanded groups',async t=>{
    const oldDocument=globalThis.document;
    const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=oldDocument;});
    let refreshes=0,saved;
    const targets=[{id:'u',kind:'user',title:'User设定',content:'合成用户'},...Array.from({length:95},(_,index)=>({id:'world:A:'+index,kind:'world',world:'甲书',title:'合成条目'+index,content:'示例正文',metadata:{constant:true}})),{id:'world:B:1',kind:'world',world:'全局乙',title:'乙条目',content:'未选择内容',metadata:{constant:true}}];
    const c={targets,worlds:[{name:'甲书'},{name:'全局乙'}],scope:{worldNames:['甲书','全局乙']},state:{},selected:new Set(['u']),enabledWorlds:new Set(),job:null,
        refreshTargets:async()=>{refreshes++;},select:async(ids,worlds)=>{saved={ids:[...ids],worlds:[...worlds]};}};
    const view={controller:c,guard:fn=>fn,render:()=>{},dialog:()=>{const el=document.createElement('dialog'),body=document.createElement('div');el.append(body);document.body.append(el);el.close=()=>{el.remove();};return {el,body};}};
    const dialog=await openMaterials(view);
    assert.equal(dialog.querySelectorAll('.mn-wb-material-group[data-kind="world"]').length,2);
    assert.equal(dialog.querySelectorAll('.mn-wb-material').length,1,'closed worldbooks do not allocate entry nodes');
    const enable=dialog.querySelector('[aria-label="启用世界书 甲书"]');
    enable.checked=true;enable.onchange();
    assert.equal(dialog.querySelectorAll('.mn-wb-material').length,41,'only the first 40 entries of an expanded book render');
    const choose=dialog.querySelector('[aria-label="选择 合成条目0"]');choose.checked=true;choose.onchange();
    const other=dialog.querySelector('[aria-label="启用世界书 全局乙"]');assert.equal(other.checked,false);
    const selectAll=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='全选已启用');selectAll.click();
    const save=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='使用所选材料');save.click();await tick();
    assert.equal(refreshes,1,'selection and expansion do not refresh the host catalogue');
    assert.deepEqual(saved.worlds,['甲书']);assert.equal(saved.ids.length,96);assert.ok(!saved.ids.includes('world:B:1'));
});

test('final capture strips stale disabled book selections and unselected host material before prompt assembly',async t=>{
    const oldST=globalThis.SillyTavern,oldTT=globalThis.__TAURITAVERN__;
    t.after(()=>{globalThis.SillyTavern=oldST;globalThis.__TAURITAVERN__=oldTT;});
    globalThis.__TAURITAVERN__=undefined;
    globalThis.SillyTavern={getContext:()=>({characterId:0,characters:[{avatar:'test.png',chat:'materials'}]})};
    const scope={chatKey:JSON.stringify(['character','test.png','materials']),worldNames:['甲书','禁用全局'],availableWorlds:['甲书','禁用全局']};
    let assembled;
    const runtime={
        script:{extension_prompts:{cachedWorld:{value:'宿主旧世界内容'}}},
        openai:{normalizeChatCompletionSettingsForPromptAssembly:value=>({prompts:[{identifier:'main',content:'默认'}],...copy(value)})},
        macros:{captureContext:()=>({engine:'new',names:{user:'User',char:'Char'},character:{description:'未选角色正文',persona:'未选用户正文'},chat:{},state:{},settings:{},variables:{local:{},global:{}},extensionPrompts:{cachedWorld:{value:'宿主旧世界内容'}},now:1})},
        frozen:{updateFrozenMacroContext:(snapshot,macro)=>({...snapshot,macroContext:copy(macro),variables:copy(macro.variables)}),buildFrozenRunInputSnapshot:copy},
        api:{chat:{current:{ref:()=>({kind:'character',characterId:'test.png',fileName:'materials'})}},agent:{promptAssembly:{buildSnapshot:async request=>{
            assembled=copy(request);const p=request.frozenRunInputSnapshot.promptInputs;
            const text=[request.agentSystemPrompt,p.worldInfoBefore,p.worldInfoAfter,...Object.values(p.extensionPrompts).map(x=>x.value),...p.messages.map(m=>m.content)].filter(Boolean).join('\n');
            return {promptSnapshot:{messages:[{role:'system',content:text}]}};
        }}}},
    };
    const capture=await captureWorkbenchContext({runtime,scope,reader:{offset:0,sync:async()=>1,read:async()=>[{mes:'合成正文',is_user:false}]},firstFloor:0,lastFloor:0,
        sourceId:'independent',channel:{model:'synthetic'},enabledWorlds:['甲书'],selectedTargets:[
            {id:'world:a:1',kind:'world',world:'甲书',uid:1,content:'已选事实',metadata:{position:0}},
            {id:'world:b:2',kind:'world',world:'禁用全局',uid:2,content:'禁用秘密正文',metadata:{position:0}},
        ]});
    assert.deepEqual(capture.selectedTargets.map(target=>target.id),['world:a:1']);
    assert.deepEqual(capture.scope.worldNames,['甲书']);assert.equal(Object.hasOwn(capture.scope,'availableWorlds'),false);
    const frozen=JSON.stringify(runtimeCapture(capture).frozen);
    assert.doesNotMatch(frozen,/禁用秘密正文|禁用全局|未选角色正文|未选用户正文|宿主旧世界内容/);
    await assembleWorkbenchPrompt(capture,[]);
    assert.doesNotMatch(JSON.stringify(assembled),/禁用秘密正文|禁用全局|未选角色正文|未选用户正文|宿主旧世界内容/);
    assert.match(JSON.stringify(assembled),/已选事实/);
});
