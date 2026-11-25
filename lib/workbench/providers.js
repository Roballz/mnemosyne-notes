import { context } from '../host.js';
import { DEFAULT_TIMEOUT_SECONDS, watchInactivity } from './progress.js';

// Notebook-owned OpenAI Chat Completions channels. TT is a transport only;
// no global connection, preset, sampler or abort state is changed.
const GENERATE_URL = '/api/backends/chat-completions/generate';
const MODELS_URL = '/api/backends/chat-completions/status';
const MAX_RESPONSE = 16 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class WorkbenchProviderError extends Error {
    constructor(code, message, partial) {
        super(message);
        this.name = 'WorkbenchProviderError';
        this.code = code;
        // For recovery/review only. Interrupted responses are never successful tool turns.
        if (partial) this.partial = partial;
    }
}

function invalid(message) { throw new WorkbenchProviderError('INVALID_CHANNEL', message); }

function channelHeaders(channel) {
    if (!object(channel)) invalid('尚未选择工作台 API。');
    if (channel.protocol && channel.protocol !== 'openai' && channel.protocol !== 'openai-compatible') {
        invalid('独立 API 目前支持 OpenAI Chat Completions 兼容格式。');
    }
    if (channel.key !== undefined && (typeof channel.key !== 'string' || /[\r\n]/.test(channel.key))) invalid('API 密钥含无效字符。');
    const headers = { Authorization: `Bearer ${channel.key ?? ''}` };
    if (channel.extraHeaders !== undefined && !object(channel.extraHeaders)) invalid('额外请求头须为 JSON 对象。');
    for (const [name, value] of Object.entries(channel.extraHeaders ?? {})) {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /^(host|cookie|content-length|connection|transfer-encoding)$/i.test(name)
            || typeof value !== 'string' || /[\r\n]/.test(value)) invalid('额外请求头含无效名称或值。');
        headers[/^authorization$/i.test(name) ? 'Authorization' : name] = value;
    }
    return headers;
}

function apiUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { invalid('请填写完整的 API 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        invalid('API 地址须为 HTTP(S) 基础地址；密钥请放在密钥或额外请求头中。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') || '/v1';
    return url.href.replace(/\/+$/, '');
}

function toolsPayload(tools) {
    if (!Array.isArray(tools)) invalid('工具列表格式无效。');
    return tools.map(tool => {
        const value = tool?.type === 'function' ? tool.function : tool;
        if (!object(value) || typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name)
            || !object(value.parameters)) invalid('工具定义缺少有效名称或参数结构。');
        return { type: 'function', function: {
            name: value.name, description: typeof value.description === 'string' ? value.description : '',
            parameters: value.parameters,
        } };
    });
}

function channelPayload(channel, messages, tools) {
    const headers = channelHeaders(channel);
    if (typeof channel.model !== 'string' || !channel.model.trim()) invalid('请填写工作台 API 的模型名称。');
    if (!Array.isArray(messages) || !messages.length) invalid('本次请求没有可发送的上下文。');
    const temperature = Number(channel.temperature ?? 1);
    const maxTokens = Number(channel.maxTokens ?? 8192);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) invalid('温度须在 0–2 之间。');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) invalid('最大输出 token 数须为正整数。');
    const nativeTools = toolsPayload(tools);
    const payload = {
        model: channel.model.trim(), messages, temperature, max_tokens: maxTokens,
        stream: channel.stream === true, presence_penalty: 0, frequency_penalty: 0,
        ...(nativeTools.length ? { tools: nativeTools, tool_choice: 'auto' } : {}),
    };
    const effort = String(channel.reasoningEffort ?? '').trim();
    if (effort && effort !== 'auto') payload.reasoning_effort = effort;
    return {
        chat_completion_source: 'custom', custom_url: apiUrl(channel.url),
        // JSON is valid YAML for TT's custom include parser. Even an empty key
        // explicitly replaces the global custom secret; never fall back to it.
        custom_include_headers: JSON.stringify(headers),
        custom_include_body: JSON.stringify(payload),
        // Declare ownership to host interceptors, but without tools omit the
        // field upstream for compatible endpoints that reject tool_choice alone.
        tool_choice: nativeTools.length ? 'auto' : 'none',
        ...payload,
    };
}

function safeDetail(value, channel) {
    let text = typeof value === 'string' ? value : '';
    for (const secret of [channel.key, ...Object.values(channel.extraHeaders ?? {})]) {
        if (typeof secret === 'string' && secret) text = text.split(secret).join('[已隐藏]');
    }
    return text.replace(/(?:Bearer\s+)[^\s"'<>]+/gi, 'Bearer [已隐藏]')
        .replace(/([?&](?:key|token|api_key)=)[^&\s"'<>]+/gi, '$1[已隐藏]').slice(0, 450);
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
}

function reasoningText(message) {
    for (const value of [message.reasoning_content, message.reasoning]) {
        if (typeof value === 'string' && value) return value;
    }
    return Array.isArray(message.reasoning_details)
        ? message.reasoning_details.map(part => typeof part?.text === 'string' ? part.text : typeof part?.summary === 'string' ? part.summary : '').join('') : '';
}

function notify(callback, ...args) { try { callback?.(...args); } catch { /* Rendering cannot cancel transport. */ } }

function numericUsage(value) {
    if (!object(value)) return undefined;
    const result = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
        'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_tokens_details', 'completion_tokens_details']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
        else if (object(value[key])) {
            result[key] = Object.fromEntries(Object.entries(value[key]).filter(([, n]) => typeof n === 'number' && Number.isFinite(n)));
        }
    }
    return result;
}

function stateResult(state, completeOnly = false) {
    const toolCalls = [];
    const ids = new Set();
    for (const call of [...state.calls.values()].sort((a, b) => a.index - b.index)) {
        try {
            const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
            if (!call.id || !call.name || !object(args) || ids.has(call.id)) throw Error('invalid');
            ids.add(call.id);
            toolCalls.push({ id: call.id, name: call.name, arguments: args });
        } catch {
            if (!completeOnly) throw new WorkbenchProviderError('INVALID_TOOL_CALL', '工具调用参数不完整或格式无效；本批次未提交。');
        }
    }
    return { text: state.text, ...(state.reasoning ? { reasoning: state.reasoning } : {}), toolCalls, usage: state.usage, finishReason: state.finishReason };
}

function fragment(previous, next) {
    if (typeof next !== 'string' || !next) return previous;
    return previous === next ? previous : previous + next;
}

function consume(value, state, channel, onText, onReasoning, streaming) {
    if (!object(value)) throw new WorkbenchProviderError('INVALID_RESPONSE', 'API 返回了无法识别的响应格式。');
    if (value.error) {
        const detail = safeDetail(typeof value.error === 'string' ? value.error : value.error?.message || value.message, channel);
        throw new WorkbenchProviderError('UPSTREAM_ERROR', `API 返回错误${detail ? `：${detail}` : '。'}`);
    }
    if (value.usage) state.usage = { ...state.usage, ...numericUsage(value.usage) };
    const choice = value.choices?.find?.(item => item.index === 0) ?? value.choices?.[0];
    if (!choice) {
        if (value.usage || (Array.isArray(value.choices) && value.choices.length === 0)) return;
        throw new WorkbenchProviderError('INVALID_RESPONSE', 'API 未返回 Chat Completions 结果。');
    }
    const message = streaming ? (choice.delta ?? choice.message ?? {}) : (choice.message ?? {});
    if (message.refusal) throw new WorkbenchProviderError('REFUSAL', '模型拒绝了本次请求；本批次未提交。');
    const delta = contentText(message.content);
    const reasoning = reasoningText(message);
    let progress = delta ? '已收到模型正文' : reasoning ? '已收到模型推理' : '';
    if (delta) {
        state.text += delta;
        notify(onText, delta, state.text);
    }
    if (reasoning) { state.reasoning += reasoning; notify(onReasoning, reasoning, state.reasoning); }
    if (message.function_call) throw new WorkbenchProviderError('UNSUPPORTED_TOOLS', '此通道返回了旧版 function_call，请使用支持 tool_calls 的兼容端点。');
    for (const [position, item] of (message.tool_calls ?? []).entries()) {
        if (!object(item) || (item.type && item.type !== 'function')) throw new WorkbenchProviderError('INVALID_TOOL_CALL', 'API 返回了不支持的工具调用。');
        const existing = typeof item.id === 'string' ? [...state.calls.values()].find(call => call.id === item.id) : null;
        const index = item.index ?? existing?.index ?? position;
        if (!Number.isSafeInteger(index) || index < 0 || index > 255) throw new WorkbenchProviderError('INVALID_TOOL_CALL', '工具调用序号无效。');
        const call = state.calls.get(index) ?? { index, id: '', name: '', arguments: '' };
        call.id = fragment(call.id, item.id);
        call.name = fragment(call.name, item.function?.name);
        const args = item.function?.arguments;
        if (item.id || item.function?.name || args) progress = '已收到工具调用分片';
        if (typeof args === 'string') {
            if (typeof call.arguments !== 'string') throw new WorkbenchProviderError('INVALID_TOOL_CALL', '工具参数分片格式不一致。');
            call.arguments += args;
        } else if (args !== undefined) {
            if (streaming || !object(args) || call.arguments) throw new WorkbenchProviderError('INVALID_TOOL_CALL', '工具参数格式无效。');
            call.arguments = args;
        }
        state.calls.set(index, call);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) state.finishReason = choice.finish_reason;
    return progress || (choice.finish_reason ? '模型已返回结束标记' : '');
}

function completed(state) {
    if (state.finishReason === 'length') throw new WorkbenchProviderError('TRUNCATED', '输出达到长度上限；本批次未提交，请缩小批次后重试。');
    if (state.finishReason === 'content_filter') throw new WorkbenchProviderError('FILTERED', 'API 中止了本批次；没有自动提交修改。');
    if (!['stop', 'tool_calls'].includes(state.finishReason)) throw new WorkbenchProviderError('TRUNCATED', '响应在完整结束标记前中断；本批次未提交。');
    if (state.finishReason === 'tool_calls' && !state.calls.size) throw new WorkbenchProviderError('INVALID_TOOL_CALL', '响应声明工具调用结束，却未返回工具参数。');
    return stateResult(state);
}

/**
 * Independent OpenAI-compatible request through TT's same-origin backend.
 * onText(delta, accumulated) is incremental; toolCalls.arguments are objects.
 * Only a resolved result is an executable/reviewable tool turn.
 * Interrupted streams, malformed arguments and HTTP errors never auto-retry.
 */
export async function requestChannel(channel, messages, { tools = [], signal, onText, onReasoning, onStatus, round = 1 } = {}) {
    const body = JSON.stringify(channelPayload(channel, messages, tools));
    const ctx = context();
    if (typeof ctx?.getRequestHeaders !== 'function') throw new WorkbenchProviderError('HOST_UNAVAILABLE', '酒馆请求接口尚未就绪。');
    const seconds = Number(channel.timeoutSec ?? DEFAULT_TIMEOUT_SECONDS);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) invalid('超时须为 0–3600 秒之间的正数。');
    const controller = new AbortController();
    const state = { text: '', reasoning: '', calls: new Map(), usage: undefined, finishReason: null };
    let timeoutStage, reader, bytes = 0;
    const abortError = () => new WorkbenchProviderError(timeoutStage ? 'TIMEOUT' : 'ABORTED', timeoutStage
        ? `独立 API 第${round}轮连续 ${seconds} 秒未见进展。最后阶段：${timeoutStage}。` : '工作台请求已停止；本批次未提交。');
    const externalAbort = () => controller.abort();
    const watchdog = watchInactivity(seconds, '等待响应头', stage => { timeoutStage = stage; controller.abort(); });
    let lastStatus;
    const progress = stage => {
        watchdog.progress(stage);
        if (lastStatus !== stage) { lastStatus = stage; notify(onStatus, `第${round}轮 · ${stage}`); }
    };
    progress('等待响应头');
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const guard = async promise => {
        if (controller.signal.aborted) throw abortError();
        let abort;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                abort = () => reject(abortError());
                controller.signal.addEventListener('abort', abort, { once: true });
            })]);
        } finally { if (abort) controller.signal.removeEventListener('abort', abort); }
    };
    try {
        if (controller.signal.aborted) throw abortError();
        const response = await guard(fetch(GENERATE_URL, {
            method: 'POST', headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' }, body,
            signal: controller.signal,
        }));
        if (!response.ok) {
            let detail = '';
            try {
                const raw = await guard(response.text());
                if (raw.length < 65536) {
                    const data = JSON.parse(raw);
                    detail = safeDetail(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : ''), channel);
                }
            } catch (error) { if (controller.signal.aborted) throw error; }
            throw new WorkbenchProviderError('HTTP_ERROR', `API 请求失败（HTTP ${response.status}）${detail ? '：' + detail : '；本批次未提交。'}`);
        }
        const streamed = /text\/event-stream/i.test(response.headers?.get?.('content-type') || '');
        progress(streamed ? '已收到响应头，等待模型流式输出' : '已收到响应头，等待完整 JSON');
        if (!streamed) {
            const raw = await guard(response.text());
            if (raw.length > MAX_RESPONSE) throw new WorkbenchProviderError('RESPONSE_TOO_LARGE', 'API 响应过大，请缩小批次。');
            let data;
            try { data = JSON.parse(raw); } catch { throw new WorkbenchProviderError('INVALID_RESPONSE', 'API 未返回完整 JSON；本批次未提交。'); }
            const stage = consume(data, state, channel, onText, onReasoning, false);
            if (stage) progress(stage);
        } else {
            reader = response.body?.getReader?.();
            if (!reader) throw new WorkbenchProviderError('INVALID_RESPONSE', '当前宿主没有提供可读取的响应流。');
            const decoder = new TextDecoder();
            let buffer = '', data = [], event = '', done = false;
            const dispatch = () => {
                if (!data.length) { event = ''; return; }
                const raw = data.join('\n');
                data = [];
                if (raw.trim() === '[DONE]') { done = true; event = ''; return; }
                let value;
                try { value = JSON.parse(raw); } catch { throw new WorkbenchProviderError('INVALID_RESPONSE', '响应流含不完整 JSON；本批次未提交。'); }
                if (event === 'error' && !value.error) value = { error: value.message || '响应流中止' };
                event = '';
                const stage = consume(value, state, channel, onText, onReasoning, true);
                if (stage) progress(stage);
            };
            const line = value => {
                if (value.endsWith('\r')) value = value.slice(0, -1);
                if (!value) { dispatch(); return; }
                if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
                else if (value.startsWith('event:')) event = value.slice(6).trim();
            };
            while (!done) {
                const part = await guard(reader.read());
                if (part.done) {
                    buffer += decoder.decode();
                    if (buffer) line(buffer);
                    dispatch();
                    break;
                }
                bytes += part.value.byteLength;
                if (bytes > MAX_RESPONSE) throw new WorkbenchProviderError('RESPONSE_TOO_LARGE', 'API 响应过大，请缩小批次。');
                buffer += decoder.decode(part.value, { stream: true });
                let end;
                while (!done && (end = buffer.indexOf('\n')) >= 0) {
                    const current = buffer.slice(0, end);
                    buffer = buffer.slice(end + 1);
                    line(current);
                }
            }
        }
        if (controller.signal.aborted) throw abortError();
        return completed(state);
    } catch (error) {
        const failure = controller.signal.aborted ? abortError() : error instanceof WorkbenchProviderError ? error
            : new WorkbenchProviderError('NETWORK_ERROR', '工作台请求中断；请检查连接，本批次未提交。');
        failure.partial = stateResult(state, true);
        throw failure;
    } finally {
        watchdog.stop();
        signal?.removeEventListener('abort', externalAbort);
        if (reader) {
            // Do not wait on an uncooperative reader after cancellation.
            try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* native reader already closed */ }
            try { reader.releaseLock(); } catch { /* pending native read owns the lock until cancellation */ }
        }
    }
}

/** Model discovery uses the same explicit channel credentials as generation.
 * It does not switch TT's main connection, save settings or send any material. */
export async function listChannelModels(channel, { signal } = {}) {
    const headers = channelHeaders(channel), ctx = context();
    if (typeof ctx?.getRequestHeaders !== 'function') throw new WorkbenchProviderError('HOST_UNAVAILABLE', '酒馆请求接口尚未就绪。');
    const body = JSON.stringify({ chat_completion_source: 'custom', custom_api_format: 'openai_compat',
        custom_url: apiUrl(channel.url), custom_include_headers: JSON.stringify(headers), bypass_status_check: false });
    const controller = new AbortController();
    let timedOut = false, rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
        controller.abort();
        rejectAbort(new WorkbenchProviderError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? '拉取模型超时，请检查地址和连接。' : '已取消拉取模型。'));
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, 30000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
        if (signal?.aborted) abort();
        const response = await Promise.race([cancelled, Promise.resolve().then(() => {
            if (controller.signal.aborted) return cancelled;
            return fetch(MODELS_URL, { method: 'POST', headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' }, body, signal: controller.signal, cache: 'no-store' });
        })]);
        const raw = await Promise.race([cancelled, response.text()]);
        if (raw.length > 4 * 1024 * 1024) throw new WorkbenchProviderError('RESPONSE_TOO_LARGE', '模型列表过大，请手动输入模型标识。');
        let data;
        try { data = JSON.parse(raw); } catch { throw new WorkbenchProviderError('INVALID_RESPONSE', '模型接口没有返回有效 JSON；仍可手动输入模型标识。'); }
        if (!response.ok || data.error) {
            const detail = safeDetail(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : ''), channel);
            throw new WorkbenchProviderError('MODEL_LIST_FAILED', `拉取模型失败${!response.ok ? `（HTTP ${response.status}）` : ''}${detail ? '：' + detail : '；该服务可能不支持模型列表，可手动输入模型标识。'}`);
        }
        if (data.cancelled) throw new WorkbenchProviderError('ABORTED', '已取消拉取模型。');
        const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        const ids = [...new Set(items.map(item => typeof item === 'string' ? item : item?.id || item?.name)
            .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
        if (!ids.length) throw new WorkbenchProviderError('EMPTY_MODEL_LIST', '服务没有返回可用模型；可以手动输入模型标识后测试。');
        return ids.sort((a, b) => a.localeCompare(b));
    } catch (error) {
        if (controller.signal.aborted) throw new WorkbenchProviderError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? '拉取模型超时，请检查地址和连接。' : '已取消拉取模型。');
        if (error instanceof WorkbenchProviderError) throw error;
        throw new WorkbenchProviderError('NETWORK_ERROR', '无法拉取模型，请检查 API 地址、密钥和连接。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function testChannel(channel, { signal } = {}) {
    // Keep the selected model's reasoning parameters: forcing an unsupported
    // "none" effort would make a healthy reasoning model fail its own test.
    const result = await requestChannel({ ...channel, maxTokens: Math.min(Number(channel.maxTokens) || 4096, 4096) },
        [{ role: 'user', content: '这是连接测试。请只回复 OK，不要解释。' }], { signal });
    if (!result.text?.trim()) throw new WorkbenchProviderError('EMPTY_RESPONSE', 'API 已响应，但没有返回正文。请检查模型或增加最大输出 token 后重试。');
    return { text: result.text, ...(result.reasoning ? { reasoning: result.reasoning } : {}), usage: result.usage };
}
