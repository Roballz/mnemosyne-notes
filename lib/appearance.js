import { button, field, icon, input, node, select } from './dom.js';

export const bubbleDefaults = { headSize:22, noticeSize:34, transparency:0, glass:'liquid', bubbleColor:'', bubbleIcon:'book', glyph:'✦', iconImage:'' };
const palette = [['主题',''],['松绿','#247959'],['雾蓝','#476da5'],['紫藤','#8763a2'],['琥珀','#ad692d'],['海盐','#8ac8bc']];
const themeColors = {light:'#285f50', dark:'#426690', neon:'#256852'};
const icons = {book:'书本',mark:'书签',inbox:'消息',folder:'文件夹',glyph:'自定义文字或表情',image:'本地图片'};

function normalColor(value) {
    return /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : '';
}
function iconContent(prefs) {
    if (prefs.bubbleIcon==='glyph') return node('span','mn-glyph',prefs.glyph || '✦');
    if (prefs.bubbleIcon==='image' && /^data:image\/png;base64,/.test(prefs.iconImage)) {
        const img=node('img','mn-custom-image');img.alt='';img.src=prefs.iconImage;return img;
    }
    return icon(['book','mark','inbox','folder'].includes(prefs.bubbleIcon) ? prefs.bubbleIcon : 'book');
}
export function applyBubble(root,head,prefs,patch) {
    for(const [key,min,max,variable] of [['headSize',18,48,'--mn-head-size'],['noticeSize',24,60,'--mn-notice-size']]){
        if(patch && !(key in patch))continue;
        const n=Number(prefs[key]);
        prefs[key]=Number.isFinite(n) ? Math.max(min,Math.min(max,Math.round(n))) : bubbleDefaults[key];
        root.style.setProperty(variable,prefs[key]+'px');
    }
    if(!patch || 'transparency' in patch){
        const value=Number(prefs.transparency);
        prefs.transparency=Number.isFinite(value)?Math.max(0,Math.min(90,Math.round(value))):bubbleDefaults.transparency;
        root.style.setProperty('--mn-bubble-opacity',String((100-prefs.transparency)/100));
    }
    if(patch && !['theme','glass','bubbleColor','bubbleIcon','glyph','iconImage'].some(key=>key in patch))return;
    const color=normalColor(prefs.bubbleColor) || themeColors[prefs.theme] || themeColors.light;
    const channels=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
    const linear=channels.map(n=>n<=.04045 ? n/12.92 : ((n+.055)/1.055)**2.4);
    const lum=.2126*linear[0]+.7152*linear[1]+.0722*linear[2];
    root.style.setProperty('--mn-rgb',channels.map(n=>Math.round(n*255)).join(','));
    root.style.setProperty('--mn-glass-ink',lum>.23 ? '#112424' : '#ffffff');
    root.dataset.glass=prefs.glass==='frost'?'frost':'liquid';
    if (!patch || ['bubbleIcon','glyph','iconImage'].some(key=>key in patch)) head.replaceChildren(iconContent(prefs));
}

async function readIcon(file) {
    if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>4*1024*1024)
        throw Error('请选择 4 MB 以内的 PNG、JPG 或 WebP 图片');
    const url=URL.createObjectURL(file);
    try {
        const img=new Image();img.src=url;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const size=64/Math.max(img.naturalWidth,img.naturalHeight);
        const w=img.naturalWidth*size,h=img.naturalHeight*size;
        canvas.getContext('2d').drawImage(img,(64-w)/2,(64-h)/2,w,h);
        return canvas.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
}

export function bubbleSettings(view) {
    const prefs=view.prefs, wrap=node('div','mn-bubble-settings');
    const preview=node('div','mn-bubble-preview');
    const example=node('span','mn-sample-toast mn-glass','已收藏楼层');
    const badge=node('span','mn-sample-head mn-glass');
    preview.setAttribute('aria-label','外观预览');preview.append(example,badge);
    const presets=node('div','mn-swatches');
    const color=input();color.type='color';color.setAttribute('aria-label','选择自定义颜色');
    const hex=input('','#RRGGBB');hex.maxLength=7;hex.setAttribute('aria-label','自定义色值');
    const glyph=input(prefs.glyph,'如 ✦ 或 📔');glyph.maxLength=24;
    const file=node('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;
    const pick=button('选择本地图片',()=>file.click(),'mn-setting');
    function draw() {
        const active=normalColor(prefs.bubbleColor);
        color.value=active || themeColors[prefs.theme] || themeColors.light;hex.value=active;
        for(const b of presets.children)b.setAttribute('aria-pressed',String(b.dataset.color===active));
        badge.replaceChildren(iconContent(prefs));
        glyph.hidden=prefs.bubbleIcon!=='glyph';pick.hidden=prefs.bubbleIcon!=='image';
    }
    function slider(label,key,min,max,unit=' px') {
        const control=input();control.type='range';control.min=String(min);control.max=String(max);
        control.step='1';control.value=String(prefs[key]);control.setAttribute('aria-label',label);
        const value=node('output','mn-size-value',prefs[key]+unit);
        control.setAttribute('aria-valuetext',prefs[key]+(unit==='%'?'%':' 像素'));
        function change(persist) {
            const n=Number(control.value);
            view.savePrefs({[key]:n},persist);value.textContent=n+unit;
            control.setAttribute('aria-valuetext',n+(unit==='%'?'%':' 像素'));
        }
        control.oninput=()=>change(false);control.onchange=()=>change(true);
        const line=node('div','mn-size-line');line.append(control,value);
        return field(label,line);
    }
    function save(patch) {view.savePrefs(patch);draw();}
    for(const [name,tint] of palette) {
        const b=button(name,()=>save({bubbleColor:tint}),'mn-swatch');
        b.dataset.color=tint;b.style.setProperty('--swatch',tint||'var(--accent)');presets.append(b);
    }
    color.onchange=()=>save({bubbleColor:color.value});
    hex.onchange=()=>{
        const value=hex.value.trim();
        if(value && !normalColor(value)){view.error(Error('色值格式为 #RRGGBB'));draw();return;}
        save({bubbleColor:normalColor(value)});
    };
    glyph.setAttribute('aria-label','自定义图标文字');
    glyph.onchange=()=>save({glyph:glyph.value.trim().slice(0,24)||'✦'});
    file.onchange=view.guard(async()=>{
        if(!file.files?.[0])return;
        const iconImage=await readIcon(file.files[0]);file.value='';save({iconImage});
    });
    const colors=node('div','mn-color-fields');colors.append(color,hex);
    wrap.append(preview,
        field('外部气泡样式',select([['liquid','液态玻璃'],['frost','磨砂光感玻璃']],prefs.glass,v=>save({glass:v}))),
        slider('气泡透明度','transparency',0,90,'%'),
        slider('悬浮头高度','headSize',18,48),slider('通知单行高度','noticeSize',24,60),
        node('span','mn-caption','气泡颜色'),presets,colors,
        field('悬浮图标',select(Object.entries(icons),prefs.bubbleIcon,v=>save({bubbleIcon:v}))),glyph,pick,file);
    draw();return wrap;
}
