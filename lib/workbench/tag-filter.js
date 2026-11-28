// Parse literal tag selectors without DOM parsing or user-supplied regular expressions.
const nameStart = /[\p{L}_]/u, namePart = /[\p{L}\p{N}_.:-]/u;
const bareName = /^[\p{L}_][\p{L}\p{N}_.:-]*$/u, space = /\s/u;
const SLICE = 32768;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

// A checkpoint is yielded even inside a long quoted attribute. Malformed headers
// resume at the next unquoted '<', never restart a search from each opening tag.
function* tokens(text, budget = { work: 0 }) {
    let mode = 'text', tag, start = 0, key = '', quote = '';
    const attribute = value => {
        if (tag.attrs.has(key)) tag.duplicate = true;
        else tag.attrs.set(key, value);
    };
    for (let i = 0; i < text.length; i++) {
        if (++budget.work >= SLICE) { budget.work = 0; yield null; }
        const c = text[i];
        if (mode === 'text') {
            if (c !== '<') continue;
            const closing = text[i + 1] === '/', first = i + (closing ? 2 : 1);
            if (!nameStart.test(text[first] ?? '')) continue;
            tag = { start: i, closing, attrs: new Map(), selfClosing: false };
            start = first; i = first - 1; mode = 'name'; continue;
        }
        if (c === '<' && mode !== 'quoted') { mode = 'text'; i--; continue; }
        if (mode === 'name') {
            if (namePart.test(c)) continue;
            tag.name = text.slice(start, i).toLowerCase();
            mode = 'gap';
            if (!space.test(c) && c !== '/' && c !== '>') { mode = 'text'; continue; }
        }
        if (mode === 'attr') {
            if (namePart.test(c)) continue;
            key = text.slice(start, i).toLowerCase(); mode = 'afterName';
        }
        if (mode === 'afterName') {
            if (space.test(c)) continue;
            if (c === '=') { mode = 'value'; continue; }
            attribute(null); mode = 'gap';
        }
        if (mode === 'value') {
            if (space.test(c)) continue;
            if (c === '"' || c === "'") { quote = c; start = i + 1; mode = 'quoted'; continue; }
            if (c === '>' || c === '=' || (c === '/' && text[i + 1] === '>')) { mode = 'text'; continue; }
            start = i; mode = 'unquoted';
        }
        if (mode === 'quoted') {
            if (c === quote) { attribute(text.slice(start, i)); mode = 'afterValue'; }
            continue;
        }
        if (mode === 'unquoted') {
            if (c === '"' || c === "'" || c === '=') { mode = 'text'; continue; }
            if (!space.test(c) && c !== '>' && !(c === '/' && text[i + 1] === '>')) continue;
            attribute(text.slice(start, i)); mode = 'gap';
        }
        if (mode === 'afterValue') {
            if (!space.test(c) && c !== '/' && c !== '>') { mode = 'text'; continue; }
            mode = 'gap';
        }
        if (mode === 'slash') {
            if (space.test(c)) continue;
            if (c !== '>') { mode = 'text'; continue; }
        }
        if (mode === 'gap') {
            if (space.test(c)) continue;
            if (c === '/' && !tag.closing) { tag.selfClosing = true; mode = 'slash'; continue; }
            if (c !== '>') {
                if (!tag.closing && nameStart.test(c)) { start = i; mode = 'attr'; }
                else mode = 'text';
                continue;
            }
        }
        tag.end = i + 1; yield tag; mode = 'text';
    }
}

function readRules(value) {
    if (!Array.isArray(value)) throw Error('清洗标签须为标签列表。');
    const rules = new Map();
    for (const entry of value) {
        if (typeof entry !== 'string') throw Error('清洗标签须为文字。');
        let text = entry.trim();
        if (!text) continue;
        if (bareName.test(text)) text = `<${text}>`;
        let parsed;
        for (const token of tokens(text)) {
            if (!token) continue;
            if (parsed) { parsed = null; break; }
            parsed = token;
        }
        if (!parsed || parsed.start !== 0 || parsed.end !== text.length || parsed.closing || parsed.selfClosing || parsed.duplicate)
            throw Error('清洗标签格式无效：请填写单个起始标签，如 <sxrp> 或 <archive type="关系">。');
        const attrs = [...parsed.attrs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const label = `<${parsed.name}${attrs.map(([key, val]) => {
            if (val === null) return ` ${key}`;
            const q = val.includes('"') ? "'" : '"';
            return ` ${key}=${q}${val}${q}`;
        }).join('')}>`;
        rules.set(label, { name: parsed.name, attrs });
    }
    return rules;
}

export function normalizeCleanTags(value = []) {
    return [...readRules(value).keys()];
}

function* filterText(text, rules, budget) {
    const parts = [];
    let keptFrom = 0, hidden = null;
    for (const token of tokens(text, budget)) {
        if (!token) { yield; continue; }
        if (hidden) {
            if (token.name !== hidden.name) continue;
            if (token.closing) {
                if (--hidden.depth === 0) { keptFrom = token.end; hidden = null; }
            } else if (!token.selfClosing) hidden.depth++;
            continue;
        }
        if (token.closing) continue;
        const choices = rules.get(token.name);
        if (!choices?.some(attrs => attrs.every(([key, val]) => token.attrs.has(key) && (val === null || token.attrs.get(key) === val)))) continue;
        parts.push(text.slice(keptFrom, token.start));
        if (token.selfClosing) keptFrom = token.end;
        else hidden = { name: token.name, depth: 1 };
    }
    // A selected opening tag without its closer hides the rest of this message.
    if (!parts.length) return text;
    if (!hidden) parts.push(text.slice(keptFrom));
    return parts.join('');
}

export async function filterChatMessages(messages, cleanTags = []) {
    const rules = new Map();
    for (const { name, attrs } of readRules(cleanTags).values()) {
        if (!rules.has(name)) rules.set(name, []);
        rules.get(name).push(attrs);
    }
    if (!rules.size) return messages;
    const result = [], budget = { work: 0 };
    for (const message of messages) {
        const scan = filterText(message.content, rules, budget);
        let step = scan.next();
        while (!step.done) { await pause(); step = scan.next(); }
        result.push(step.value === message.content ? message : { ...message, content: step.value });
        // Also bound the work for a large collection of tiny/empty messages.
        budget.work += 64;
        if (budget.work >= SLICE) { budget.work = 0; await pause(); }
    }
    return result;
}
