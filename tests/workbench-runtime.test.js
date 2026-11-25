import test from 'node:test';
import { WorkbenchController } from '../lib/workbench/controller.js';
import assert from 'node:assert/strict';
import { captureWorkbenchContext, assembleWorkbenchPrompt, runtimeCapture, targetMaterial } from '../lib/workbench/context.js';
import { runWorkbench, cancelWorkbenchRun, readWorkbenchRunLog } from '../lib/workbench/llm.js';
import { listPresets, promptSettings, normalizeGenerationSettings, prepareNativeProfile, snapshotText } from '../lib/workbench/tt.js';
import { settingsWithDefaults } from '../lib/workbench/model.js';

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

test('native deep thinking, tool progress and output get a fresh idle window; a silent run stops once', async t => {
    t.mock.timers.enable({ apis: ['Date','setTimeout'] });
    t.mock.method(performance, 'now', () => Date.now());
    const h = setup(t), capture = await h.capture({ generationSettings: {} });
    const pending = runWorkbench(capture, { messages: task, tools: [tool] });
    const rejected = assert.rejects(pending, e => e.code === 'timeout' && /600 秒.*已收到模型正文/.test(e.message));
    await tick();
    const live = h.seen.live.get('run-1');
    t.mock.timers.tick(300_000); // No output for five minutes before the first reasoning delta.
    live({ type:'responseAppend', invocationId:'root', reasoning:'private chain' });
    t.mock.timers.tick(450_000);
    h.seen.subscribers.get('run-1')({type:'tool_call_completed',payload:{name:'plan_archive'}});
    t.mock.timers.tick(450_000);
    live({type:'responseAppend',invocationId:'root',text:'正在归档'});
    t.mock.timers.tick(599_999);
    live({type:'responseAppend',invocationId:'root',text:''});
    assert.deepEqual(h.seen.cancelled,[]);
    t.mock.timers.tick(1);await rejected;
    assert.deepEqual(h.seen.cancelled,['run-1']);
    assert.equal(h.seen.subscribers.size,0);assert.equal(h.seen.live.size,0);
});

test('old native timeout can read its recent stages without retrying or showing raw payloads', async t => {
    const h = setup(t);
    h.agent.readEvents=async input=>{
        assert.deepEqual(input,{runId:'old-run',beforeSeq:Number.MAX_SAFE_INTEGER,limit:40});
        return {events:[
            {seq:16,type:'model_call_attempt_started',payload:{round:2,attempt:1}},
            {seq:17,type:'model_call_attempt_failed',payload:{message:'HTTP 429 invalid x-api-key: old-credential'}},
            {seq:18,type:'run_cancelled',payload:{message:'private cancellation details'}},
        ]};
    };
    const log=await readWorkbenchRunLog('old-run',h.runtime);
    assert.match(log[0].label,/第2轮.*第1次尝试/);assert.match(log[1].label,/模型调用失败.*HTTP 429/);
    assert.match(log[1].detail,/HTTP 429.*已隐藏/);
    assert.match(log[2].label,/已取消/);assert.doesNotMatch(JSON.stringify(log),/private|old-credential/);
    assert.deepEqual(h.seen.starts,[]);
});

test('mid-chat archive preview reads only the inclusive range from a windowed chat', async t => {
    const h = setup(t);
    const reads = [];
    const reader = { offset: 1034, sync: async () => 1036, read: async (first, end) => {
        reads.push([first, end]);
        assert.deepEqual([first, end], [1034, 1036]);
        return h.chat;
    } };
    const c = new WorkbenchController({
        targets: { captureScope: async () => h.scope, listTargets: async () => ({ targets, worlds: [] }) },
        captureHistory: () => assert.fail('manually archived prefix must not be scanned'),
        getDefaultPreset: () => '',
        captureWorkbenchContext: options => captureWorkbenchContext({ ...options, runtime: h.runtime, reader }),
    });
    c.settings = settingsWithDefaults();
    c.job = { mode: 'archive', manualArchive: true, scope: h.scope, firstFloor: 1034, lastFloor: 1035,
        selectedTargetIds: targets.map(t => t.id), batches: [] };
    const capture = await c.preview();
    const prompt = snapshotText((await assembleWorkbenchPrompt(capture, task)).promptSnapshot);
    assert.deepEqual(reads, [[1034, 1036]]);
    assert.deepEqual(capture.rawMessages.map(message => message.floor), [1034, 1035]);
    assert.match(prompt, /<workbench_floor index="1034">/);
    assert.match(prompt, /<workbench_floor index="1035">/);
    assert.ok(prompt.includes(targetMaterial(targets.at(-1))));
    assert.doesNotMatch(prompt, /<workbench_history/);
});

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

test('Claude reverse proxy preserves current per-source auth headers in both assembly and frozen connection', async t => {
    const h = setup(t);
    Object.assign(h.settings, { chat_completion_source: 'claude', claude_model: 'claude-test',
        reverse_proxy: 'https://proxy.invalid/v1', proxy_password: 'synthetic-proxy-key',
        additional_parameters_by_source: { claude: { include_headers: 'X-Api-Key: synthetic-route-key\nX-Route: archive',
            include_body: 'messages: []\nmax_tokens: 1', exclude_body: 'tools' } } });
    h.runtime.openai.getChatCompletionModel = settings => settings.claude_model;
    const original = copy(h.settings), capture = await h.capture(), saved = runtimeCapture(capture);
    const assembled = await assembleWorkbenchPrompt(capture, task);
    const expected = { include_headers: 'X-Api-Key: synthetic-route-key\nX-Route: archive', include_body: '', exclude_body: '' };
    for (const value of [saved.settings, saved.frozen.currentModelConnection.settings, assembled.promptSnapshot.generationParameters]) {
        assert.equal(value.chat_completion_source, 'claude');
        assert.equal(value.reverse_proxy, 'https://proxy.invalid/v1');
        assert.equal(value.proxy_password, 'synthetic-proxy-key');
        assert.deepEqual(value.additional_parameters_by_source.claude, expected);
    }
    assert.equal(saved.settings.temp_openai, 0.25);
    assert.equal(saved.settings.openai_max_tokens, 6000);
    assert.equal(saved.settings.show_thoughts, true);
    assert.ok(saved.settings.extensions.tauritavern.omit_params.includes('reasoning_effort'));
    assert.deepEqual(h.settings, original);
    assert.doesNotMatch(JSON.stringify(capture), /synthetic-proxy-key|synthetic-route-key/);
});

test('native reasoning is coalesced separately and the final snapshot replaces provisional text', async t => {
    const h = setup(t), capture = await h.capture(), thoughts = [], stages = [];
    const pending = runWorkbench(capture, { messages: task, tools: [tool],
        onReasoning: (_, all) => thoughts.push(all), onStatus: stage => stages.push(stage) });
    await tick();
    const live = h.seen.live.get('run-1');
    live({ type: 'responseAppend', invocationId: 'first', reasoning: '检查材料。' });
    live({ type: 'responseAppend', invocationId: 'first', reasoning: '准备计划。' });
    live({ type: 'responseReplace', response: { invocationId: 'first', text: '已提交', reasoning: '检查材料。准备计划。' } });
    live({ type: 'responseAppend', invocationId: 'second', reasoning: '结束。', text: '临时说明' });
    h.seen.subscribers.get('run-1')({ type: 'run_completed', payload: {} });
    const result = await pending;
    assert.equal(result.text, '本批已完整提交。');
    assert.equal(result.reasoning, '检查材料。准备计划。\n\n结束。');
    assert.equal(thoughts.at(-1), result.reasoning);
    assert.equal(stages.filter(value => value === '已收到模型推理').length, 1);
    assert.equal(h.seen.live.size, 0);
});

test('native failure retains an actionable provider error while hiding proxy and header credentials', async t => {
    const h = setup(t);
    h.settings.additional_parameters_by_source = { claude: { include_headers: 'X-Route: synthetic-route' } };
    const capture = await h.capture();
    const pending = runWorkbench(capture, { messages: task, tools: [tool] });
    const rejected = assert.rejects(pending, error => {
        assert.match(error.message, /HTTP 401.*invalid x-api-key/);
        assert.doesNotMatch(error.message, /private-route|synthetic-route|another-secret|private-prompt/);
        assert.equal(error.runId, 'run-1'); return true;
    });
    await tick();
    h.seen.subscribers.get('run-1')({ type: 'model_call_attempt_failed', payload: {
        message: 'HTTP 401: invalid x-api-key; private-route synthetic-route Bearer another-secret', prompt: 'private-prompt',
    } });
    h.seen.subscribers.get('run-1')({ type: 'run_failed', payload: { message: '模型调用失败' } });
    await rejected;
    assert.equal(h.seen.subscribers.size, 0);
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

test('a provider tool failure stops remaining calls and model rounds while retaining returned text and reason',async t=>{
    const h=setup(t),capture=await h.capture({sourceId:'own',channel:{model:'custom-model'}});
    let requests=0;const calls=[];
    await assert.rejects(runWorkbench(capture,{messages:task,tools:[tool],
        requestChannel:async()=>{requests++;return {text:'完整模型正文',reasoning:'已返回的推理',toolCalls:[1,2,3].map(id=>({id:'call-'+id,name:tool.name,arguments:{id}})),finishReason:'tool_calls'};},
        onTool:async(_,args)=>{calls.push(args.id);if(args.id===2)throw TypeError('草案保存失败：合成错误');return {status:'pending_review'};},
    }),error=>{
        assert.equal(error.failure.kind,'tool');assert.equal(error.failure.toolName,tool.name);
        assert.equal(error.failure.message,'草案保存失败：合成错误');assert.equal(error.failure.errorName,'TypeError');
        assert.equal(error.partial.text,'完整模型正文');assert.equal(error.partial.reasoning,'已返回的推理');return true;
    });
    assert.equal(requests,1);assert.deepEqual(calls,[1,2]);
});

test('provider request failures have a distinct model category and retain their transport reason',async t=>{
    const h=setup(t),capture=await h.capture({sourceId:'own',channel:{model:'custom-model',key:'private-provider-key'}});
    await assert.rejects(runWorkbench(capture,{messages:task,requestChannel:async()=>{throw Error('HTTP 502: private-provider-key upstream unavailable');}}),error=>{
        assert.equal(error.failure.kind,'model');assert.match(error.message,/模型请求失败.*HTTP 502/);
        assert.doesNotMatch(JSON.stringify(error.failure),/private-provider-key/);return true;
    });
});

test('a native extension exception cancels immediately and cannot be turned into success by a queued finish',async t=>{
    const h=setup(t),capture=await h.capture();let calls=0,outputReads=0;
    h.agent.readWorkspaceFile=async()=>{outputReads++;return {text:'错误的完成回复'};};
    const pending=runWorkbench(capture,{messages:task,tools:[tool],onTool:async()=>{calls++;throw Error('编辑目标未选中：world:w:999');}});
    const rejected=assert.rejects(pending,error=>{
        assert.equal(error.failure.kind,'tool');assert.match(error.failure.message,/编辑目标未选中/);
        assert.equal(error.partial.text,'模型已经返回');return true;
    });
    await tick();
    const event=h.seen.subscribers.get('run-1'),invoke=h.seen.callbacks.get(tool.name);
    h.seen.live.get('run-1')({type:'responseAppend',invocationId:'inv_root',text:'模型已经返回'});
    const execution={runId:'run-1',callId:'first',signal:new AbortController().signal};
    await assert.rejects(invoke({edits:[]},execution),/编辑目标未选中/);
    event({type:'run_completed',payload:{}});
    await rejected;await tick();
    await assert.rejects(invoke({edits:[]},{...execution,callId:'retry'}),/不属于仍在运行/);
    assert.deepEqual(h.seen.cancelled,['run-1']);assert.equal(calls,1);assert.equal(outputReads,0);
});

test('native error-file reads cannot delay cancellation or let a following completion hide the failure',async t=>{
    const h=setup(t),capture=await h.capture();const reads=[];let resolveFile;
    const path='tool-results/inv_root/round-001-call_test.json';
    h.agent.readWorkspaceFile=async input=>{reads.push(input);return new Promise(resolve=>{resolveFile=resolve;});};
    const pending=runWorkbench(capture,{messages:task,tools:[tool],onTool:async()=>({})});
    const rejected=assert.rejects(pending,error=>{
        assert.equal(error.failure.kind,'tool');assert.equal(error.failure.resultPath,path);
        assert.match(error.failure.message,/真实报错.*尾部原因/s);assert.ok(error.failure.message.length>800);
        assert.doesNotMatch(error.failure.message,/private-route/);return true;
    });
    await tick();const event=h.seen.subscribers.get('run-1');
    event({type:'tool_result_stored',payload:{callId:'failed',invocationId:'inv_root',round:1,path}});
    event({type:'tool_call_failed',payload:{callId:'failed',invocationId:'inv_root',round:1,name:'propose_changes',errorCode:'extension.tool_error',message:'External tool returned an error'}});
    event({type:'run_completed',payload:{}});
    await tick();assert.deepEqual(h.seen.cancelled,['run-1']);
    assert.deepEqual(reads,[{runId:'run-1',path}]);assert.equal(h.seen.subscribers.size,0);
    resolveFile({text:JSON.stringify({callId:'failed',content:'真实报错 private-route '+ '细节'.repeat(450)+' 尾部原因',errorCode:'extension.tool_error'})});
    await rejected;
});

test('an extension failure before onRunStart persistence finishes is latched and cancelled once',async t=>{
    const h=setup(t),capture=await h.capture();let releaseStart;
    const pending=runWorkbench(capture,{messages:task,tools:[tool],
        onRunStart:()=>new Promise(resolve=>{releaseStart=resolve;}),onTool:async()=>{throw Error('早到的工具错误');}});
    const rejected=assert.rejects(pending,error=>error.failure.kind==='tool'&&/早到/.test(error.message));
    await tick();
    await assert.rejects(h.seen.callbacks.get(tool.name)({edits:[]},{runId:'run-1',callId:'early',signal:new AbortController().signal}),/早到/);
    await tick();assert.deepEqual(h.seen.cancelled,['run-1']);
    releaseStart();await rejected;assert.deepEqual(h.seen.cancelled,['run-1']);
});

test('historical tool logs show real file errors, redact credentials and preserve unreadable-file evidence',async t=>{
    const h=setup(t),reads=[];
    const path='tool-results/inv_root/round-001-call_log.json';
    h.agent.readEvents=async()=>({events:[
        {seq:19,type:'tool_call_failed',payload:{callId:'failed',name:'propose_changes',errorCode:'extension.tool_error',message:'External tool returned an error; full result: '+path}},
    ]});
    h.agent.readWorkspaceFile=async input=>{reads.push(input);return {text:JSON.stringify({content:'补丁原文未唯一命中；x-api-key: secret-key\n'+'详细原因'.repeat(200),arguments:'private draft not for the log'})};};
    const log=await readWorkbenchRunLog('historic-run',h.runtime);
    assert.deepEqual(reads,[{runId:'historic-run',path}]);assert.match(log[0].detail,/补丁原文未唯一命中/);
    assert.ok(log[0].detail.length>800);assert.doesNotMatch(log[0].detail,/secret-key|private draft/);
    h.agent.readWorkspaceFile=async()=>{throw Error('文件已清理');};
    const missing=await readWorkbenchRunLog('historic-run',h.runtime);
    assert.match(missing[0].detail,/extension.tool_error/);assert.ok(missing[0].detail.includes(path));
    assert.match(missing[0].detail,/读取工具错误文件失败：文件已清理/);assert.deepEqual(h.seen.starts,[]);
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

test('plain main discussion uses frozen settings, sends no Agent tools and requires a complete Claude stream',async t=>{
    const h=setup(t),capture=await h.capture(),frames=[
        {type:'content_block_delta',delta:{thinking:'思考'}},
        {type:'content_block_delta',delta:{text:'第一批合成条目，第二批合成人物。'}},
        {type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'},
    ];
    h.ctx.getRequestHeaders=()=>({'X-CSRF-Token':'synthetic'});
    h.runtime.openai.createGenerationParameters=async(settings,model,type,messages,options)=>{
        assert.equal(settings.proxy_password,'private-route');assert.equal(settings.openai_max_tokens,6000);
        assert.equal(options.allowToolCalls,false);assert.doesNotMatch(JSON.stringify(messages),/workspace[.]write_file/);
        return {generate_data:{model,messages,chat_completion_source:'claude',stream:true}};
    };
    let calls=0;
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        calls++;assert.equal(url,'/api/backends/chat-completions/generate');
        const sent=JSON.parse(options.body);assert.equal(sent.tools,undefined);assert.equal(sent.type,'quiet');
        return new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    });
    const result=await runWorkbench(capture,{plainReply:true,messages:task,tools:[]});
    assert.equal(result.text,'第一批合成条目，第二批合成人物。');assert.equal(result.reasoning,'思考');
    frames.pop();
    await assert.rejects(runWorkbench(capture,{plainReply:true,messages:task}),e=>e.code==='TRUNCATED'&&e.partial.text.includes('第一批'));
    assert.equal(calls,2);assert.deepEqual(h.seen.starts,[]);
});

test('plan registration uses the discussion and never reads the selected story range or archive text',async t=>{
    const h=setup(t),capture=await h.capture({discussionOnly:true,firstFloor:100,lastFloor:199,
        reader:{sync:()=>assert.fail('range read'),read:()=>assert.fail('story read')}});
    assert.deepEqual(capture.rawMessages,[]);assert.deepEqual(capture.selectedTargets,[]);
    assert.equal(capture.historyBlock,'');
    const result=await assembleWorkbenchPrompt(capture,[{role:'assistant',content:'商定的第二批'},{role:'user',content:'开始整理'}]);
    const text=snapshotText(result.promptSnapshot);assert.match(text,/商定的第二批/);
    assert.doesNotMatch(text,/正文\n<endTime>|世界事实|早先完整总结/);
});
