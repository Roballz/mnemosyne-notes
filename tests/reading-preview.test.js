import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { readingModes } from '../lib/reading-preview.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function open(source,{formatter,mode='plain',single=false,offset=20,floor=21,full=source,from=0}={}){
    const {document}=parseHTML('<html><body><section data-theme="light"><dialog></dialog></section></body></html>');
    globalThis.document=document;
    const ctx={chat:[{},{}],messageFormatting:formatter};
    globalThis.SillyTavern={getContext:()=>ctx};
    const root=document.querySelector('section'),dialog=root.querySelector('dialog');dialog.open=true;
    const prefs={readingMode:mode},view={root,prefs,savePrefs:p=>Object.assign(prefs,p),guard:fn=>(...args)=>fn(...args)};
    const modes=readingModes(view,dialog,source,{mes:full,name:'角色',is_user:false},floor,{host:{offset},alive:()=>true},single?{from,to:from+source.length}:null);
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

test('按旧索引位置恢复选中私信的祖先和共享样式，同名、同文标签不会串页',async()=>{
    const page='<div data-tab="甲 · 6" hidden><span style="background:var(--chip)">重复正文 $&</span></div>';
    const other='<div data-tab="乙"><style>.other{color:pink}</style>另一人的私信</div>';
    const full='<section class="theme"><div data-nvwa-ui="一" style="color:blue"><div data-nvwa-tabs>'+page+'</div></div>'+
        '<div data-nvwa-ui="二" style="background:#1d2026;color:#d9d4c7"><style>.theme .mine{opacity:.9}</style>'+
        '<div data-nvwa-tabs class="mine" style="--chip:#2a2f37">'+other+page+'</div><style>.mine span{padding:6px}</style></div></section>';
    const formats=[];
    const ui=open(page,{single:true,full,from:full.lastIndexOf(page),formatter:s=>{formats.push(s);return s;}});
    assert.equal(formats.length,0);ui.pick('前端');await tick();
    assert.equal(formats.length,1);
    assert.ok(formats[0].includes(page));assert.doesNotMatch(formats[0],/color:blue|另一人|color:pink/);
    const doc=ui.doc(),el=doc.querySelector('.theme [data-nvwa-ui="二"] .mine [data-tab]');
    assert.ok(el);assert.equal(el.hasAttribute('hidden'),false);assert.equal(el.textContent,'重复正文 $&');
    assert.match(el.parentElement.getAttribute('style'),/--chip:#2a2f37/);
    assert.match(el.parentElement.parentElement.getAttribute('style'),/color:#d9d4c7/);
    assert.equal(doc.querySelectorAll('.mes_text style').length,2);assert.equal(doc.querySelectorAll('.mn-tab-radio').length,0);
    ui.pick('纯文本');assert.equal(ui.dialog.querySelector('.mn-reading').textContent,'重复正文 $&');
    ui.pick('前端');await tick();assert.equal(formats.length,1);
});

test('楼层与单条消息各自留白，基础字体不覆盖卡片自带的字号和背景',async()=>{
    const source='<div data-nvwa-ui="私信" style="background:#1f2025;font-size:13px"><span style="background:#473b2d">来信</span></div>';
    const floor=open(source,{mode:'frontend',formatter:s=>s});await tick();
    const d=floor.doc();
    assert.ok(d.querySelector('.mn-floor-prose'));
    assert.match(d.querySelector('head style').textContent,/\.mn-floor-prose\{padding:9px 12px\}/);
    assert.match(d.querySelector('head style').textContent,/font:14px\/1\.65/);
    assert.match(d.querySelector('[data-nvwa-ui]').getAttribute('style'),/background:#1f2025;font-size:13px/);
    assert.match(d.querySelector('.mes_text span').getAttribute('style'),/#473b2d/);
    const direct=open(source,{single:true,mode:'frontend',formatter:s=>s});await tick();
    assert.ok(direct.doc().querySelector('.mn-message-card'));
});

test('只抑制已带引号对白的自动引号，保留内嵌格式和语义引用',async()=>{
    const html='<p><q>“甲说<b>「乙」</b>。”</q> <q>普通引用</q> “原文”</p>';
    const ui=open(html,{mode:'frontend',formatter:s=>s});await tick();
    const doc=ui.doc(),[quoted,semantic]=doc.querySelectorAll('q');
    assert.ok(quoted.classList.contains('mn-literal-quotes'));
    assert.equal(quoted.innerHTML,'“甲说<b>「乙」</b>。”');
    assert.equal(semantic.classList.contains('mn-literal-quotes'),false);
    assert.match(doc.querySelector('head style').textContent,/q\.mn-literal-quotes::after\{content:none\}/);
});
