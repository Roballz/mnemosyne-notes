import { button, node } from './dom.js';
import { context } from './host.js';

export const VERSION='0.1.10';
// TT serves third-party modules under their actual installation folder.
const folder=decodeURIComponent(new URL(import.meta.url).pathname.match(/\/third-party\/([^/]+)\//)?.[1] || 'mnemosyne-notes');

async function request(operation, installation) {
    const headers=context()?.getRequestHeaders?.();
    if(!headers)throw Error('当前宿主未提供扩展管理接口');
    const response=await fetch('/api/extensions/'+operation,installation ?
        {method:'POST',headers,body:JSON.stringify(installation)} : {headers});
    if(!response.ok)throw Error((await response.text()).trim() || 'HTTP '+response.status);
    return response.json();
}

export class NotebookVersion {
    constructor() {
        this.rows=new Map();
        this.state='idle';this.nextCheck=0;
    }
    row(place) {
        if(!this.rows.has(place)){
            const row=node('span','mn-version');
            const label=node('span','','v'+VERSION);
            const update=button('',()=>this.install(),'mn-version-action');
            row.append(label,update);
            this.rows.set(place,{row,label,update});this.paint();
        }
        return this.rows.get(place).row;
    }
    paint() {
        for(const {label,update} of this.rows.values()){
            label.title=this.error || '当前版本 v'+VERSION;
            update.hidden=this.state==='idle';
            update.disabled=this.state==='installing';
            update.textContent=this.state==='installed'?'重载生效':this.state==='installing'?'更新中…':
                this.error?'重试更新':'发现新版 · 更新';
            update.title=this.error || update.textContent;
        }
    }
    async check() {
        if(this.pending || this.state==='installing' || this.state==='installed' || Date.now()<this.nextCheck)return this.pending;
        this.pending=(async()=>{
            try{
                if(!this.installation){
                    const list=await request('discover');
                    const entry=list.find(x=>x.name==='third-party/'+folder);
                    if(!entry || !['local','global'].includes(entry.type))throw Error('未找到记事簿安装信息');
                    this.installation={extensionName:folder,global:entry.type==='global'};
                }
                const data=await request('version',this.installation);
                if(typeof data.isUpToDate!=='boolean')throw Error('无法读取扩展更新状态');
                this.state=data.isUpToDate?'idle':'available';
                this.error='';this.nextCheck=Date.now()+30*60_000;
            }catch(error){
                this.error='检测更新失败：'+error.message;this.nextCheck=Date.now()+60_000;
            }finally{this.paint();}
        })();
        try{await this.pending;}finally{this.pending=null;}
    }
    async install() {
        if(this.state==='installed'){globalThis.location.reload();return;}
        if(this.state!=='available')return;
        if(this.pending){await this.pending;return this.install();}
        this.state='installing';this.error='';this.paint();
        try{
            const result=await request('update',this.installation);
            if(typeof result.isUpToDate!=='boolean')throw Error('宿主未返回更新结果');
            this.state='installed';
        }catch(error){
            this.state='available';this.error='更新失败：'+error.message;
            globalThis.toastr?.error?.(this.error);
        }finally{this.paint();}
    }
}

export function extensionSettings(prefs,savePrefs,version) {
    const section=node('div');section.id='mn-extension-settings';
    const drawer=node('div','inline-drawer');
    const header=node('div','inline-drawer-toggle inline-drawer-header');
    const arrow=node('div','inline-drawer-icon fa-solid fa-circle-chevron-down down');
    header.append(node('b','','Mnemosyne记事簿'),arrow);
    const content=node('div','inline-drawer-content');
    const body=node('div','mn-ext-body'),toggle=node('input');
    toggle.type='checkbox';toggle.checked=prefs.showHead!==false;
    toggle.onchange=()=>savePrefs({showHead:toggle.checked});
    const label=node('label','checkbox_label');label.append(toggle,node('span','','显示悬浮按钮'));
    const info=node('div','mn-ext-version');info.append(node('span','','当前版本'),version.row('extension'));
    body.append(label,info);content.append(body);drawer.append(header,content);section.append(drawer);
    // TT owns opening, closing, and the arrow. Before its delegated click
    // handler runs, a down arrow means this click is opening the drawer.
    header.addEventListener('click',()=>{if(arrow.classList.contains('down'))version.check();});
    return section;
}
