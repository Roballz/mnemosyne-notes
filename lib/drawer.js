// Leave touches native until horizontal movement toward the dock clearly wins.
export function enableSwipeToClose(view) {
    const panel=view.panel;
    let drag=null, suppressClick=false;
    function release(close) {
        const prev=drag;
        if(!prev)return;
        drag=null;
        panel.classList.remove('mn-retracting');
        panel.style.removeProperty('transform');
        if(prev.claimed && panel.hasPointerCapture?.(prev.id))panel.releasePointerCapture(prev.id);
        if(close)view.close();
    }
    panel.addEventListener('pointerdown',ev=>{
        suppressClick=false;
        if(!view.opened || view.modal || !ev.isPrimary || ev.button!==0 ||
            ev.target.closest('input,textarea,select,label,summary,[contenteditable=true]'))return;
        drag={id:ev.pointerId,x:ev.clientX,y:ev.clientY,sign:view.prefs.side==='left'?-1:1,claimed:false};
    });
    function movement(ev) {
        if(!drag || drag.id!==ev.pointerId)return;
        if(!view.opened || view.modal){release(false);return;}
        const distance=(ev.clientX-drag.x)*drag.sign, vertical=Math.abs(ev.clientY-drag.y);
        if(!drag.claimed){
            if(vertical>=9 && vertical>=Math.abs(distance) || distance < -9){release(false);return;}
            if(distance<12 || distance<vertical*1.35)return;
            drag.claimed=true;
            panel.setPointerCapture(ev.pointerId);
            panel.classList.add('mn-retracting');
        }
        drag.distance=Math.max(0,distance);
        panel.style.transform='translateX('+drag.sign*drag.distance+'px)';
    }
    panel.addEventListener('pointermove',movement);
    panel.addEventListener('pointerup',ev=>{
        if(drag?.id!==ev.pointerId)return;
        if(drag.claimed)movement(ev);
        suppressClick=!!drag?.claimed;
        release(suppressClick && drag.distance>=48);
    });
    for(const name of ['pointercancel','lostpointercapture'])panel.addEventListener(name,ev=>{
        if(drag?.id===ev.pointerId && (name!=='lostpointercapture' || ev.target===panel))release(false);
    });
    panel.addEventListener('click',ev=>{
        if(suppressClick && ev.detail){suppressClick=false;ev.preventDefault();ev.stopImmediatePropagation();}
    },true);
}
