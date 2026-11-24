import test from 'node:test';
import { WorkbenchController } from '../lib/workbench/controller.js';
import assert from 'node:assert/strict';
import { captureWorkbenchContext, assembleWorkbenchPrompt, runtimeCapture, targetMaterial } from '../lib/workbench/context.js';
import { runWorkbench, cancelWorkbenchRun } from '../lib/workbench/llm.js';
import { listPresets, promptSettings, normalizeGenerationSettings, prepareNativeProfile, snapshotText } from '../lib/workbench/tt.js';

const copy = value => structuredClone(value);
const tool = { name: 'stage_changes', description: 'Save complete drafts', parameters: { type: 'object', properties: { edits: { type: 'array' } }, required: ['edits'] } };
const task = [{ role: 'user', content: '整理这一段，先提交草案。' }];
const targets = [
    { id: 'user:u:description', kind: 'user', field: 'description', content: 'User设定', metadata: { position: 0 } },
    { id: 'char:c:description', kind: 'char', field: 'description', content: 'Char设定', metadata: {} },
    { id: 'char:c:system_prompt', kind: 'char', field: 'system_prompt', content: '', metadata: {} },
    { id: 'world:w:1', kind: 'world', world: 'w', uid: 1, content: '世界事实', metadata: { comment: 'S-001', key: ['关键词'], constant: true, position: 4, depth: 2, order: 10 } },
];
function setup(t, options = {}) {
    const oldST = globalThis.SillyTavern, oldTT = globalThis.__TAURITAVERN__;
    t.after(() => { globalThis.SillyTavern = oldST; globalThis.__TAURITAVERN__ = oldTT; });
    const ref = { kind: 'character', characterId: 'c.png', fileName: 'story' };
    const scope = { chatKey: JSON.stringify(['character', 'c.png', 'story']), chatRef: ref, characterAvatar: 'c.png', personaAvatar: 'u.png', worldNames: ['w'] };
    const chat = [
        { is_user: true, name: 'User', mes: '第一楼' },
        { is_user: false, name: 'Char', mes: '正文\n<endTime>结束</endTime>\n<rolling key="进行">新事实</rolling>', is_system: true },
    ];
    const ctx = { chat, characterId: 0, characters: [{ avatar: 'c.png', chat: 'story' }] };
    const seen = { assemblies: [], starts: [], profiles: [], registrations: [], cancelled: [], subscribers: new Map(), live: new Map(), callbacks: new Map(), unsubscribed: 0 };
    let serial = 0;
    const settings = { chat_completion_source: 'custom', custom_model: 'current-model', temp_openai: 1.99,
        openai_max_tokens: 123, openai_max_context: 4000, stream_openai: false,
        custom_api_format: 'claude_messages', custom_url: 'https://example.invalid/v1',
        custom_include_headers: 'Authorization: hidden-header', proxy_password: 'private-route',
        custom_include_body: 'temperature: 1.99\nmetadata: required', custom_exclude_body: 'tools',
        additional_parameters_by_source: { custom: { include: 'max_tokens: 7' } } };
    const named = { prompts: [{ identifier: 'main', content: '自选结构' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        temperature: 1.8, openai_max_tokens: 9, custom_url: 'https://wrong.invalid', chat_completion_source: 'wrong' };
    const agent = {
        promptAssembly: { buildSnapshot: async input => {
            seen.assemblies.push(copy(input));
            assert.equal(Object.hasOwn(input, 'promptInputs'), false, 'frozen inputs must not also be top-level');
            assert.equal(Object.hasOwn(input, 'macroContext'), false);
            const frozen = input.frozenRunInputSnapshot, p = frozen.promptInputs;
            const materials = [p.charDescription, p.charPersonality, p.scenario,
                frozen.macroContext.characterTemplates.persona, p.worldInfoBefore, p.worldInfoAfter,
                ...Object.values(p.extensionPrompts).map(x => x.value),
                ...[...p.worldInfoExamples.before, ...p.messageExamples, ...p.worldInfoExamples.after].flat().map(x => x.content)];
            let messages = [
                { role: 'system', content: input.agentSystemPrompt },
                { role: 'system', content: input.agentTaskPrompt },
                ...materials.filter(Boolean).map(content => ({ role: 'system', content })),
                ...copy(p.messages).reverse(),
            ];
            if (options.transform) messages = options.transform(messages);
            return { promptSnapshot: { messages: messages.map(m => ({ role: m.role, parts: [{ type: 'text', text: m.content }] })), generationParameters: copy(input.settings) },
                frozenRunInputSnapshot: copy(frozen), assembly: { engine: 'mock' } };
        } },
        profiles: { load: async () => ({ profile: { schemaVersion: 5, kind: 'tauritavern.agentProfile', id: 'default-writer',
            run: {}, tools: {}, delegation: {}, workspace: {}, output: {} } }), save: async profile => { seen.profiles.push(copy(profile)); } },
        tools: { register: async (definition, execute) => { seen.registrations.push(copy(definition)); seen.callbacks.set(definition.name, execute); } },
        startRunWithPromptSnapshot: async input => { seen.starts.push(copy(input)); return { runId: 'run-' + (++serial) }; },
        subscribe: (runId, fn) => { seen.subscribers.set(runId, fn); return () => { seen.subscribers.delete(runId); seen.unsubscribed++; }; },
        subscribeLiveProjection: (runId, fn) => { seen.live.set(runId, fn); return () => { seen.live.delete(runId); }; },
        readWorkspaceFile: async () => ({ text: '本批已完整提交。' }),
        cancel: async runId => { seen.cancelled.push(runId); return { runId, status: 'cancelling' }; },
    };
    const api = { agent, chat: { current: { ref: () => ref, windowInfo: async () => ({ totalCount: chat.length, windowStartIndex: 0 }) }, open: () => ({ stableId: async () => 'stable-story' }) } };
    const runtime = {
        api, script: { main_api: 'openai', extension_prompts: {} }, power: {},
        openai: { oai_settings: settings, getChatCompletionModel: value => value.custom_model,
            normalizeChatCompletionSettingsForPromptAssembly: value => ({ prompts: [{ identifier: 'main', content: 'Default' }], ...copy(value) }) },
        presets: { getPresetManager: () => ({ getPresetList: () => ({ preset_names: { Named: 0 } }), getCompletionPresetByName: name => name === 'Named' ? named : undefined }) },
        secrets: { resolveSecretKey: () => 'api-key', secret_state: { 'api-key': [{ id: 'secret-ref', active: true }] } },
        macros: { captureContext: () => ({ engine: 'new', names: { user: 'User', char: 'Char' }, character: { description: '未选择的旧内容', persona: '未选择User', personaPosition: 0 },
            chat: {}, state: {}, settings: { context: {}, reasoning: {} }, system: {}, variables: { local: {}, global: {} }, extensionPrompts: {}, now: 100 }) },
        frozen: {
            buildCurrentModelConnectionSnapshot: async ({ settings: current, model }) => ({ schemaVersion: 1, kind: 'tauritavern.currentModelConnectionSnapshot', settings: { ...copy(current), model, secret_id: 'secret-ref' } }),
            buildSettingsWithCurrentModelConnectionSnapshot: async (base, connection) => ({ ...copy(base), ...copy(connection.settings) }),
            updateFrozenMacroContext: (snapshot, macro, { characterValues }) => ({ ...snapshot, macroContext: { ...copy(macro), characterTemplates: copy(macro.character), character: copy(characterValues) }, variables: copy(macro.variables) }),
            buildFrozenRunInputSnapshot: value => ({ schemaVersion: 2, kind: 'tauritavern.agentFrozenRunInputSnapshot', ...copy(value) }),
        },
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.__TAURITAVERN__ = { api };
    const capture = overrides => captureWorkbenchContext({ runtime, scope, firstFloor: 0, lastFloor: 1, selectedTargets: copy(targets),
        duties: '只整理资料，修改先审核。', defaultPreset: '助手默认基础提示', historyBlock: '早先完整总结', generationSettings: { temperature: 0.25, maxTokens: 6000, contextSize: 100000, stream: true, timeoutSec: 30 }, ...overrides });
    return { runtime, seen, chat, ctx, scope, settings, named, capture, agent };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('capture preserves hidden raw body and rolling, freezes its range, and carries labelled selected materials only', async t => {
    const h = setup(t), capture = await h.capture();
    assert.equal(capture.rawMessages[1].role, 'assistant');
    assert.match(capture.rawMessages[1].content, /<rolling key="进行">新事实<\/rolling>/);
    h.chat[1].mes = '主聊天后来已修改';
    h.chat.push({ mes: '新楼层', name: 'Char' });
    const result = await assembleWorkbenchPrompt(capture, task);
    const text = snapshotText(result.promptSnapshot);
    assert.match(text, /新事实/);
    assert.doesNotMatch(text, /主聊天后来已修改|新楼层|未选择的旧内容|未选择User/);
    for (const target of targets) assert.ok(text.includes(targetMaterial(target)));
    assert.ok(text.indexOf('早先完整总结') < text.indexOf('<workbench_floor index="0">'));
    const p = h.seen.assemblies[0].frozenRunInputSnapshot.promptInputs;
    assert.equal(p.systemPromptOverride, '');
    assert.equal(p.jailbreakPromptOverride, '');
    assert.equal(p.extensionPrompts.customDepthWI_2_0.depth, 2);
    assert.equal(capture.scope.windowStartIndex, 0);
});

test('named preset reads layout without changing live settings; plugin controls override main samplers while route survives', async t => {
    const h = setup(t), before = copy(h.settings);
    assert.deepEqual(await listPresets(h.runtime), [{ id: 'Named', name: 'Named' }]);
    const layout = promptSettings(h.runtime, 'Named');
    assert.deepEqual(layout.prompt_order, h.named.prompt_order);
    assert.equal(layout.temperature, undefined);
    assert.equal(layout.custom_url, undefined);
    const capture = await h.capture({ presetId: 'Named' }), hidden = runtimeCapture(capture);
    assert.equal(hidden.settings.temp_openai, 0.25);
    assert.equal(hidden.settings.openai_max_tokens, 6000);
    assert.equal(hidden.settings.openai_max_context, 100000);
    assert.equal(hidden.settings.stream_openai, true);
    assert.equal(hidden.settings.custom_api_format, 'claude_messages');
    assert.equal(hidden.settings.custom_include_headers, 'Authorization: hidden-header');
    assert.equal(hidden.settings.proxy_password, 'private-route');
    assert.equal(hidden.settings.custom_include_body, '');
    assert.equal(hidden.frozen.currentModelConnection.settings.custom_include_body, '');
    assert.equal(hidden.frozen.currentModelConnection.settings.custom_exclude_body, '');
    assert.equal(hidden.frozen.currentModelConnection.settings.temp_openai, undefined);
    assert.equal(hidden.frozen.currentModelConnection.settings.openai_max_tokens, undefined);
    assert.equal(hidden.frozen.currentModelConnection.settings.stream_openai, undefined);
    assert.deepEqual(hidden.frozen.currentModelConnection.settings.additional_parameters_by_source, {});
    assert.deepEqual(h.settings, before);
    assert.doesNotMatch(JSON.stringify(capture), /hidden-header|private-route|secret-ref/);
});

test('assembly rejects missing body, selected target or duties before any paid run', async t => {
    for (const missing of ['<workbench_floor index="0">', '<worldbook_entry', '<workbench_duties>']) {
        const h = setup(t, { transform: messages => messages.filter(m => !m.content.includes(missing)) });
        const capture = await h.capture();
        await assert.rejects(runWorkbench(capture, { messages: task, tools: [tool] }), /未完整保留|没有保留/);
        assert.equal(h.seen.starts.length, 0);
    }
});

test('wrong chat and incomplete raw range fail closed; independent context never uses Generate', async t => {
    const h = setup(t);
    await assert.rejects(h.capture({ scope: { ...h.scope, chatKey: 'other' } }), /聊天已切换/);
    await assert.rejects(h.capture({ reader: { offset: 0, sync: async () => 2, read: async () => [h.chat[0]] } }), /没有完整返回/);
    h.runtime.script.Generate = () => { throw new Error('must never call Generate'); };
    const capture = await h.capture();
    await assembleWorkbenchPrompt(capture, task);
    assert.equal(h.seen.assemblies.length, 1);
});

test('native workbench profile supports direct background runs with draft-only tools and no delegation', async t => {
    const h = setup(t);
    const id = await prepareNativeProfile(h.agent, [tool], 'duties');
    assert.equal(await prepareNativeProfile(h.agent, [tool], 'changed duties'), id);
    assert.equal(h.seen.registrations.length, 1);
    assert.equal(h.seen.profiles.length, 1);
    assert.deepEqual(h.seen.registrations[0].contexts, ['chat']);
    const profile = h.seen.profiles[0];
    assert.equal(profile.run.presentation, 'background');
    assert.equal(profile.run.directRunnable, true);
    assert.deepEqual(profile.tools.allow, ['extension/mnemosyne-notes:stage_changes', 'builtin:workspace.write_file', 'builtin:workspace.finish']);
    assert.ok(profile.tools.deny.includes('builtin:workspace.commit'));
    assert.deepEqual(profile.workspace.writableRoots, ['output']);
    assert.equal(profile.delegation.canDelegate, false);
    assert.equal(profile.delegation.canHandoff, false);
    assert.equal(profile.delegation.callable, false);
    assert.equal(profile.delegation.allowAsSubagent, false);
    assert.equal(profile.delegation.allowAsHandoffTarget, false);
});

test('native runs expose identity, deduplicate callbacks, and unsubscribe on authoritative completion', async t => {
    const h = setup(t), capture = await h.capture();
    let runId, calls = 0;
    const pending = runWorkbench(capture, {
        messages: task, tools: [tool], onRunStart: value => { runId = value.runId; },
        onTool: async () => { calls++; return { saved: true }; },
        onText: () => { throw new Error('view unmounted'); },
    });
    await tick();
    assert.equal(runId, 'run-1');
    assert.equal(h.seen.starts[0].presentation, 'background');
    assert.deepEqual(h.seen.starts[0].options, { stream: true, startWithEmptyPersist: true });
    const invoke = h.seen.callbacks.get(tool.name);
    const execution = { runId, callId: 'call-1', signal: new AbortController().signal };
    await Promise.all([invoke({ edits: [] }, execution), invoke({ edits: [] }, execution)]);
    assert.equal(calls, 1);
    h.seen.subscribers.get(runId)({ type: 'run_completed', payload: {} });
    const result = await pending;
    assert.equal(result.text, '本批已完整提交。');
    assert.equal(result.runId, runId);
    assert.equal(h.seen.subscribers.size, 0);
    assert.equal(h.seen.live.size, 0);
    await assert.rejects(invoke({ edits: [] }, execution), /不属于仍在运行/);
});

test('native cancellation targets only its own run and returns cancellation receipt separately', async t => {
    const h = setup(t), capture = await h.capture();
    const controller = new AbortController();
    let receipt;
    const pending = runWorkbench(capture, { messages: task, tools: [tool], signal: controller.signal, onTool: async () => null, onCancel: value => { receipt = value; } });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError' && error.runId === 'run-1' && error.cancellation === 'requested');
    await tick(); controller.abort(); await rejected; await tick();
    assert.deepEqual(h.seen.cancelled, ['run-1']);
    assert.equal(receipt.receipt.status, 'cancelling');
    assert.equal(h.seen.subscribers.size, 0);
    assert.equal(h.seen.live.size, 0);
    assert.deepEqual(await cancelWorkbenchRun('saved-own-run', h.runtime), { runId: 'saved-own-run', status: 'cancelling' });
    h.agent.cancel = async () => { throw new Error('native cancellation failed'); };
    await assert.rejects(cancelWorkbenchRun('saved-own-run', h.runtime), /cancellation failed/);
});

test('custom provider gets one assembled body and plugin settings, then complete tool results', async t => {
    const h = setup(t), capture = await h.capture({ sourceId: 'own', channel: { id: 'own', model: 'custom-model', url: 'https://custom.invalid/v1', key: 'private-channel-key' } });
    const requests = []; let calls = 0;
    const result = await runWorkbench(capture, { messages: task, tools: [tool], onTool: async (name, args) => { calls++; assert.equal(name, tool.name); assert.deepEqual(args, { edits: [] }); return { saved: true }; },
        requestChannel: async (channel, messages) => {
            requests.push({ channel: copy(channel), messages: copy(messages) });
            return requests.length === 1 ? { text: '准备提交', toolCalls: [{ id: 'c1', name: tool.name, arguments: { edits: [] } }], finishReason: 'tool_calls' }
                : { text: '完成', toolCalls: [], finishReason: 'stop' };
        } });
    assert.equal(result.text, '完成');
    assert.equal(calls, 1);
    assert.equal(requests[0].channel.temperature, 0.25);
    assert.equal(requests[0].channel.model, 'custom-model');
    assert.equal(requests[1].messages.filter(m => m.content.includes('<workbench_floor index="0">')).length, 1);
    assert.equal(requests[1].messages.at(-1).role, 'tool');
    assert.equal(requests[1].messages.at(-1).content, '{"saved":true}');
    assert.doesNotMatch(JSON.stringify(capture), /private-channel-key/);
});

test('truncated provider completion and call-ID reuse with different arguments never count as success', async t => {
    const h = setup(t), capture = await h.capture({ sourceId: 'own', channel: { model: 'custom-model' } });
    await assert.rejects(runWorkbench(capture, { messages: task, requestChannel: async () => ({ text: 'half', toolCalls: [], finishReason: 'length' }) }), error => error.code === 'incomplete_response');
    let round = 0, calls = 0;
    await assert.rejects(runWorkbench(capture, { messages: task, tools: [tool], onTool: async () => { calls++; return {}; },
        requestChannel: async () => ({ text: '', toolCalls: [{ id: 'same-id', name: tool.name, arguments: { edits: [++round] } }], finishReason: 'tool_calls' }) }), error => error.code === 'tool_call_id_collision');
    assert.equal(calls, 1);
});

test('generation controls are validated and do not retain unrelated channel fields', () => {
    assert.throws(() => normalizeGenerationSettings({ maxTokens: 100, contextSize: 100 }), /小于/);
    assert.throws(() => normalizeGenerationSettings({ timeoutSec: 0 }), /正整数/);
    assert.throws(() => normalizeGenerationSettings({ temperature: 3 }), /0–2/);
    const settings = normalizeGenerationSettings({ temperature: null, key: 'never-copy', stream: false });
    assert.equal(settings.temperature, null);
    assert.equal(settings.stream, false);
    assert.equal(settings.key, undefined);
});


test('native local cancellation rejects a delayed draft after retry and cleans fallback listeners', async t => {
    const h = setup(t), capture = await h.capture();
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    t.after(() => { if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor); else delete AbortSignal.any; });
    let release, persisted = 0;
    const preparation = new Promise(resolve => { release = resolve; });
    const job = { id: 'job', mode: 'free', scope: h.scope, batches: [{ id: 'batch', status: 'pending', items: [], report: { cleared: [], retained: [], closed: [] } }] };
    const controller = new WorkbenchController({ targets: { prepareOperations: () => preparation } });
    controller.job = job; controller.captureTargets = copy(targets);
    controller.captureAllowed = new Set(targets.map(value => value.id));
    controller.persist = async () => { persisted++; };
    controller.changed = () => {};
    const outer = new AbortController(), native = new AbortController();
    let added = 0, removed = 0;
    const add = native.signal.addEventListener.bind(native.signal);
    const remove = native.signal.removeEventListener.bind(native.signal);
    native.signal.addEventListener = (...args) => { added++; return add(...args); };
    native.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
    const propose = { ...tool, name: 'propose_changes' };
    const run = runWorkbench(capture, { messages: task, tools: [propose], signal: outer.signal,
        onTool: (name, args, execution) => controller.onTool(job, 'edit', name, args, execution) });
    const cancelledRun = assert.rejects(run, error => error.name === 'AbortError');
    await tick();
    const delayed = h.seen.callbacks.get(propose.name)({ operations: [{ action: 'replace', target: 'world:w:1', content: '旧请求' }] },
        { runId: 'run-1', callId: 'late-call', signal: native.signal });
    const cancelledTool = assert.rejects(delayed, error => error.name === 'AbortError');
    await tick();
    outer.abort(); await cancelledRun;
    // Cancel RPC acknowledged, but the native side has not yet aborted this tool.
    assert.equal(native.signal.aborted, false);
    // Retry the same persisted job: new capture fields are present again.
    controller.captureTargets = copy(targets);
    controller.captureAllowed = new Set(targets.map(value => value.id));
    release([{ target: { id: 'world:w:1', kind: 'world' }, action: 'replace', before: { content: 'before' }, after: { content: '旧请求' } }]);
    await cancelledTool;
    assert.equal(job.batches[0].items.length, 0);
    assert.equal(persisted, 0);
    assert.equal(added, 1);
    assert.equal(removed, 1);
});

test('selected entries sharing the same outlet all survive in insertion order', async t => {
    const h = setup(t);
    const first = { id: 'world:w:10', kind: 'world', world: 'w', uid: 10, content: '第一个outlet内容',
        metadata: { position: 7, outletName: 'timeline', order: 10 } };
    const second = { id: 'world:w:20', kind: 'world', world: 'w', uid: 20, content: '第二个outlet内容',
        metadata: { position: 7, outletName: 'timeline', order: 20 } };
    const capture = await h.capture({ selectedTargets: [second, first] });
    const result = await assembleWorkbenchPrompt(capture, task);
    const outlet = h.seen.assemblies[0].frozenRunInputSnapshot.promptInputs.extensionPrompts.customWIOutlet_timeline;
    assert.equal(outlet.position, -1);
    assert.equal(outlet.value, targetMaterial(first) + '\n' + targetMaterial(second));
    assert.ok(snapshotText(result.promptSnapshot).includes(targetMaterial(first)));
    assert.ok(snapshotText(result.promptSnapshot).includes(targetMaterial(second)));
});
