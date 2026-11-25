import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestChannel, listChannelModels, testChannel } from '../lib/workbench/providers.js';

const originalFetch = globalThis.fetch;
const originalHost = globalThis.SillyTavern;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.SillyTavern = originalHost; });
const channel = overrides => ({
    id: 'synthetic', name: '合成测试', url: 'https://synthetic.invalid/v1', key: 'synthetic-key',
    model: 'test-model', temperature: 0.4, maxTokens: 1024, contextSize: 8192, timeoutSec: 1, stream: false,
    ...overrides,
});
const tools = [{ name: 'edit_batch', description: '提出改动', parameters: { type: 'object', properties: { edits: { type: 'array' } } } }];
const messages = [{ role: 'user', content: '合成材料' }];
const full = (calls = [], finish = calls.length ? 'tool_calls' : 'stop') => ({
    choices: [{ index: 0, message: { content: '检查完成', tool_calls: calls }, finish_reason: finish }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
});
const call = (id, args, name = 'edit_batch') => ({ id, type: 'function', function: { name, arguments: args } });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function host() {
    const settings = { model: 'main-stays', temperature: 1.7, stream: false };
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf' }), settings }) };
    return settings;
}
function sse(events, widths = [1, 3, 7, 11]) {
    const bytes = new TextEncoder().encode(events.join(''));
    let offset = 0, index = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (offset === bytes.length) { controller.close(); return; }
            const end = Math.min(bytes.length, offset + widths[index++ % widths.length]);
            controller.enqueue(bytes.slice(offset, end)); offset = end;
        },
    }), { headers: { 'content-type': 'text/event-stream' } });
}
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });

test('独立通道显式发送插件参数、原生工具与自有凭据，不改主模型设置', async () => {
    const settings = host();
    let sent, headers, endpoint;
    globalThis.fetch = async (url, options) => {
        endpoint = url; sent = JSON.parse(options.body); headers = options.headers;
        return json(full([call('one', '{"edits":[{"id":"A"},{"id":"B"}]}')]));
    };
    const result = await requestChannel(channel({
        url: 'https://synthetic.invalid/v2/chat/completions/', key: 'synthetic: # key', reasoningEffort: 'high',
        extraHeaders: { 'X-Client': 'notebook' },
    }), messages, { tools });
    assert.equal(endpoint, '/api/backends/chat-completions/generate');
    assert.equal(sent.chat_completion_source, 'custom');
    assert.equal(sent.custom_url, 'https://synthetic.invalid/v2');
    assert.deepEqual(JSON.parse(sent.custom_include_headers), { Authorization: 'Bearer synthetic: # key', 'X-Client': 'notebook' });
    assert.equal(headers['X-CSRF-Token'], 'synthetic-csrf');
    assert.equal(sent.model, 'test-model'); assert.equal(sent.temperature, 0.4); assert.equal(sent.max_tokens, 1024);
    assert.equal(sent.tool_choice, 'auto'); assert.equal(sent.tools[0].function.name, 'edit_batch');
    assert.equal(JSON.parse(sent.custom_include_body).reasoning_effort, 'high');
    assert.deepEqual(result.toolCalls, [{ id: 'one', name: 'edit_batch', arguments: { edits: [{ id: 'A' }, { id: 'B' }] } }]);
    assert.deepEqual(settings, { model: 'main-stays', temperature: 1.7, stream: false });
});

test('空凭据显式清空宿主 Custom 密钥，基础域名规范为 v1', async () => {
    host(); let sent;
    globalThis.fetch = async (_, options) => { sent = JSON.parse(options.body); return json(full()); };
    await requestChannel(channel({ key: '', url: 'https://synthetic.invalid' }), messages);
    assert.equal(JSON.parse(sent.custom_include_headers).Authorization, 'Bearer ');
    assert.equal(sent.custom_url, 'https://synthetic.invalid/v1');
    assert.equal(sent.tool_choice, 'none');
    assert.equal('tools' in JSON.parse(sent.custom_include_body), false);
    assert.equal('tool_choice' in JSON.parse(sent.custom_include_body), false);
});

test('SSE 跨 UTF-8/行边界解析并行工具参数分片、正文与最终 usage', async () => {
    host(); const seen = [];
    globalThis.fetch = async () => sse([
        ': heartbeat\r\n\r\n',
        event(delta({ content: '准备归档。', tool_calls: [
            { index: 0, id: 'one', type: 'function', function: { name: 'edit_', arguments: '{"edits":[' } },
            { index: 1, id: 'two', type: 'function', function: { name: 'edit_batch', arguments: '{"edits":[' } },
        ] })),
        event(delta({ tool_calls: [{ index: 1, function: { arguments: '{"id":"乙"}]}' } }] })),
        event(delta({ tool_calls: [{ index: 0, function: { name: 'batch', arguments: '{"id":"甲"}]}' } }] })),
        event(delta({}, 'tool_calls')),
        event({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } }),
        'data: [DONE]\r\n\r\n',
    ]);
    const result = await requestChannel(channel({ stream: true }), messages, { tools, onText: (piece, all) => seen.push([piece, all]) });
    assert.deepEqual(seen, [['准备归档。', '准备归档。']]);
    assert.deepEqual(result.toolCalls, [
        { id: 'one', name: 'edit_batch', arguments: { edits: [{ id: '甲' }] } },
        { id: 'two', name: 'edit_batch', arguments: { edits: [{ id: '乙' }] } },
    ]);
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 20);
    assert.equal(result.finishReason, 'tool_calls');
});

test('断流即使先收到一个完整工具也拒绝整个响应；仅留完整调用供人工恢复', async () => {
    host();
    globalThis.fetch = async () => sse([
        event(delta({ tool_calls: [
            { index: 0, ...call('complete', '{"edits":[]}') },
            { index: 1, ...call('partial', '{"edits":[') },
        ] })),
    ]);
    await assert.rejects(requestChannel(channel({ stream: true }), messages, { tools }), error => {
        assert.equal(error.code, 'TRUNCATED');
        assert.deepEqual(error.partial.toolCalls.map(item => item.id), ['complete']);
        return true;
    });
});

test('结束标记不能把无效参数、重复调用 ID 或长度截断变为成功', async () => {
    host();
    const responses = [
        full([call('x', '{"edits":[')]),
        full([call('same', '{}'), call('same', '{}')]),
        full([call('x', '{}')], 'length'),
    ];
    globalThis.fetch = async () => json(responses.shift());
    for (const code of ['INVALID_TOOL_CALL', 'INVALID_TOOL_CALL', 'TRUNCATED']) {
        await assert.rejects(requestChannel(channel(), messages, { tools }), error => error.code === code);
    }
});

test('超时覆盖已返回响应头后的停滞读取，并主动取消 reader', async () => {
    host(); let cancelled = false, signal;
    globalThis.fetch = async (_, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    await assert.rejects(requestChannel(channel({ stream: true, timeoutSec: 0.025 }), messages), error => error.code === 'TIMEOUT' && /独立 API 第1轮.*等待模型流式输出/.test(error.message));
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test('SSE reasoning and tool arguments extend the idle timeout while heartbeats do not', async t => {
    host();
    t.mock.timers.enable({apis:['Date','setTimeout']});t.mock.method(performance,'now',()=>Date.now());
    let output;
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){output=c;}}),{headers:{'content-type':'text/event-stream'}});
    const pending=requestChannel(channel({stream:true,timeoutSec:600}),messages,{round:2});
    const rejected=assert.rejects(pending,e=>e.code==='TIMEOUT'&&/第2轮.*600 秒.*工具调用分片/.test(e.message));
    const write=async raw=>{output.enqueue(new TextEncoder().encode(raw));await new Promise(r=>setImmediate(r));};
    await new Promise(r=>setImmediate(r));
    t.mock.timers.tick(300_000);await write(event(delta({reasoning_content:'只参与计时'})));
    t.mock.timers.tick(500_000);await write(event(delta({tool_calls:[{index:0,id:'tool',function:{name:'edit',arguments:'{'}}]})));
    t.mock.timers.tick(599_999);await write(': ping\n\n');
    t.mock.timers.tick(1);await rejected;
});

test('停止工作台请求只取消自己的 signal，另一请求可完整结束', async () => {
    host(); const pending = [], signals = [];
    globalThis.fetch = async (_, options) => {
        signals.push(options.signal);
        return new Response(new ReadableStream({ start(controller) { pending.push(controller); } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const aborter = new AbortController();
    const first = requestChannel(channel({ stream: true }), messages, { signal: aborter.signal });
    const rejected = assert.rejects(first, error => error.code === 'ABORTED');
    const second = requestChannel(channel({ stream: true }), messages);
    await new Promise(resolve => setTimeout(resolve, 0));
    aborter.abort();
    pending[1].enqueue(new TextEncoder().encode(event(delta({ content: '独立完成' }, 'stop')) + 'data: [DONE]\n\n'));
    pending[1].close();
    await rejected; assert.equal((await second).text, '独立完成');
    assert.notEqual(signals[0], signals[1]); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
});

test('完整 JSON 读取也受超时约束，错误信息不泄漏凭据', async () => {
    host();
    globalThis.fetch = async () => ({ ok: true, headers: new Headers(), text: () => new Promise(() => {}) });
    await assert.rejects(requestChannel(channel({ timeoutSec: 0.02 }), messages), error => error.code === 'TIMEOUT');
    globalThis.fetch = async () => json({ error: { message: 'Invalid synthetic-key; X-Key=another-secret; Bearer synthetic-token' } });
    await assert.rejects(requestChannel(channel({ extraHeaders: { 'X-Key': 'another-secret' } }), messages), error => {
        assert.equal(error.code, 'UPSTREAM_ERROR');
        assert.doesNotMatch(error.message, /synthetic-key|another-secret|synthetic-token/);
        return true;
    });
});

test('不支持的协议、URL 内密钥与非法额外头在发出请求之前拒绝', async () => {
    host(); let calls = 0;
    globalThis.fetch = async () => { calls++; return json(full()); };
    for (const config of [
        { protocol: 'anthropic' }, { url: 'https://synthetic.invalid/v1?key=secret' },
        { extraHeaders: { Host: 'other.invalid' } }, { extraHeaders: { 'X-Test': 'a\r\nb' } },
    ]) await assert.rejects(requestChannel(channel(config), messages), error => error.code === 'INVALID_CHANNEL');
    assert.equal(calls, 0);
});

test('流式推理单独返回、状态去重，推理与正文回调异常不打断请求', async () => {
    host(); const reasoning = [], stages = [];
    globalThis.fetch = async () => sse([
        event(delta({ reasoning_content: '先核对' })),
        event(delta({ reasoning_content: '范围。' })),
        event(delta({ content: 'OK' }, 'stop')), 'data: [DONE]\n\n',
    ]);
    const result = await requestChannel(channel({ stream: true }), messages, {
        onReasoning: (piece, all) => { reasoning.push([piece, all]); throw Error('view closed'); },
        onText: () => { throw Error('view closed'); }, onStatus: value => stages.push(value),
    });
    assert.equal(result.text, 'OK'); assert.equal(result.reasoning, '先核对范围。');
    assert.deepEqual(reasoning, [['先核对', '先核对'], ['范围。', '先核对范围。']]);
    assert.equal(stages.filter(value => value.includes('模型推理')).length, 1);
});

test('模型刷新使用独立通道凭据、无需先填模型，返回去重列表且不改正文设置', async () => {
    const settings = host(); let sent;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        sent = JSON.parse(options.body);
        return json({ data: [{ id: 'beta' }, { id: 'alpha' }, { id: 'beta' }] });
    };
    assert.deepEqual(await listChannelModels(channel({ model: '', key: '', extraHeaders: { 'X-Route': 'route' } })), ['alpha', 'beta']);
    assert.deepEqual(JSON.parse(sent.custom_include_headers), { Authorization: 'Bearer ', 'X-Route': 'route' });
    assert.equal(sent.custom_url, 'https://synthetic.invalid/v1');
    assert.equal(Object.hasOwn(sent, 'messages'), false);
    assert.deepEqual(settings, { model: 'main-stays', temperature: 1.7, stream: false });
});

test('模型刷新可取消停滞读取，错误不回显 API 密钥', async () => {
    host(); const controller = new AbortController(); let signal;
    globalThis.fetch = async (_, options) => {
        signal = options.signal;
        return { ok: true, text: () => new Promise(() => {}) };
    };
    const pending = listChannelModels(channel(), { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.code === 'ABORTED');
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
    assert.equal(signal.aborted, true);
    globalThis.fetch = async () => json({ error: true, message: 'Invalid synthetic-key' });
    await assert.rejects(listChannelModels(channel()), error => error.code === 'MODEL_LIST_FAILED' && !error.message.includes('synthetic-key'));
});

test('连接测试只发送固定短句，实际返回正文后才算成功', async () => {
    host(); let sent;
    globalThis.fetch = async (_, options) => { sent = JSON.parse(options.body); return json(full()); };
    assert.equal((await testChannel(channel({ maxTokens: 20000 }))).text, '检查完成');
    assert.equal(sent.model, 'test-model'); assert.equal(sent.max_tokens, 4096);
    assert.deepEqual(sent.messages, [{ role: 'user', content: '这是连接测试。请只回复 OK，不要解释。' }]);
    assert.equal(Object.hasOwn(sent, 'tools'), false);
    globalThis.fetch = async () => json({ choices: [{ message: { content: '', reasoning_content: 'only reasoning' }, finish_reason: 'stop' }] });
    await assert.rejects(testChannel(channel()), error => error.code === 'EMPTY_RESPONSE');
});
