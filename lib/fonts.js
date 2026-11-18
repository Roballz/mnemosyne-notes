import { meta } from './db.js';

const files = {
    wenkai: 'LXGWWenKai-Regular',
    serif: 'SourceHanSerifCN-Regular',
    sans: 'SourceHanSansCN-Regular',
    zhuque: 'ZhuqueFangsong-Regular',
};
export const fontChoices = [
    ['wenkai', '霞鹜文楷'], ['theme', '跟随酒馆主题'], ['pingfang', '苹方（本机）'],
    ['serif', '思源宋体'], ['sans', '思源黑体'], ['zhuque', '朱雀仿宋'],
];
export const readingSize = value => Math.min(28, Math.max(10, Math.round(Number(value) || 14)));

let active;
export function useImportedFace(id, face) {
    if (active?.face) document.fonts?.delete(active.face);
    active = {id, face, promise:Promise.resolve(face)};
}

function loadFace(id) {
    if (active?.id === id) return active.promise;
    if (active?.face) document.fonts?.delete(active.face);
    const slot = {id};
    active = slot;
    slot.promise = (async () => {
        let source;
        if (id === 'pingfang') source = 'local("PingFangSC-Regular"),local("PingFang SC")';
        else if (Object.hasOwn(files, id)) {
            const url = new URL('../fonts/' + files[id] + '.woff2', import.meta.url);
            source = 'url("' + url.href + '") format("woff2")';
        } else {
            source = await meta(['fontFile', id]);
            if (!source) throw Error('找不到已导入的字体');
        }
        const face = await new FontFace('MnReader-' + id, source).load();
        slot.face = face;
        return face;
    })();
    return slot.promise;
}

// Read a rendered floor where available. Older virtualized floors use the
// current chat's visible typography. Walk only its short ancestor chain.
export function chatTypography(floor) {
    if (typeof getComputedStyle !== 'function') return {};
    const text = (Number.isInteger(floor) && floor >= 0 &&
        document.querySelector('#chat .mes[mesid="' + floor + '"] .mes_text')) ||
        document.querySelector('#chat .mes_text') || document.body;
    const style = getComputedStyle(text);
    let surface;
    for (let el = text; el; el = el.parentElement) {
        const bg = (el === text ? style : getComputedStyle(el)).backgroundColor;
        if (bg && bg !== 'transparent' && !/^rgba\(.+,\s*0(?:\.0+)?\)$/.test(bg)) { surface = bg; break; }
    }
    return {style, surface};
}

const unquote = str => str.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
const sheetCache = new WeakMap();
function facesFrom(sheet, families, seen) {
    if (!sheet || seen.has(sheet) || sheet.disabled) return [];
    seen.add(sheet);
    const key = families.join(',');
    let rules;
    try { rules = sheet.cssRules; } catch { return []; }
    if (!rules) return [];
    const cached = sheetCache.get(sheet);
    if (cached?.key === key && cached.count === rules.length) return cached.faces;
    const faces = [];
    function visit(list) {
        for (const rule of list) {
            if (rule.type === 3) { faces.push(...facesFrom(rule.styleSheet, families, seen)); continue; }
            if (rule.type !== 5) {
                if (rule.type === 4 && !matchMedia(rule.conditionText).matches) continue;
                if (rule.type !== 1 && rule.cssRules) visit(rule.cssRules);
                continue;
            }
            const style = rule.style, name = style.getPropertyValue('font-family').trim();
            if (!families.includes(unquote(name))) continue;
            const src = style.getPropertyValue('src').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
                (original, quote, value) => {
                    try { return 'url(' + JSON.stringify(new URL(value, sheet.href || document.baseURI).href) + ')'; }
                    catch { return original; }
                });
            const desc = {};
            for (const [css, prop] of [['font-weight','weight'],['font-style','style'],['font-stretch','stretch'],
                ['unicode-range','unicodeRange'],['font-display','display']]) {
                const value = style.getPropertyValue(css);
                if (value) desc[prop] = value;
            }
            try { faces.push(new FontFace(name, src, desc)); } catch { /* System fallback remains available. */ }
        }
    }
    visit(rules);
    sheetCache.set(sheet, {key, count:rules.length, faces});
    return faces;
}

const fontRuns = new WeakMap();
export async function applyReadingFont(el, prefs, typography = {}, rich = false) {
    const id = prefs.readingFont || 'wenkai', size = readingSize(prefs.readingSize);
    const doc = el.ownerDocument;
    const run = {};
    fontRuns.set(el, run);
    if (rich) el.style.zoom = String(size / 14);
    else el.style.fontSize = size + 'px';
    if (id === 'theme') {
        if (active?.face) document.fonts?.delete(active.face);
        active = undefined;
        const style = typography.style;
        if (!style) return '';
        el.style.fontFamily = style.fontFamily;
        el.style.fontStyle = style.fontStyle;
        el.style.fontWeight = style.fontWeight;
        el.style.color = style.color;
        const rgb = style.color?.match(/[\d.]+/g);
        const lightInk = rgb && .2126*rgb[0] + .7152*rgb[1] + .0722*rgb[2] > 150;
        el.style.backgroundColor = typography.surface || (lightInk ? '#191b20' : '#faf9f6');
        if (rich && doc.fonts && typeof FontFace === 'function') {
            const families = style.fontFamily.split(',').map(unquote);
            // Some hosts install a programmatic FontFace rather than a CSS rule.
            for (const face of document.fonts) {
                if (families.includes(unquote(face.family))) {
                    try { doc.fonts.add(face); } catch { /* CSS-connected faces are recreated below. */ }
                }
            }
            const seen = new Set();
            for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])])
                for (const face of facesFrom(sheet, families, seen)) doc.fonts.add(face);
            // The browser selects only the weights and unicode ranges in use.
            el.getBoundingClientRect();
            await doc.fonts.ready;
        }
        return '';
    }
    if (typeof FontFace !== 'function' || !doc.fonts) return '此阅读环境不支持加载字体';
    let face, hint = '';
    try {
        face = await loadFace(id);
    } catch {
        if (id === 'wenkai') return '霞鹜文楷加载失败，已使用系统字体';
        hint = id === 'pingfang' ? '本机未提供苹方，已使用霞鹜文楷' : '所选字体加载失败，已使用霞鹜文楷';
        if (fontRuns.get(el) !== run) return '';
        // Keep a failed selection cached so reopening the reader does not retry
        // the missing local face and reload the fallback on every floor.
        const slot = active;
        if (slot?.id !== id) return '';
        slot.fallback ??= new FontFace('MnReader-wenkai',
            'url("' + new URL('../fonts/' + files.wenkai + '.woff2', import.meta.url).href + '")').load();
        try { face = await slot.fallback; slot.face = face; }
        catch { return '字体加载失败，已使用系统字体'; }
    }
    if (fontRuns.get(el) !== run || active?.id !== id) return '';
    doc.fonts.add(face);
    el.style.fontFamily = '"' + face.family + '", serif';
    return hint;
}
