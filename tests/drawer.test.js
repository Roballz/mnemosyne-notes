import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { enableSwipeToClose } from '../lib/drawer.js';

function gesture(side,points,target='p',cancel=false) {
    const {document,Event}=parseHTML('<html><body><section><p>正文</p><label><input></label></section></body></html>');
    const panel=document.querySelector('section');
    const view={panel,prefs:{side},opened:true,close(){this.opened=false;}};
    panel.setPointerCapture=()=>{};
    enableSwipeToClose(view);
    function emit(type,point) {
        const ev=Object.assign(new Event(type,{bubbles:true}),{pointerId:4,isPrimary:true,button:0,clientX:point[0],clientY:point[1]});
        panel.querySelector(target).dispatchEvent(ev);
    }
    emit('pointerdown',points[0]);
    for(const p of points.slice(1))emit('pointermove',p);
    emit(cancel?'pointercancel':'pointerup',points.at(-1));
    assert.ok(!panel.classList.contains('mn-retracting'));
    return view.opened;
}
test('主界面向左右停靠边滑动均可收回',()=>{
    assert.equal(gesture('left',[[80,100],[20,103]]),false);
    assert.equal(gesture('right',[[120,100],[188,97]]),false);
});
test('垂直、反向、短滑、取消和编辑输入均保留面板',()=>{
    for(const [points,target,cancel] of [
        [[[100,100],[118,155],[170,170]]],[[[100,100],[30,102]]],
        [[[100,100],[135,104]]],[[[100,100],[170,102],[112,102]]],
        [[[100,100],[175,103]],'input'],[[[100,100],[175,103]],'p',true],
    ])assert.equal(gesture('right',points,target,cancel),true);
});

test('WebView 滚动区内向外触滑，触点未抬起即收回；纵向滚动仍由宿主处理',()=>{
    for(const [side,dx,dy,open] of [['right',48,6,false],['left',-48,6,false],['right',13,62,true]]){
        const {document,Event}=parseHTML('<body><section><div class="mn-content"><button>选择</button></div></section></body>');
        const panel=document.querySelector('section'),item=panel.querySelector('button');
        const view={panel,prefs:{side},opened:true,close(){this.opened=false;}};
        enableSwipeToClose(view);
        function touch(type,x,y){
            const t={identifier:21,clientX:x,clientY:y};
            item.dispatchEvent(Object.assign(new Event(type,{bubbles:true,cancelable:true}),{touches:[t],changedTouches:[t]}));
        }
        touch('touchstart',100,100);touch('touchmove',100+dx,100+dy);
        assert.equal(view.opened,open);
    }
});
