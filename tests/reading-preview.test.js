import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { readingModes } from '../lib/reading-preview.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function open(source,{formatter,mode='plain',single=false,offset=20,floor=21}={}){
    const {document}=parseHTML('<html><body><section data-theme="light"><dialog></dialog></section></body></html>');
    globalThis.document=document;
    const ctx={chat:[{},{}],messageFormatting:formatter};
    globalThis.SillyTavern={getContext:()=>ctx};
    const root=document.querySelector('section'),dialog=root.querySelector('dialog');dialog.open=true;
    const prefs={readingMode:mode},view={root,prefs,savePrefs:p=>Object.assign(prefs,p),guard:fn=>(...args)=>fn(...args)};
    const modes=readingModes(view,dialog,source,{mes:source,name:'角色',is_user:false},floor,{host:{offset},alive:()=>true},single);
    dialog.append(modes);
    return {dialog,prefs,pick:label=>[...modes.querySelectorAll('button')].find(b=>b.textContent===label).click(),
        doc:()=>parseHTML(modes.querySelector('iframe').srcdoc).document};
}

test('纯文本零格式化，前端对当前原文只应用一次宿主规则并保留样式及折叠',async()=>{
    const source='<time>21:41</time>\n<sxrp guests="槐下听雨、无字碑">[[沈诀@s]] 台词</sxrp>';
    const calls=[];
    const ui=open(source,{formatter:(...args)=>{
        calls.push(args);return '<style>.mes_text .clock{color:green}</style><span class="clock">21:41</span><details><summary>二人私信</summary>台词 $&</details>';
    }});
    assert.equal(calls.length,0);assert.ok(ui.dialog.querySelector('.mn-reading'));ui.pick('前端');await tick();
    assert.deepEqual(calls,[[source,'角色',false,false,1,{},false]]);
    const doc=ui.doc();
    assert.equal(doc.querySelector('.mes_text details').textContent,'二人私信台词 $&');
    assert.equal(doc.querySelector('.mes_text style').textContent,'.mes_text .clock{color:green}');
    assert.equal(doc.querySelector('.clock').textContent,'21:41');
    ui.pick('纯文本');ui.pick('前端');await tick();
    assert.equal(calls.length,1);assert.equal(ui.prefs.readingMode,'frontend');
});

test('单条私信使用自己的切片，独立显示隐藏页；普通楼层保留可切换的多页界面',async()=>{
    const page='<div hidden data-tab="乙 · 6" style="display:none"><b style="color:red">第二封</b></div>';
    let seen;
    const ui=open(page,{single:true,offset:40,floor:5,mode:'frontend',formatter:(text,_name,_sys,_user,id)=>{seen=[text,id];return text;}});
    await tick();assert.deepEqual(seen,[page,-1]);
    assert.ok(!ui.doc().querySelector('[data-tab]').hasAttribute('hidden'));
    const all='<div data-nvwa-ui="新信"><div data-nvwa-tabs><div data-tab="甲">第一封</div>'+page+'</div></div>';
    const both=open(all,{mode:'frontend',formatter:t=>t});await tick();
    assert.equal(both.doc().querySelectorAll('.mn-tab-radio').length,2);
    assert.equal(both.doc().querySelectorAll('.mn-tab-page').length,2);
});

test('无宿主格式化也可读原始 HTML，HTML 围栏可显示布局，切换后旧请求不覆盖纯文本',async()=>{
    const ui=open('<div style="border-radius:6px">原始气泡</div>',{mode:'frontend'});
    await tick();await new Promise(r=>setTimeout(r,10));
    assert.equal(ui.doc().querySelector('.mes_text div').getAttribute('style'),'border-radius:6px');
    assert.ok(ui.dialog.textContent.includes('当前宿主未提供'));
    const fenced=open('正文',{mode:'frontend',formatter:()=>'<pre><code class="language-html">&lt;details open&gt;&lt;summary&gt;时间&lt;/summary&gt;22:00&lt;/details&gt;</code></pre>'});
    await tick();assert.equal(fenced.doc().querySelector('summary').textContent,'时间');
    let finish;
    const slow=open('纯文本',{mode:'frontend',formatter:()=>new Promise(resolve=>{finish=resolve;})});
    slow.pick('纯文本');finish('<p>旧结果</p>');await tick();
    assert.equal(slow.dialog.querySelector('iframe'),null);
    assert.equal(slow.dialog.querySelector('.mn-reading').textContent,'纯文本');
});
