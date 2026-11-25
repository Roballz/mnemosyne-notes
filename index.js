import { Engine } from './lib/engine.js';
import { Host, chatKey, centeredFloor, context } from './lib/host.js';
import { button, icon, node } from './lib/dom.js';
import { applyBubble, bubbleDefaults } from './lib/appearance.js';
import { extensionSettings, NotebookVersion } from './lib/extension-settings.js';
import { View } from './lib/view.js';

const surfaceState=globalThis[Symbol.for('mnemosyne-notes.surface')] ??= {};
function mount(element) {
    const container=element.querySelector('.mes_block')||element;
    if(container.querySelector(':scope > .mn-floor-action'))return;
    container.classList.add('mn-floor-host');
    const b=button('',()=>surfaceState.bookmark?.(Number(element.getAttribute('mesid'))),'mn-floor-action');
    b.title='收藏此楼';b.setAttribute('aria-label',b.title);b.append(icon('mark'));container.append(b);
    return ()=>{b.remove();container.classList.remove('mn-floor-host');};
}

export function registerChatSurface() {
    const api=globalThis.__TAURITAVERN__?.api?.chatSurface;
    if(!api?.isManagedOwnershipRequired?.() || surfaceState.attempted)return;
    if(typeof api.registerParticipant!=='function')return;
    surfaceState.attempted=true;
    try {
        api.registerParticipant({id:'mnemosyne-notes/bookmark',protocolVersion:1,didMount:({element})=>mount(element)});
    } catch(error) {
        console.warn('[Mnemosyne记事簿] 楼内按钮注册失败',error);
    }
}
let started=false;
export function activate() {
    if(started || document.getElementById('mnemosyne-notes') || !document.body || !context()) return;
    started=true;
    const root=node('div','mn-notebook');root.id='mnemosyne-notes';root.dataset.open='no';
    document.body.append(root);
    const prefs={showHead:true,theme:'light',side:'right',position:.54,toast:'edge',nav:'top',readingMode:'plain',readingFont:'wenkai',readingSize:14,zero:false,...bubbleDefaults};
    try{Object.assign(prefs,JSON.parse(localStorage.getItem('mnemosyne-notes:appearance')||'{}'));}catch{}
    const head=button('',null,'mn-head mn-glass');
    function apply(patch,persist=true) {
        Object.assign(prefs,patch);
        for(const key of ['theme','side','toast','nav'])if(!patch || key in patch)root.dataset[key]=prefs[key];
        if(!patch || 'position' in patch)root.style.setProperty('--mn-pos',(100*prefs.position)+'%');
        if(!patch || 'showHead' in patch)head.hidden=prefs.showHead===false;
        applyBubble(root,head,prefs,patch);
        if(patch && persist) localStorage.setItem('mnemosyne-notes:appearance',JSON.stringify(prefs));
    }
    apply();
    const version=new NotebookVersion();
    const view=new View(root,prefs,apply,bind,version);
    void version.check();
    let workbench=null,workbenchLoading=null,reminderTimer;
    const openWorkbench=view.guard(async()=>{
        view.close();
        workbenchLoading??=import('./lib/workbench/view.js').catch(error=>{workbenchLoading=null;throw error;});
        const module=await workbenchLoading;
        workbench??=module.createWorkbench(root,{notice:message=>view.toast(message,openWorkbench,true)});
        await workbench.open();
    });
    view.openWorkbench=openWorkbench;
    function remindArchive(){
        clearTimeout(reminderTimer);
        reminderTimer=setTimeout(view.guard(async()=>{
            const key=chatKey(),e=engine;if(!key||!e||e.key!==key)return;
            const {archiveReminder}=await import('./lib/workbench/reminders.js');
            const reminder=await archiveReminder(key,e.host.size()-1);
            if(reminder&&chatKey()===key)view.toast('已归档 '+reminder.archived+' / '+reminder.lastFloor+' 楼，点击打开工作台整理。',openWorkbench,true);
            if(workbench?.controller.scope?.chatKey===key){workbench.controller.lastFloor=e.host.size()-1;workbench.renderProgress();}
        }),250);
    }
    root.append(head);
    surfaceState.bookmark=view.guard(floor=>view.bookmark(floor));
    head.title='点按收藏 · 向内滑动打开记事簿 · 下滑打开工作台 · 长按拖动停靠';
    head.setAttribute('aria-label',head.title);
    const onBookmark=view.guard(()=>view.bookmark(centeredFloor()));
    let gesture=null,suppress=false;
    function end(ev,cancel=false) {
        if(!gesture || ev.pointerId!==gesture.id)return;
        const g=gesture;gesture=null;clearTimeout(g.hold);head.releasePointerCapture?.(ev.pointerId);
        root.classList.remove('mn-pulling','mn-dragging');head.style.transform='';
        view.panel.style.transform='';
        if(cancel){suppress=true;return;}
        if(g.drag){apply({side:ev.clientX<innerWidth/2?'left':'right',position:Math.max(.12,Math.min(.88,ev.clientY/innerHeight))});suppress=true;}
        else if(g.down){if(g.travel>=36)openWorkbench();suppress=true;}
        else if(g.pull){if(g.travel>=36)view.open();suppress=true;}
        else if(Math.hypot(ev.clientX-g.x,ev.clientY-g.y)>10)suppress=true;
    }
    head.onpointerdown=ev=>{
        if(!ev.isPrimary||ev.button!==0)return;
        suppress=false;
        const g={id:ev.pointerId,x:ev.clientX,y:ev.clientY,travel:0};gesture=g;
        g.hold=setTimeout(()=>{if(gesture===g&&!g.pull&&!g.down){g.drag=true;root.classList.add('mn-dragging');}},350);
        head.setPointerCapture(ev.pointerId);
    };
    head.onpointermove=ev=>{
        const g=gesture;if(!g||ev.pointerId!==g.id)return;
        const dx=ev.clientX-g.x,dy=ev.clientY-g.y,d=prefs.side==='left'?dx:-dx;
        if(g.drag){head.style.transform='translate('+dx+'px,calc(-50% + '+dy+'px))';return;}
        if(Math.abs(dx)+Math.abs(dy)>8)clearTimeout(g.hold);
        if(!g.pull&&!g.down&&dy>10&&dy>Math.abs(dx)*1.35)g.down=true;
        if(g.down){g.travel=Math.max(0,dy);head.style.transform='translateY(calc(-50% + '+Math.min(60,g.travel)*.45+'px))';return;}
        if(d>8 && Math.abs(dx)>Math.abs(dy) && !g.pull){
            g.pull=true;g.width=view.panel.getBoundingClientRect().width;root.classList.add('mn-pulling');
            // Mount the visible directory during the gesture. Full backfill begins on release.
            view.opened=true;view.render();
        }
        if(g.pull){g.travel=Math.max(0,d);const hidden=Math.max(0,g.width-g.travel);
            view.panel.style.transform='translateX('+(prefs.side==='left'?-hidden:hidden)+'px)';}
    };
    head.onpointerup=ev=>{const pull=gesture?.pull,dist=gesture?.travel;end(ev);
        if(pull&&dist<36)view.close();};
    head.onpointercancel=ev=>{const pull=gesture?.pull;end(ev,true);if(pull)view.close();};
    head.onclick=ev=>{if(suppress&&ev.detail){suppress=false;return;}onBookmark();};
    head.onkeydown=ev=>{if(ev.key==='ArrowDown'){ev.preventDefault();openWorkbench();}else if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){ev.preventDefault();view.open();}};
    document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&view.opened&&!view.modal)view.close();});

    const surface=globalThis.__TAURITAVERN__?.api?.chatSurface;
    let observed=null, observer=null;
    const managed=surface?.isManagedOwnershipRequired?.()===true;
    function attach() {
        if(managed)return;
        const chat=document.querySelector('#chat');if(!chat||chat===observed)return;
        observer?.disconnect();observed=chat;
        for(const el of chat.querySelectorAll(':scope > .mes'))mount(el);
        observer=new MutationObserver(entries=>{
            for(const rec of entries)for(const el of rec.addedNodes)if(el.nodeType===1&&el.matches('.mes'))mount(el);
        });observer.observe(chat,{childList:true});
    }

    let engine=null,binding=null;
    function menu() {
        const wrapper=document.querySelector('#extensions_settings2')||document.querySelector('#extensions_settings');
        if(wrapper&&!document.getElementById('mn-extension-settings'))wrapper.append(extensionSettings(prefs,apply,version));
    }
    async function bind() {
        attach();menu();
        const key=chatKey();
        if(engine && engine.key===key && !engine.disposed)return binding;
        engine?.dispose();engine=null;
        if(view.engine)view.setEngine(null);
        if(!key) {
            if(context()?.chat?.length && document.querySelector('#chat .mes[mesid]'))
                throw Error('已读取到正文，暂未取得聊天档名，请稍后再点一次');
            return;
        }
        const e=new Engine(new Host(key),{changed:k=>view.changed(k),zero:()=>prefs.zero,
            notice:(floor,scan)=>view.notice(floor,scan),error:err=>view.error(err)});
        engine=e;
        binding=e.init().then(()=>{
            if(engine!==e)return;
            if(!e.alive()){e.dispose();engine=null;return;}
            view.setEngine(e);if(view.opened)e.open();e.kick();remindArchive();return e;}).catch(err=>{
            if(engine===e){e.dispose();engine=null;throw err;}
        });
        return binding;
    }
    const ctx=context(), events=ctx.eventSource, types=ctx.eventTypes||ctx.event_types;
    const on=(key,fn)=>{if(types?.[key])events.on(types[key],(...args)=>{view.guard(fn)(...args);});};
    on('MORE_MESSAGES_LOADED',()=>{if(view.engine?.host.offset)view.floorSettings.schedule();});
    on('CHAT_CHANGED',()=>{workbench?.close();return bind();});on('APP_READY',bind);
    for(const type of ['MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','GENERATION_ENDED']){
        on(type,async id=>{
            const key=chatKey();await bind();const e=engine;if(!e||e.key!==key)return;
            if(type!=='GENERATION_ENDED')view.floorSettings.schedule();
            const floor=type==='GENERATION_ENDED' || !Number.isInteger(id) ? context().chat.length-1:id;
            if(floor>=0)e.dirty(e.host.offset+floor,true);
            if(['MESSAGE_EDITED','MESSAGE_SWIPED'].includes(type)&&workbench?.controller.scope?.chatKey===key)
                workbench.controller.invalidateSource(e.host.offset+floor,type);
            if(['MESSAGE_RECEIVED','MESSAGE_SENT','GENERATION_ENDED'].includes(type))remindArchive();
        });
    }
    on('MESSAGE_DELETED',async()=>{
        const key=chatKey();await bind();const e=engine;if(!e||e.key!==key)return;
        view.floorSettings.schedule();
        const prior=e.host.tail;
        const count=await e.host.sync();if(!e.alive())return;
        if(workbench?.controller.scope?.chatKey===key&&count<=workbench.controller.job?.lastFloor)workbench.controller.invalidateSource(0,'deleted');
        const last=context().chat.at(-1);
        const onlyTail=prior && count<prior.total && last && prior.messages.get(count-1)===last;
        await e.reset(onlyTail?count:0,true);
    });
    view.guard(bind)();
    registerChatSurface();
}
// Some older frontends load the module without manifest hooks.
async function legacyReady() {
    await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
    activate();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',legacyReady,{once:true});
else queueMicrotask(legacyReady);
