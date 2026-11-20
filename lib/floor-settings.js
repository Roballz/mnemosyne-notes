import { button, field, input, node } from './dom.js';
import { changeVisibility, visibilityCount } from './visibility.js';

function numeric(value) {
    const el=input(String(value));
    el.type='number';el.min='0';el.step='1';el.inputMode='numeric';
    return el;
}

export class FloorSettings {
    constructor(view) {
        this.view=view;
        this.count=node('span','','当前已隐藏 … 楼');
        this.link=button('设置',()=>this.open(),'mn-link');
        this.link.setAttribute('aria-label','隐藏楼层设置');
        this.group=node('span','mn-hidden-status');
        const dot=node('span','','·');dot.setAttribute('aria-hidden','true');
        this.group.append(dot,this.count,this.link);
        this.group.hidden=true;
    }
    clear() {
        clearTimeout(this.timer);
        this.pending=null;this.group.hidden=true;this.form=null;
        this.count.textContent='当前已隐藏 … 楼';
    }
    schedule() {
        if(!this.view.opened || this.view.engine?.host.visibilityWriting)return;
        clearTimeout(this.timer);
        this.timer=setTimeout(()=>this.refresh(),80);
    }
    async refresh() {
        const e=this.view.engine;
        if(!this.view.opened || !e?.book || !e.alive() || e.host.visibilityWriting)return;
        this.group.hidden=false;
        if(this.pending?.engine===e){this.pending.again=true;return;}
        const task={engine:e};
        const live=()=>this.pending===task && this.view.opened && this.view.engine===e && e.alive();
        this.pending=task;
        try{
            const result=await visibilityCount(e.host,live);
            if(!live() || !result)return;
            this.count.textContent='当前已隐藏 '+result.hidden+' 楼';
            const f=this.form;
            if(f?.el.open){
                f.count.textContent=this.count.textContent;
                const max=String(Math.max(0,result.total-1));
                if(!f.endEdited)f.end.value=max;
                f.start.max=f.end.max=max;
            }
        }catch(error){
            if(live()){
                this.count.textContent='隐藏数暂不可用';
                if(this.form?.el.open)this.form.count.textContent=error.message;
            }
        }finally{
            if(this.pending===task){
                this.pending=null;
                if(task.again)this.schedule();
            }
        }
    }
    open() {
        const view=this.view,e=view.engine;
        if(!e?.alive())return;
        const {el,body}=view.dialog('隐藏楼层设置');
        el.classList.add('mn-floor-dialog');
        const count=node('small','mn-hidden-total',this.count.textContent);
        count.setAttribute('role','status');
        const start=numeric(0),end=numeric(Math.max(0,e.host.size()-1));
        start.max=end.max=end.value;
        const number=Number(view.prefs.recentFloors ?? 20);
        const keep=numeric(Number.isSafeInteger(number) && number>=0 ? number : 20);
        const opening=node('input');opening.type='checkbox';opening.checked=Boolean(view.prefs.keepOpening);
        opening.onchange=()=>view.savePrefs({keepOpening:opening.checked});
        const f=this.form={el,count,start,end,endEdited:false};
        end.oninput=()=>{f.endEdited=true;};
        const range=node('div','mn-floor-fields'),actions=node('div','mn-floor-fields');
        range.append(field('起始楼',start),field('终止楼',end));
        const result=node('p','mn-hint');result.setAttribute('role','status');
        const live=()=>el.open && el.isConnected && view.engine===e && e.alive();
        const read=control=>control.value.trim()==='' ? NaN : Number(control.value);
        const controls=[start,end,keep,opening];
        const action=(label,id,cls)=>{
            const b=button(label,view.guard(async()=>{
                if(!live() || b.disabled)return;
                for(const c of controls)c.disabled=true;
                clearTimeout(this.timer);this.pending=null;
                result.textContent='正在应用…';
                try{
                    const amount=read(keep);
                    const changes=await changeVisibility(e.host,{
                        action:id,start:read(start),end:read(end),keep:amount,opening:opening.checked
                    },live);
                    if(id==='recent' && amount!==view.prefs.recentFloors)view.savePrefs({recentFloors:amount});
                    if(live())result.textContent=changes?'已更新 '+changes+' 楼':'所选楼层已是目标状态';
                }catch(error){
                    if(live())result.textContent=error.message || '保存失败，请重试';
                }finally{
                    for(const c of controls)c.disabled=false;
                    if(view.engine===e)this.refresh();
                }
            }),cls);
            controls.push(b);
            return b;
        };
        actions.append(action('隐藏楼层','hide','mn-primary'),action('取消隐藏','show'));
        const policy=node('label','mn-floor-switch');
        policy.append(opening,node('span','','保留第 0 楼（开场白）'));
        body.append(policy,range,actions,field('只保留最近楼层数',keep),action('隐藏更早楼层','recent'),result,count);
        this.refresh();
    }
}
