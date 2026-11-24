// TT 2.4 independent PromptManager and background Agent adapter.
// No live preset switching, Generate(), quiet calls or global request mutation.
import { DEFAULT_TIMEOUT_SECONDS } from './progress.js';
export class WorkbenchCapabilityError extends Error {
    constructor(message, code = 'workbench_capability_unavailable') {
        super(message); this.name = 'WorkbenchCapabilityError'; this.code = code;
    }
}
let runtimePromise;
export async function getTTRuntime() {
    runtimePromise ??= loadRuntime().catch(error => { runtimePromise = null; throw error; });
    return runtimePromise;
}
async function loadRuntime() {
    const api = globalThis.__TAURITAVERN__?.api;
    if (typeof api?.agent?.promptAssembly?.buildSnapshot !== 'function') {
        throw new WorkbenchCapabilityError('工作台需要 TT 2.4 的独立提示词组装接口；当前宿主不支持。');
    }
    try {
        const [openai, presets, macros, frozen, secrets, power, script] = await Promise.all([
            import('/scripts/openai.js'), import('/scripts/preset-manager.js'),
            import('/scripts/macros/macro-system.js'),
            import('/scripts/tauritavern/agent/frozen-run-input-snapshot.js'),
            import('/scripts/secrets.js'), import('/scripts/power-user.js'), import('/script.js'),
        ]);
        return { api, openai, presets, macros, frozen, secrets, power, script };
    } catch (error) { throw new WorkbenchCapabilityError('无法读取 TT 的独立提示词接口：' + error.message); }
}
export async function listPresets(runtime) {
    const host = runtime ?? await getTTRuntime();
    const manager = host.presets.getPresetManager('openai');
    if (!manager?.getPresetList) throw new WorkbenchCapabilityError('当前 TT 没有聊天补全预设读取接口。');
    const names = manager.getPresetList().preset_names;
    return (Array.isArray(names) ? names : Object.keys(names ?? {})).map(name => ({ id: name, name }));
}
const PROMPT_KEYS = ['prompts', 'prompt_order', 'names_behavior', 'send_if_empty',
    'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt',
    'new_example_chat_prompt', 'continue_nudge_prompt', 'wi_format', 'scenario_format',
    'personality_format', 'group_nudge_prompt', 'assistant_prefill',
    'assistant_impersonation', 'use_sysprompt', 'squash_system_messages',
    'continue_prefill', 'continue_postfix'];

export function promptSettings(host, presetId, defaultPreset = '') {
    let saved;
    if (presetId && presetId !== 'assistant-default') {
        saved = host.presets.getPresetManager('openai')?.getCompletionPresetByName?.(presetId);
        if (!saved) throw new Error('聊天补全预设「' + presetId + '」已不存在，请重新选择。');
    }
    const prompt = {};
    for (const key of PROMPT_KEYS) if (saved?.[key] !== undefined) prompt[key] = structuredClone(saved[key]);
    const settings = host.openai.normalizeChatCompletionSettingsForPromptAssembly(prompt);
    if (!saved) {
        settings.prompts = structuredClone(settings.prompts);
        const main = settings.prompts.find(item => item.identifier === 'main');
        if (main) main.content = String(defaultPreset || '你是记事簿助手。依据明确提供的材料和用户要求整理设定，所有修改必须先提交待审核草案。');
        settings.new_chat_prompt = ''; settings.new_group_chat_prompt = '';
        settings.group_nudge_prompt = ''; settings.assistant_prefill = '';
    }
    return settings;
}

export const DEFAULT_GENERATION = Object.freeze({
    temperature: 0.7, maxTokens: 4096, contextSize: 128000,
    stream: true, reasoningEffort: 'auto', timeoutSec: DEFAULT_TIMEOUT_SECONDS,
});
export function normalizeGenerationSettings(input = {}) {
    const result = { ...DEFAULT_GENERATION };
    for (const key of Object.keys(DEFAULT_GENERATION)) if (input[key] !== undefined) result[key] = input[key];
    for (const key of ['maxTokens', 'contextSize', 'timeoutSec']) {
        result[key] = Number(result[key]);
        if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(key + ' 必须是正整数。');
    }
    if (result.maxTokens >= result.contextSize) throw new Error('最大输出 token 必须小于上下文窗口。');
    result.temperature = result.temperature === null || result.temperature === '' ? null : Number(result.temperature);
    if (result.temperature !== null && (!Number.isFinite(result.temperature) || result.temperature < 0 || result.temperature > 2)) throw new Error('温度须在 0–2 之间。');
    result.stream = result.stream !== false;
    result.reasoningEffort = String(result.reasoningEffort || 'auto');
    return result;
}
export function applyGenerationSettings(settings, generation) {
    const next = structuredClone(settings);
    Object.assign(next, {
        temp_openai: generation.temperature ?? 1, openai_max_tokens: generation.maxTokens,
        openai_max_context: generation.contextSize, stream_openai: generation.stream,
        reasoning_effort: generation.reasoningEffort, n: 1,
        enable_web_search: false, request_images: false, function_calling: true,
        additional_parameters_by_source: {}, custom_include_body: '', custom_exclude_body: '',
    });
    // Generation omission is notebook-owned as well. TT merges defaults before
    // shaping a request, so merely deleting temp_openai would not omit temperature.
    const omit = ['frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty', 'seed'];
    if (generation.temperature === null) omit.push('temperature');
    if (generation.reasoningEffort === 'auto') omit.push('reasoning_effort');
    next.extensions = { tauritavern: { omit_params: omit } };
    return next;
}
export async function captureConnection(host, sourceId, channel, baseSettings, generation) {
    if (sourceId !== 'main') {
        if (!channel?.model) throw new Error('请先在记事簿中配置此 API 的模型。');
        return { settings: applyGenerationSettings({ ...baseSettings, chat_completion_source: 'custom', custom_model: channel.model }, generation),
            model: channel.model, connection: null };
    }
    if (host.script.main_api !== 'openai') throw new WorkbenchCapabilityError('主 API 选项只支持 TT 的聊天补全模型；请切换正文连接或选择记事簿自建 API。');
    const current = structuredClone(host.openai.oai_settings);
    const model = host.openai.getChatCompletionModel(current);
    if (!model) throw new Error('正文连接尚未选定模型。');
    const connection = await host.frozen.buildCurrentModelConnectionSnapshot({
        settings: current, model, secretKey: host.secrets.resolveSecretKey(), secretState: host.secrets.secret_state,
    });
    // Freeze the same isolation rule for any native reassembly of this run.
    // Opaque TT JSON/YAML body patches may contain samplers or tool overrides;
    // first version does not import them. Headers/proxy/protocol remain intact.
    connection.settings = { ...connection.settings, additional_parameters_by_source: {},
        custom_include_body: '', custom_exclude_body: '' };
    for (const key of ['temperature', 'temp_openai', 'top_p', 'top_p_openai', 'top_k', 'top_k_openai',
        'frequency_penalty', 'freq_pen_openai', 'presence_penalty', 'pres_pen_openai',
        'max_tokens', 'max_completion_tokens', 'openai_max_tokens', 'openai_max_context',
        'reasoning_effort', 'stream', 'stream_openai', 'seed', 'n']) delete connection.settings[key];
    const merged = await host.frozen.buildSettingsWithCurrentModelConnectionSnapshot(baseSettings, connection);
    return { settings: applyGenerationSettings(merged, generation), model, connection };
}
function messageText(message) {
    if (typeof message.content === 'string') return message.content;
    return (message.parts ?? message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}
export function snapshotText(snapshot) { return (snapshot?.messages ?? []).map(messageText).join('\n'); }
export function toProviderMessages(snapshot) {
    return (snapshot?.messages ?? []).map(message => ({ role: message.role, content: messageText(message), ...(message.name ? { name: message.name } : {}) }));
}

export const WORKBENCH_OUTPUT_PATH = 'output/mnemosyne-workbench.md';
const toolStates = new WeakMap();
function stateFor(agent) {
    let state = toolStates.get(agent);
    if (!state) { state = { tools: new Map(), runs: new Map(), starting: new Set(), profiles: new Map() }; toolStates.set(agent, state); }
    return state;
}
function nameHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
}
export async function prepareNativeProfile(agent, tools, duties) {
    if (!agent?.startRunWithPromptSnapshot || !agent?.subscribe || !agent?.tools?.register || !agent?.profiles?.save) {
        throw new WorkbenchCapabilityError('当前 TT 没有完整后台 Agent 工具调用接口。');
    }
    const state = stateFor(agent);
    for (const tool of tools) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name)) throw new Error('工作台工具名格式错误。');
        const definition = { extensionId: 'mnemosyne-notes', name: tool.name, description: tool.description,
            inputSchema: tool.parameters, contexts: ['chat'], enabled: true };
        const signature = JSON.stringify(definition), known = state.tools.get(tool.name);
        if (known && known.signature !== signature) throw new Error('工作台工具定义已变化，请刷新 TT 后重试。');
        if (!known) {
            const registration = Promise.resolve(agent.tools.register(definition, async (args, execution) => {
                if (!state.runs.has(execution.runId) && state.starting.size) await Promise.allSettled([...state.starting]);
                const handler = state.runs.get(execution.runId);
                if (!handler) throw new Error('此工具调用不属于仍在运行的记事簿任务。');
                if (execution.signal?.aborted) throw new DOMException('已停止', 'AbortError');
                return handler(tool.name, args, execution);
            }));
            state.tools.set(tool.name, { signature, registration });
            registration.catch(() => state.tools.delete(tool.name));
        }
        await state.tools.get(tool.name).registration;
    }
    const signature = JSON.stringify(tools.map(tool => tool.name).sort());
    if (!state.profiles.has(signature)) {
        const prepare = (async () => {
            const { profile: original } = await agent.profiles.load('default-writer');
            if (!original) throw new WorkbenchCapabilityError('TT 默认 Agent Profile 不可用。');
            const profile = structuredClone(original);
            profile.id = 'mnemosyne-notes-workbench-' + nameHash(signature);
            profile.displayName = '记事簿工作台'; profile.description = '记事簿后台编辑草案；不写入正文。';
            profile.preset = { mode: 'currentPromptSnapshot', required: false };
            profile.model = { mode: 'currentPromptSnapshot' };
            profile.run = { ...profile.run, presentation: 'background', stream: true, directRunnable: true };
            profile.context = { initialChatHistoryMessages: -1, includeActivatedWorldInfo: true };
            profile.instructions = { agentSystemPrompt: duties };
            profile.delegation = { ...profile.delegation, canDelegate: false, canHandoff: false, callable: false, allowAsSubagent: false, allowAsHandoffTarget: false };
            profile.tools = { ...profile.tools, allow: [...tools.map(tool => 'extension/mnemosyne-notes:' + tool.name),
                'builtin:workspace.write_file', 'builtin:workspace.finish'],
                deny: ['builtin:workspace.commit'], toolDescriptions: {} };
            profile.skills = { visible: [], deny: ['*'] };
            profile.workspace = { visibleRoots: ['output'], writableRoots: ['output'] };
            profile.output = { artifacts: [{ id: 'main', path: WORKBENCH_OUTPUT_PATH, kind: 'markdown', target: 'messageBody', required: true, assemblyOrder: 0 }] };
            await agent.profiles.save(profile);
            return profile.id;
        })();
        state.profiles.set(signature, prepare);
        prepare.catch(() => state.profiles.delete(signature));
    }
    return state.profiles.get(signature);
}
export async function startNativeRun(agent, input, onTool) {
    const state = stateFor(agent);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    state.starting.add(pending);
    try {
        const handle = await agent.startRunWithPromptSnapshot(input);
        if (!handle?.runId) throw new Error('TT 未返回工作台任务编号。');
        state.runs.set(handle.runId, onTool);
        return handle;
    } finally { state.starting.delete(pending); release(); }
}
export function releaseNativeRun(agent, runId) { stateFor(agent).runs.delete(runId); }
