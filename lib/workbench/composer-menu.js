import { button, node } from '../dom.js';

/** Small, upward-opening selector. Listeners exist only while it is open. */
export function composerMenu(label,{options,onSelect,onManage}={}){
    const root=node('div','mn-wb-picker'),trigger=button('',toggle,'mn-wb-chip');
    const caption=node('span'),arrow=node('span','mn-wb-chevron','⌃');arrow.setAttribute('aria-hidden','true');
    trigger.append(caption,arrow);trigger.setAttribute('aria-label',label);trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    const menu=node('div','mn-wb-popover');menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);menu.hidden=true;
    root.append(trigger,menu);let current='',opened=false;
    function close(){
        if(!opened)return;opened=false;menu.hidden=true;trigger.setAttribute('aria-expanded','false');
        document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);
    }
    function outside(event){if(!root.contains(event.target))close();}
    function key(event){
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();trigger.focus({preventScroll:true});return;}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        const choices=[...menu.querySelectorAll('[role=option]')];if(!choices.length)return;
        const i=choices.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?choices.length-1:
            (i+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
        event.preventDefault();choices[next].focus({preventScroll:false});
    }
    function toggle(){
        if(opened){close();return;}if(trigger.disabled)return;
        menu.replaceChildren();
        for(const option of options?.()||[]){
            const [id,title,description]=option;
            const item=button('',()=>{close();onSelect?.(id);},'mn-wb-menu-option');
            item.append(node('span','',title));if(description)item.append(node('small','mn-hint',description));
            item.setAttribute('role','option');item.setAttribute('aria-selected',String(id===current));menu.append(item);
        }
        if(onManage)menu.append(button('管理 API…',()=>{close();onManage();},'mn-wb-menu-manage'));
        menu.hidden=false;opened=true;trigger.setAttribute('aria-expanded','true');
        document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);
        menu.querySelector('[aria-selected=true]')?.focus({preventScroll:true});
    }
    return {root,trigger,close,update(value,title,disabled=false){
        current=value;caption.textContent=title;trigger.title=label+'：'+title;trigger.disabled=disabled;
        if(disabled)close();
    }};
}
