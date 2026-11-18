import { button, node, reader } from './dom.js';
import { applyReadingFont, chatTypography } from './fonts.js';
import { context } from './host.js';

let legacyCore;
async function formatPreview(source,msg,id) {
    const ctx=context();
    let format=ctx?.messageFormatting || ctx?.messageFormatter?.format || globalThis.SillyTavern?.messageFormatting || globalThis.messageFormatting;
    if(!format){
        legacyCore ??= import('/script.js').catch(()=>null);
        format=(await legacyCore)?.messageFormatting;
    }
    if(format){
        // TauriTavern applies display regex, Markdown and formatter hooks here.
        // Feeding the transformed result through regex again can duplicate markup.
        const html=await format(source,msg.name,!!msg.is_system,!!msg.is_user,id,{},false);
        if(typeof html==='string')return {html};
    }
    const regex=globalThis.ST_API?.regexScript;
    if(regex?.process){
        const result=await regex.process({text:source,placement:msg.is_user?1:2});
        if(typeof result?.text==='string')return {html:result.text};
    }
    return {html:source,hint:'当前宿主未提供消息格式化，显示原文中的 HTML。'};
}

// Old index entries already contain exact offsets. Rebuild the style context
// from the verified floor only when this individual tab is opened in rich mode.
function tabSource(source,full,entry) {
    if(!entry || !Number.isInteger(entry.from) || !Number.isInteger(entry.to))return null;
    const key='data-mn-slot-'+crypto.randomUUID();
    const template=node('template');
    template.innerHTML=full.slice(0,entry.from)+'<div '+key+'></div>'+full.slice(entry.to);
    const fragment=template.content,slot=fragment.querySelector('['+key+']');
    const group=slot?.parentElement,outer=group?.parentElement;
    if(!group?.matches('div[data-nvwa-tabs]') || !outer?.matches('div[data-nvwa-ui]'))return null;

    // Preserve ancestor selectors, custom properties and shared styles in source
    // order. The formatter receives the original page bytes, never sibling text.
    const placeholder=slot.outerHTML;
    let branch=slot,copy=slot.cloneNode(false);
    for(let parent=group;parent;parent=parent.parentNode){
        const shell=parent===fragment ? fragment.ownerDocument.createElement('div') : parent.cloneNode(false);
        for(const child of parent.children){
            if(child===branch)shell.append(copy);
            else if(child.localName==='style')shell.append(child.cloneNode(true));
        }
        if(parent===fragment)return shell.innerHTML.replace(placeholder,()=>source);
        branch=parent;copy=shell;
    }
    return null;
}

const readingStyle=`
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;font:14px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
body>.mes{display:flow-root;box-sizing:border-box}
body>.mn-floor-prose{padding:9px 12px}
body>.mn-message-card{padding:7px}
:where(.mes_text [data-nvwa-ui]){box-shadow:0 1px 3px #0002}
img,svg{max-width:100%}
pre{white-space:pre-wrap}
details>summary{cursor:pointer}
`;
const tabStyle=`
.mn-tabs{display:flex!important;flex-wrap:wrap;gap:.35em;align-items:flex-start}
.mn-tabs>.mn-tab-radio{position:absolute;opacity:0;width:1px;height:1px}
.mn-tabs>label{order:0;cursor:pointer;border:1px solid currentColor;border-radius:1em;padding:.15em .65em;font:inherit}
.mn-tabs>.mn-tab-radio:checked+label{font-weight:700;text-decoration:underline}
.mn-tabs>.mn-tab-radio:focus-visible+label{outline:2px solid currentColor}
.mn-tabs>.mn-tab-page{display:none!important;order:1;width:100%}
.mn-tabs>.mn-tab-radio:checked+label+.mn-tab-page{display:block!important}
`;
function arrangeTabs(root) {
    let group=0;
    for(const tabs of root.querySelectorAll('div[data-nvwa-tabs]')){
        const pages=[...tabs.children].filter(p=>p.matches('div[data-tab]'));
        if(!pages.length)continue;
        const name='mn-preview-tabs-'+(++group);
        tabs.classList.add('mn-tabs');
        pages.forEach((page,i)=>{
            const radio=root.ownerDocument.createElement('input'),label=root.ownerDocument.createElement('label');
            radio.setAttribute('type','radio');radio.name=name;radio.id=name+'-'+i;radio.className='mn-tab-radio';
            if(!i)radio.setAttribute('checked','');
            label.setAttribute('for',radio.id);label.textContent=page.getAttribute('data-tab');
            page.before(radio,label);page.classList.add('mn-tab-page');page.removeAttribute('hidden');
        });
    }
}

// Parse into inert template content. Keep layout, styles and native disclosure,
// while the preview document owns its own CSS, controls and browsing context.
function previewContent(html,isolatedTab) {
    const template=node('template');
    const fenced=/^\s*`{3}html\s*\n([\s\S]*?)\n`{3}\s*$/i.exec(html);
    template.innerHTML=fenced?fenced[1]:html;
    const root=template.content;
    for(const pre of root.querySelectorAll('pre')){
        const code=pre.querySelector('code');
        if(!code || !/(?:^|\s)(?:language-|lang-)?html(?:\s|$)/i.test(code.className+' '+pre.className))continue;
        const part=node('template');part.innerHTML=code.textContent;pre.replaceWith(part.content);
    }
    for(const el of root.querySelectorAll('script,iframe,frame,frameset,object,embed,link,meta,base,template,foreignObject,noscript'))el.remove();
    for(const el of root.querySelectorAll('*')){
        for(const attr of [...el.attributes]){
            const key=attr.name.toLowerCase();
            if(key.startsWith('on') || ['srcdoc','srcset','action','formaction','autofocus','target','ping','poster','background'].includes(key)
                || (key==='href' || key==='xlink:href') && !(el.namespaceURI==='http://www.w3.org/2000/svg' && /^#[\w.-]+$/.test(attr.value))
                || key==='src' && !(el.localName==='img' && /^data:image\//i.test(attr.value)))el.removeAttribute(attr.name);
        }
    }
    if(isolatedTab){
        const page=root.querySelector('[data-tab]');
        if(page){
            page.removeAttribute('hidden');page.removeAttribute('aria-hidden');
            page.style.setProperty('display','block','important');
        }
    } else arrangeTabs(root);
    const content=root.ownerDocument.createElement('div');
    content.className='mes_text';content.append(root);
    return content;
}

function frameFor(html,root,isMessage,isolatedTab,typography,prefs,report) {
    const frame=node('iframe','mn-frontend');
    frame.title='正文前端预览';frame.setAttribute('sandbox','allow-same-origin');
    frame.setAttribute('referrerpolicy','no-referrer');
    const dark=root.dataset.theme!=='light';
    const ink=dark?'#e4eaf0':'#21382d';
    // Message styles emitted by the host may be scoped under .mes_text.
    const content=previewContent(html,isolatedTab);
    const message=content.ownerDocument.createElement('div');message.className='mes';message.append(content);
    message.classList.add(isMessage?'mn-message-card':'mn-floor-prose');
    if(typeof getComputedStyle==='function'){
        const style=getComputedStyle(root);
        const chatStyle=typography.style;
        const names=new Set(Array.from(html.matchAll(/var\(\s*(--[\w-]+)/g),match=>match[1]));
        for(const name of names){
            const value=chatStyle?.getPropertyValue(name) || style.getPropertyValue(name);
            if(value)message.style.setProperty(name,value);
        }
    }
    const policy="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
    frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+
        'html{color-scheme:'+(dark?'dark':'light')+'}body{color:'+ink+'}'+readingStyle+tabStyle+'</style></head><body>'+message.outerHTML+'</body></html>';
    frame.addEventListener('load',()=>{
        const doc=frame.contentDocument;
        if(!doc?.body || !frame.isConnected)return;
        // Standalone cards get a narrow surround tinted from their own surface.
        // Whole-floor prose keeps the notebook paper behind the story.
        const card=isMessage && doc.querySelector('.mes_text [data-nvwa-ui]');
        if(card){
            const style=doc.defaultView.getComputedStyle(card);
            const rgb=/^rgb\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/.exec(style.backgroundColor);
            if(rgb){
                const darkCard=.2126*rgb[1]+.7152*rgb[2]+.0722*rgb[3]<128;
                const surround=darkCard?' 25%, #0e0c11)':' 88%, #918f94)';
                doc.body.style.backgroundColor='color-mix(in srgb, '+style.backgroundColor+surround;
                // Supply contrast only through inheritance. Source declarations win.
                if(style.color===doc.defaultView.getComputedStyle(doc.body).color && darkCard!==dark)
                    doc.body.style.color=darkCard?'#e4eaf0':'#21382d';
            }
        }
        const resize=()=>{
            const box=doc.body.firstElementChild;
            if(box){
                const height=Math.max(box.scrollHeight*(Number(box.style.zoom)||1),box.getBoundingClientRect().height);
                frame.style.height=Math.min(640,Math.max(48,Math.ceil(height || 240)+4))+'px';
            }
        };
        const prose=doc.querySelector('body > .mes');
        if(prose)applyReadingFont(prose,prefs,typography,true).then(note=>{
            if(frame.isConnected && frame.contentDocument===doc){report(note);resize();}
        }).catch(()=>report('字体加载失败，已使用系统字体'));
        resize();doc.addEventListener('toggle',resize,true);doc.addEventListener('change',resize);
        doc.addEventListener('load',resize,true);
    });
    return frame;
}

export function readingModes(view,dialog,source,msg,floor,engine,entry=null) {
    const area=node('div','mn-reader'),bar=node('div','mn-modes'),out=node('div');
    if(!entry)area.classList.add('mn-floor-reader');
    bar.setAttribute('role','group');bar.setAttribute('aria-label','阅读显示方式');
    const fontHint=node('p','mn-hint');
    fontHint.hidden=true;
    const report=message=>{fontHint.textContent=message;fontHint.hidden=!message;};
    let typography;
    const hostStyle=()=>typography ??= chatTypography(floor-engine.host.offset);
    const buttons=new Map();
    let mode,cachedFrame,pending,plain,hint,isolatedTab=false;
    const live=()=>dialog.open && dialog.isConnected && engine.alive();
    async function show(next,save) {
        if(mode===next)return;
        mode=next;
        for(const [id,b] of buttons)b.setAttribute('aria-pressed',String(id===next));
        if(save)view.savePrefs({readingMode:next});
        if(next==='plain'){
            if(!plain){
                plain=reader(source);
                applyReadingFont(plain,view.prefs,view.prefs.readingFont==='theme'?hostStyle():{}).then(report)
                    .catch(()=>report('字体加载失败，已使用系统字体'));
            }
            out.replaceChildren(plain);return;
        }
        if(!cachedFrame){
            out.replaceChildren(node('p','mn-hint','正在排版…'));
            const local=floor-engine.host.offset;
            const id=local>=0 && local<(context()?.chat?.length ?? 0)?local:-1;
            if(!pending){
                const opening=entry && /^<div(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(source);
                isolatedTab=!!opening && /\sdata-tab(?=[\s=/>])/i.test(opening[0]);
                const wrapped=isolatedTab ? tabSource(source,msg.mes,entry) : null;
                const input=wrapped ?? source;
                pending=formatPreview(input,msg,id).catch(()=>({html:input,hint:'宿主格式化失败，显示原文中的 HTML。'}));
            }
            const result=await pending;
            if(!live() || mode!==next)return;
            cachedFrame ??= frameFor(result.html,view.root,!!entry,isolatedTab,hostStyle(),view.prefs,report);
            if(result.hint)hint=node('p','mn-hint',result.hint);
        }
        out.replaceChildren(...(hint?[hint,cachedFrame]:[cachedFrame]));
    }
    for(const [id,label] of [['frontend','前端'],['plain','纯文本']]){
        const b=button(label,view.guard(()=>show(id,true)),'mn-chip');buttons.set(id,b);bar.append(b);
    }
    area.append(bar,out,fontHint);view.guard(()=>show(view.prefs.readingMode==='frontend'?'frontend':'plain',false))();
    return area;
}
