import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { parseHTML } from 'linkedom/worker';
import { meta, storeFont } from '../lib/db.js';
import { applyReadingFont, chatTypography, readingSize } from '../lib/fonts.js';
import { fontBytes, fontSettings } from '../lib/font-settings.js';

const documentFor = () => parseHTML('<html><body><div></div></body></html>').document;
function setup() {
    const doc = globalThis.document = documentFor();
    doc.fonts = new Set();
    const loaded = [];
    globalThis.FontFace = class {
        constructor(family,source,desc) { Object.assign(this,{family,source,desc}); }
        async load() {
            loaded.push(this);
            if (String(this.source).startsWith('local')) throw Error('unavailable');
            return this;
        }
    };
    return {doc, loaded};
}
test('四款离线字体及上游许可随插件提供', async () => {
    for (const name of ['LXGWWenKai','SourceHanSerifCN','SourceHanSansCN','ZhuqueFangsong']) {
        const data = await readFile(new URL('../fonts/' + name + '-Regular.woff2', import.meta.url));
        assert.equal(data.toString('ascii',0,4),'wOF2');
        assert.equal(data.readUInt32BE(8),data.length);
        assert.match(await readFile(new URL('../fonts/' + name + '-LICENSE.txt', import.meta.url),'utf8'),/SIL OPEN FONT LICENSE/);
    }
});

test('纯文本与独立前端共享一次字体加载，调整字号不再解码', async () => {
    const {doc,loaded} = setup(), frame = documentFor(); frame.fonts = new Set();
    const rich = frame.body, plain = doc.body;
    await Promise.all([applyReadingFont(plain,{}),applyReadingFont(rich,{}, {},true)]);
    const face = [...doc.fonts][0];
    assert.equal(face.family,'MnReader-wenkai');
    assert.ok(frame.fonts.has(face));
    await applyReadingFont(rich,{readingSize:21},{},true);
    assert.equal(rich.style.zoom,'1.5');
    assert.equal(plain.style.fontSize,'14px');
    assert.equal(loaded.length,1);
    assert.deepEqual([-1,50,NaN].map(readingSize),[10,28,14]);
});

test('设备无苹方时明确提示，重复打开复用文楷', async () => {
    const {doc,loaded} = setup();
    for(const el of [doc.body,doc.body.firstElementChild])
        assert.match(await applyReadingFont(el,{readingFont:'pingfang'}),/本机未提供苹方，已使用霞鹜文楷/);
    assert.equal(loaded.length,2);
    assert.match(doc.body.style.fontFamily,/wenkai/);
});

test('主题读取正文颜色与父背景，并在独立预览中恢复匹配字体的相对地址和字重', async () => {
    const {doc} = setup(), frame = documentFor(); frame.fonts = new Set();
    doc.body.innerHTML='<div id="chat"><div class="mes" mesid="6"><div class="mes_text">正文</div></div></div>';
    globalThis.getComputedStyle = el => el.matches('.mes_text') ?
        {fontFamily:'"主题字", serif',fontWeight:'500',fontStyle:'italic',color:'rgb(240, 242, 245)',backgroundColor:'transparent'} :
        {backgroundColor:'rgb(32, 33, 34)'};
    const preset = {'font-family':'"主题字"','font-weight':'500',src:'url(../fonts/face.woff2)'};
    const sheet = {href:'https://example.com/css/theme.css',cssRules:[
        {type:5,style:{getPropertyValue:p=>preset[p]||''}},
        {type:5,style:{getPropertyValue:p=>p==='font-family'?'Other':''}}]};
    doc.styleSheets=[sheet,{get cssRules(){throw Error('opaque');}}];
    const target=frame.body;
    target.getBoundingClientRect=()=>({});
    const theme=chatTypography(6);
    await applyReadingFont(target,{readingFont:'theme'},theme,true);
    assert.equal(target.style.backgroundColor,'rgb(32, 33, 34)');
    assert.equal(target.style.color,'rgb(240, 242, 245)');
    assert.equal(target.style.fontWeight,'500');
    assert.equal(target.style.fontFamily,'"主题字", serif');
    assert.equal(frame.fonts.size,1);
    assert.match([...frame.fonts][0].source,/https:\/\/example.com\/fonts\/face.woff2/);
    assert.equal([...frame.fonts][0].desc.weight,'500');
    delete globalThis.getComputedStyle;
});

test('本地和网络字体各导入一次，离线从 IndexedDB 取回，删除同时清理目录和字体', async () => {
    const {doc,loaded} = setup();
    const data = Uint8Array.of(0,1,0,0), file = new Blob([data]), signal=new AbortController().signal;
    const local = await fontBytes(file,'',signal);
    assert.deepEqual(new Uint8Array(local),data);
    let requests=0;
    const original=globalThis.fetch;
    try {
        globalThis.fetch=async()=>{requests++;return new Response(data);};
        const bytes=await fontBytes(null,'https://example.org/font.ttf',signal);
        await storeFont('custom-test','自定义',bytes);
        assert.deepEqual(await meta('fontCatalog'),[{id:'custom-test',label:'自定义'}]);
        globalThis.fetch=()=>{throw Error('offline');};
        await applyReadingFont(doc.body,{readingFont:'custom-test'});
        assert.equal(requests,1);
        assert.deepEqual(new Uint8Array(loaded[0].source),data);
        await assert.rejects(fontBytes(file,'https://example.org/font.ttf',signal),/单独/);
        await assert.rejects(fontBytes(null,'file:///font.ttf',signal),/HTTP/);
        await storeFont('custom-test');
        assert.deepEqual(await meta('fontCatalog'),[]);
        assert.equal(await meta(['fontFile','custom-test']),undefined);
    } finally {globalThis.fetch=original;}
});

test('字号滑动只更新样张，松手保存一次', () => {
    const {doc}=setup(), prefs={readingFont:'sans',readingSize:14}, changes=[];
    const wrap=fontSettings({prefs,savePrefs:patch=>changes.push(patch)});
    doc.body.append(wrap);
    const slider=wrap.querySelector('input[type="range"]');
    slider.value='18';slider.oninput();slider.value='21';slider.oninput();
    assert.equal(wrap.querySelector('.mn-font-sample').style.fontSize,'21px');
    assert.equal(changes.length,0);
    slider.onchange();assert.deepEqual(changes,[{readingSize:21}]);
});
