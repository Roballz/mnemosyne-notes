import { Marked } from './vendor/marked.js';
import { node } from '../dom.js';

// Own parser, independent of story regex/macros and the host's code-block theme.
// Raw HTML stays literal. Even parser-generated HTML is rebuilt with a whitelist;
// no model-supplied styles, handlers, images, embeds or attributes reach the page.
const escape = text => String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const parser = new Marked({gfm:true,breaks:true,renderer:{html:token=>escape(token.text)}});
const tags = new Set('P BR STRONG EM DEL S CODE PRE BLOCKQUOTE UL OL LI H1 H2 H3 H4 H5 H6 HR TABLE THEAD TBODY TR TH TD A'.split(' '));
const denied = new Set('SCRIPT STYLE IFRAME OBJECT EMBED SVG MATH FORM INPUT BUTTON SELECT TEXTAREA TEMPLATE LINK META'.split(' '));

function appendSafe(source,parent){
    if(source.nodeType===3){parent.append(document.createTextNode(source.data));return;}
    if(source.nodeType!==1||denied.has(source.tagName))return;
    if(source.tagName==='IMG'){if(source.getAttribute('alt'))parent.append(document.createTextNode(source.getAttribute('alt')));return;}
    const target=tags.has(source.tagName)?node(source.tagName.toLowerCase()):parent;
    if(target!==parent){
        if(source.tagName==='A'){
            const href=source.getAttribute('href')||'';
            if(/^(https?:\/\/|mailto:)/i.test(href)){
                target.setAttribute('href',href);target.setAttribute('target','_blank');target.setAttribute('rel','noopener noreferrer');
            }
        }
        if(source.tagName==='OL'&&/^\d{1,6}$/.test(source.getAttribute('start')||''))target.setAttribute('start',source.getAttribute('start'));
        if(source.tagName==='TH')target.setAttribute('scope','col');
        if(source.tagName==='TABLE'){
            const wrap=node('div','mn-wb-table');wrap.append(target);parent.append(wrap);
        }else parent.append(target);
    }
    for(const child of source.childNodes)appendSafe(child,target);
}

/** Render completed messages once; live deltas use plain text nodes in view.js. */
export function markdown(text,className=''){
    const output=node('div','mn-wb-markdown'+(className?' '+className:''));
    const template=node('template');
    try{
        template.innerHTML=parser.parse(String(text||''));
        for(const child of template.content.childNodes)appendSafe(child,output);
    }catch{
        output.textContent=String(text||'');output.classList.add('mn-wb-prose');
    }
    return output;
}
