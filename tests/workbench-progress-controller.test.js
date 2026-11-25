import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchController } from '../lib/workbench/controller.js';
import { settingsWithDefaults } from '../lib/workbench/model.js';

function setup() {
    const saved = [], requests = [], changes = [];
    const c = new WorkbenchController({ storage: { putJob: async job => saved.push(structuredClone(job)) } });
    c.settings = settingsWithDefaults();
    c.scope = { chatKey: 'synthetic-progress', worldNames: [] };
    c.state = { mode: 'free' };
    c.job = { id: 'progress-job', scope: c.scope, mode: 'free', status: 'draft', firstFloor: 0, lastFloor: 1,
        selectedTargetIds: [], enabledWorlds: [], plan: [], messages: [],
        batches: [{ id: 'batch-1', title: '自由编辑', instructions: '', status: 'pending', items: [] }] };
    c.captureFor = async () => ({});
    c.subscribe(kind => changes.push({ kind, reasoning: c.liveReasoning, stage: c.liveStatus }));
    c.api.runWorkbench = async (_, options) => { requests.push(options); return { text: '合成回复' }; };
    return { c, saved, requests, changes };
}

test('reasoning/status callbacks reach the view without per-fragment persistence, then reasoning survives save', async () => {
    const { c, saved, changes } = setup();
    c.api.runWorkbench = async (_, options) => {
        options.onStatus('已收到模型推理');
        const writes = saved.length;
        for (let i = 0; i < 80; i++) options.onReasoning('片', '合成推理' + i);
        assert.equal(saved.length, writes, 'streaming must not repeatedly write the whole job');
        assert.equal(c.liveReasoning, '合成推理79');
        options.onText('回复', '合成回复');
        return { text: '完整回复', reasoning: '完整合成推理', finishReason: 'stop' };
    };
    await c.send('查询合成材料');
    assert.ok(changes.some(item => item.kind === 'status' && item.stage === '已收到模型推理'));
    assert.ok(changes.some(item => item.kind === 'text' && item.reasoning === '合成推理79'));
    assert.deepEqual(saved.at(-1).messages.at(-1), { role: 'assistant', content: '完整回复', reasoning: '完整合成推理' });
    assert.equal(c.running, false); assert.equal(c.liveStatus, ''); assert.equal(c.job.status, 'discussion');
});

test('saved reasoning and plan display cards do not become next-turn prompt messages', async () => {
    const { c, requests } = setup();
    c.job.messages.push({ role: 'assistant', content: '仅界面计划卡片', kind: 'plan' },
        { role: 'assistant', content: '前次回答', reasoning: '前次私有推理字段' });
    await c.send('继续查询');
    assert.deepEqual(requests[0].messages[0], { role: 'assistant', content: '前次回答' });
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /前次私有推理字段|仅界面计划卡片|"reasoning"/);
});

test('interrupted text and reasoning remain incomplete while the transport failure remains visible', async () => {
    const { c, saved } = setup();
    c.api.runWorkbench = async (_, options) => {
        options.onReasoning('检查', '检查合成范围');
        options.onText('片段', '未完成回复');
        options.onStatus('模型调用失败：HTTP 502');
        throw Error('HTTP 502：上游暂不可用');
    };
    await c.send('继续查询');
    assert.equal(c.job.status, 'interrupted');
    assert.match(c.job.error, /HTTP 502/);
    assert.deepEqual(saved.at(-1).messages.at(-1), { role: 'assistant', content: '未完成回复', reasoning: '检查合成范围', incomplete: true });
    assert.equal(c.running, false); assert.equal(c.abort, null);
});

test('a non-stream failure can restore provider partial text/reasoning without claiming success', async () => {
    const { c, saved } = setup();
    c.api.runWorkbench = async () => {
        const error = Error('输出没有完整结束');
        error.partial = { text: '已返回的正文片段', reasoning: '已返回的推理片段' };
        throw error;
    };
    await c.send('合成测试');
    assert.equal(c.job.status, 'interrupted');
    assert.deepEqual(saved.at(-1).messages.at(-1), { role: 'assistant', content: '已返回的正文片段', reasoning: '已返回的推理片段', incomplete: true });
});
