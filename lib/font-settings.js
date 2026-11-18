import { meta, storeFont } from './db.js';
import { button, field, input, node, select } from './dom.js';
import { applyReadingFont, chatTypography, fontChoices, readingSize, useImportedFace } from './fonts.js';

export async function fontBytes(file, address, signal) {
    if (file && address) throw Error('请选择一份本地文件，或单独填写网络地址');
    if (file) return file.arrayBuffer();
    let url;
    try { url = new URL(address); } catch { throw Error('请选择字体文件，或填写完整的网络字体直链'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('字体地址需使用 HTTP 或 HTTPS');
    let response;
    try { response = await fetch(url, {signal, credentials:'omit', referrerPolicy:'no-referrer'}); }
    catch (error) {
        if (signal.aborted) throw error;
        throw Error('下载失败，请检查网络和跨域权限，也可选择本地字体文件');
    }
    if (!response.ok) throw Error('字体下载失败（HTTP ' + response.status + '）');
    return response.arrayBuffer();
}

function importFont(view, saved) {
    const {el, body} = view.dialog('添加自定义字体');
    const name = input('', '例如 我的正文字体'), url = input('', 'https://…'), file = input();
    url.type = 'url'; file.type = 'file'; file.accept = '.ttf,.otf,.woff,.woff2';
    const status = node('p', 'mn-hint');
    status.setAttribute('role', 'status');
    const controller = new AbortController();
    el.addEventListener('close', () => controller.abort(), {once:true});
    const submit = button('导入并使用', view.guard(async () => {
        if (submit.disabled) return;
        submit.disabled = true;
        try {
            const selected = file.files?.[0], address = url.value.trim();
            status.textContent = '正在读取字体…';
            const bytes = await fontBytes(selected, address, controller.signal);
            if (!el.isConnected || !el.open) return;
            const id = 'custom-' + crypto.randomUUID();
            let face;
            try { face = await new FontFace('MnReader-' + id, bytes).load(); }
            catch { throw Error('无法识别该字体，请选择有效的字体文件。网络地址须直接指向字体文件。'); }
            if (!el.isConnected || !el.open) return;
            const label = name.value.trim() || selected?.name?.replace(/\.[^.]+$/, '') || '自定义字体';
            await storeFont(id, label, bytes);
            if (!el.isConnected || !el.open) return;
            useImportedFace(id, face);
            saved({id, label});
            el.close();
        } finally { submit.disabled = false; status.textContent = ''; }
    }), 'mn-primary');
    body.append(field('显示名称（选填）', name), field('本地字体', file), field('或输入网络字体直链', url),
        node('p', 'mn-hint', '支持 TTF、OTF、WOFF 和 WOFF2。导入后可离线阅读。'), status, submit);
}

export function fontSettings(view) {
    const wrap = node('div', 'mn-bubble-settings'), picker = node('div');
    const sample = node('div', 'mn-font-sample', '灯下翻书，见字如面。 21:43');
    const hint = node('div', 'mn-hint');
    hint.setAttribute('role', 'status');
    const slider = input(), value = node('output','mn-size-value');
    slider.type = 'range'; slider.min = '10'; slider.max = '28'; slider.step = '1';
    slider.setAttribute('aria-label', '阅读字号');
    slider.value = String(readingSize(view.prefs.readingSize));
    const line = node('div', 'mn-size-line');
    line.append(slider, value);
    let entries = [], revision = 0;
    function preview() {
        const current = ++revision;
        // Clear theme-specific colors and weights when leaving host typography.
        sample.removeAttribute('style');
        const theme = view.prefs.readingFont === 'theme' ? chatTypography() : {};
        hint.textContent = '';
        applyReadingFont(sample, view.prefs, theme).then(message => {
            if (revision === current) hint.textContent = message;
        }).catch(() => { if (revision === current) hint.textContent = '字体预览暂时不可用'; });
    }
    function resize(save) {
        const size = readingSize(slider.value);
        value.textContent = size + ' px';
        slider.setAttribute('aria-valuetext', size + ' 像素');
        sample.style.fontSize = size + 'px';
        if (save) view.savePrefs({readingSize:size});
    }
    slider.oninput = () => resize(false);
    slider.onchange = () => resize(true);
    function drawPicker() {
        const options = [...fontChoices, ...entries.map(({id,label}) => [id,label]), ['add','＋ 添加自定义字体…']];
        const id = view.prefs.readingFont || 'wenkai';
        const control = select(options, id, selected => {
            if (selected === 'add') {
                drawPicker();
                importFont(view, entry => {
                    entries.push(entry);
                    view.savePrefs({readingFont:entry.id});
                    drawPicker(); preview();
                });
            } else {
                view.savePrefs({readingFont:selected});
                drawPicker(); preview();
            }
        });
        picker.replaceChildren(field('阅读字体', control));
        if (entries.some(entry => entry.id === id)) {
            picker.append(button('移除此字体', () => view.confirmAction('移除自定义字体',
                '移除后将使用霞鹜文楷。', '移除', async () => {
                    await storeFont(id);
                    entries = entries.filter(entry => entry.id !== id);
                    view.savePrefs({readingFont:'wenkai'}); drawPicker(); preview();
                }), 'mn-link'));
        }
    }
    drawPicker(); resize(false); preview();
    meta('fontCatalog', []).then(list => {
        if (wrap.isConnected && list.length) { entries = list; drawPicker(); }
    }).catch(() => { hint.textContent = '无法读取自定义字体目录'; });
    wrap.append(picker, field('阅读字号', line), sample, hint);
    return wrap;
}
