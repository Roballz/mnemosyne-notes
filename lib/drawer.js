// Touch Events keep ownership across WebView pointercancel and implicit capture
// transfers. Mouse and pen use Pointer Events. Each contact has only one owner.
export function enableSwipeToClose(view) {
    const panel=view.panel;
    let drag, suppressClick=false;
    function begin(id,x,y,target,source) {
        suppressClick=false;
        if(!view.opened || view.modal || target.closest('input,textarea,select,summary,[contenteditable=true]'))return;
        drag={id,x,y,source,sign:view.prefs.side==='left'?-1:1,claimed:false,distance:0};
    }
    function finish(close=false) {
        if(!drag)return;
        suppressClick=drag.claimed;
        drag=null;panel.classList.remove('mn-retracting');panel.style.removeProperty('transform');
        if(close)view.close();
    }
    function move(x,y) {
        if(!drag)return;
        if(!view.opened || view.modal){finish();return;}
        const d=(x-drag.x)*drag.sign,dy=Math.abs(y-drag.y);
        if(!drag.claimed) {
            if(dy>=9 && dy>=Math.abs(d) || d < -9){finish();return;}
            if(d<10 || d<1.35*dy)return;
            drag.claimed=true;panel.classList.add('mn-retracting');
        }
        drag.distance=Math.max(0,d);
        panel.style.transform='translateX('+drag.sign*drag.distance+'px)';
    }
    panel.addEventListener('touchstart',ev=>{
        if(ev.touches.length!==1){finish();return;}
        const t=ev.touches[0];begin(t.identifier,t.clientX,t.clientY,ev.target,'touch');
    },{passive:true});
    panel.addEventListener('touchmove',ev=>{
        if(drag?.source!=='touch')return;
        const t=ev.touches[0];
        if(ev.touches.length!==1 || t.identifier!==drag.id){finish();return;}
        move(t.clientX,t.clientY);
        if(drag?.distance>=44)finish(true);
    },{passive:true});
    panel.addEventListener('touchend',ev=>{
        const t=ev.changedTouches[0];
        if(drag?.source==='touch' && t?.identifier===drag.id){move(t.clientX,t.clientY);finish(drag?.distance>=44);}
    },{passive:true});
    panel.addEventListener('touchcancel',()=>finish(),{passive:true});
    panel.addEventListener('pointerdown',ev=>{
        if(drag?.source==='touch' || !ev.isPrimary || ev.button!==0)return;
        begin(ev.pointerId,ev.clientX,ev.clientY,ev.target,'pointer');
    });
    panel.addEventListener('pointermove',ev=>{
        if(drag?.source!=='pointer' || drag.id!==ev.pointerId)return;
        move(ev.clientX,ev.clientY);
        if(ev.pointerType==='touch' && drag?.distance>=44)finish(true);
        else if(drag?.claimed && !panel.hasPointerCapture?.(ev.pointerId))panel.setPointerCapture?.(ev.pointerId);
    });
    panel.addEventListener('pointerup',ev=>{
        if(drag?.source!=='pointer' || drag.id!==ev.pointerId)return;
        move(ev.clientX,ev.clientY);finish(drag?.distance>=44);
    });
    panel.addEventListener('pointercancel',ev=>{if(drag?.source==='pointer' && drag.id===ev.pointerId)finish();});
    panel.addEventListener('click',ev=>{
        if(suppressClick && ev.detail){suppressClick=false;ev.preventDefault();ev.stopImmediatePropagation();}
    },true);
}
