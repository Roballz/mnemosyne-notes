import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { captureHistory, getDefaultPreset, MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from '../lib/workbench/memory.js';
import { chatKey } from '../lib/host.js';

const previous = { SillyTavern: globalThis.SillyTavern, __TAURITAVERN__: globalThis.__TAURITAVERN__, STMnemosyne: globalThis.STMnemosyne };
afterEach(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; } });
const ai = (mes = '合成正文', extra = {}) => ({ mes, is_user: false, is_system: false, extra });
const user = () => ({ mes: '合成用户发言', is_user: true, is_system: false });
const node = (start, end = start, id = `node-${start}`) => ({ id, kind: 'comp', level: 1, text: '2085/05/16，合成事件。', floorStart: start, floorEnd: end });
function setup(chat, nodes = [], override = {}) {
    let id = 'synthetic-chat'; const calls = [];
    const ctx = { chat, characterId: 0, characters: [{ avatar: 'synthetic.png' }], getCurrentChatId: () => id, extensionSettings: {} };
    globalThis.SillyTavern = { getContext: () => ctx }; delete globalThis.__TAURITAVERN__;
    globalThis.STMnemosyne = {
        getHistory({ before }) {
            calls.push(before);
            return { apiVersion: 1, pluginVersion: 'synthetic', revision: 7, chat: { id, length: chat.length }, before,
                coverage: { complete: true, missingAiFloors: [] }, nodes,
                text: nodes.map(value => value.text).join('\n'), relativeText: '昨天：不应使用的相对时间版本', ...override };
        },
        getFloor() { throw Error('禁止使用会截断 rolling 的正文接口'); },
        getSnapshot() { throw Error('不应读取其他记忆数据'); },
    };
    return { ctx, calls, switchChat: () => { id = 'other-chat'; }, scope: { chatKey: chatKey(), windowStartIndex: 0 } };
}

test('按工作台首楼独立截断摘要，完整首尾包裹，保留绝对时间且不依赖正文隐藏', async () => {
    const chat = [ai(), user(), ai('隐藏楼', { bbs_hidden: true }), user(), ai('可见楼<endTime/>\n<rolling key="合成">保留</rolling>')];
    chat[2].is_system = true;
    const { calls, scope } = setup(chat, [node(0, 2)]);
    const result = await captureHistory({ firstFloor: 4, lastFloor: 4, scope });
    assert.deepEqual(calls, [4]); assert.equal(result.coverage.complete, true);
    assert.equal(result.text, `${MEMORY_BRIEFING_NOTE}\n[历史剧情摘要]\n2085/05/16，合成事件。\n${MEMORY_BRIEFING_END}`);
    assert.equal(result.block.placement, 'before_history'); assert.equal(result.block.content, result.text);
    assert.doesNotMatch(result.text, /昨天/); assert.match(chat[4].mes, /<rolling/);
    assert.deepEqual(result.nodeIds, ['node-0']);
});

test('public coverage 的假完整不能掩盖跨界导入摘要被遗漏造成的缺口', async () => {
    const { scope } = setup([ai(), user(), ai(), user(), ai()], [node(0)]);
    const result = await captureHistory({ firstFloor: 4, lastFloor: 4, scope });
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.coverage.missingAiFloors, [2]);
    assert.match(result.warnings.join(' '), /未被本次历史摘要覆盖/);
});

test('隐藏真实回复仍计覆盖，原生系统楼、番外和内部提示楼不误报缺摘要', async () => {
    const hidden = ai(); hidden.is_system = true;
    const system = ai('系统说明', { type: 'narrator' }); system.is_system = true;
    const { scope } = setup([system, ai('番外', { bbs_omit: true }), ai('内部提示', { bbs_internal_notice: 'backlog' }), hidden, user()], []);
    const result = await captureHistory({ firstFloor: 4, lastFloor: 4, scope });
    assert.deepEqual(result.coverage.missingAiFloors, [3]);
});

test('缺槽位标为未知范围，不能把缺消息当作已完整覆盖', async () => {
    const { scope } = setup([ai(), undefined, undefined, user(), ai()], [node(0)]);
    const result = await captureHistory({ firstFloor: 4, lastFloor: 4, scope });
    assert.equal(result.coverage.complete, false); assert.deepEqual(result.coverage.unknownRanges, [[1, 2]]);
});

test('记忆插件缺失和窗口化接口不确定时只报告缺口，不伪造或错位注入', async () => {
    const { scope, calls } = setup([ai(), user(), ai()]);
    const windowed = await captureHistory({ firstFloor: 201, lastFloor: 202, scope: { ...scope, windowStartIndex: 200 } });
    assert.equal(windowed.text, ''); assert.equal(windowed.coverage.complete, false); assert.deepEqual(calls, []);
    delete globalThis.STMnemosyne;
    const absent = await captureHistory({ firstFloor: 2, lastFloor: 2, scope });
    assert.equal(absent.available, false); assert.equal(absent.block, null); assert.equal(absent.coverage.complete, false);
    const start = await captureHistory({ firstFloor: 0, lastFloor: 2, scope });
    assert.equal(start.coverage.complete, true); assert.deepEqual(start.warnings, []);
});

test('异步读取后聊天切换或接口越界时拒绝结果', async () => {
    const env = setup([ai(), user(), ai()], [node(0)]);
    const read = globalThis.STMnemosyne.getHistory;
    globalThis.STMnemosyne.getHistory = async options => { const result = read(options); env.switchChat(); return result; };
    await assert.rejects(captureHistory({ firstFloor: 2, lastFloor: 2, scope: env.scope }), error => error.code === 'CHAT_CHANGED');
    const second = setup([ai(), user(), ai()], [node(0, 2)]);
    await assert.rejects(captureHistory({ firstFloor: 2, lastFloor: 2, scope: second.scope }), error => error.code === 'HISTORY_OVERLAP');
    const third = setup([ai(), user(), ai()], [node(0)], { before: 3 });
    await assert.rejects(captureHistory({ firstFloor: 2, lastFloor: 2, scope: third.scope }), error => error.code === 'HISTORY_SCOPE_MISMATCH');
});

test('正文并行追加新楼不使已冻结截止点失效，也不带入截止点后的摘要', async () => {
    const { ctx, scope } = setup([ai(), user(), ai()], [node(0)]);
    const read = globalThis.STMnemosyne.getHistory;
    globalThis.STMnemosyne.getHistory = async options => { const result = read(options); ctx.chat.push(ai('新生成正文')); return result; };
    const result = await captureHistory({ firstFloor: 2, lastFloor: 2, scope });
    assert.equal(result.before, 2); assert.equal(result.lastFloor, 2); assert.equal(result.coverage.complete, true);
    assert.doesNotMatch(result.text, /新生成正文/);
});

test('默认助手预设只读自定义核心或内置核心，不读取记忆 API 渠道或带入摘要任务', () => {
    const { ctx } = setup([]);
    ctx.extensionSettings.mnemosyne_daily = { prompts: { jailbreak: ' 自定义助手核心\n' }, apiChannels: [{ key: '不应读取的凭据' }] };
    assert.equal(getDefaultPreset(), ' 自定义助手核心\n');
    ctx.extensionSettings.mnemosyne_daily.prompts.jailbreak = '   ';
    const fallback = getDefaultPreset();
    assert.match(fallback, /^<nvwa_standalone_core>/); assert.match(fallback, /<\/nvwa_standalone_core>$/);
    assert.doesNotMatch(fallback, /不应读取的凭据|根键只有 summary|BuildArgs|输出一个 JSON/);
});
