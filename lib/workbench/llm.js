import { assembleWorkbenchPrompt, runtimeCapture } from './context.js';
import { getTTRuntime, prepareNativeProfile, startNativeRun, releaseNativeRun, toProviderMessages, WORKBENCH_OUTPUT_PATH } from './tt.js';
import { describeRunEvent, watchInactivity } from './progress.js';

const NATIVE_INSTRUCTIONS = [
    '你在独立记事簿工作台中工作，正文聊天可以同时继续。',
    '修改工具只提交待审核草案；不要等人类在工具回调内审核。',
    '需要修改时调用已提供的记事簿工具。不要直接写入世界书、用户或角色设定。',
    '完成本次回复后，用 workspace.write_file 将本次给用户的完整说明写入 ' + WORKBENCH_OUTPUT_PATH + '，然后调用 workspace.finish。只写这个输出文件，不调用 workspace.commit。',
].join('\n');

function aborted(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('已停止', 'AbortError');
}
function fail(message, code, partial) {
    const error = new Error(message); error.code = code;
    if (partial !== undefined) error.partial = partial;
    return error;
}
function safeResult(value) { return JSON.stringify(value === undefined ? null : value); }

function combineToolSignals(...values) {
    const signals = [...new Set(values.filter(Boolean))];
    const noop = () => {};
    if (!signals.length) return { signal: undefined, dispose: noop };
    if (signals.length === 1) return { signal: signals[0], dispose: noop };
    if (typeof globalThis.AbortSignal?.any === 'function') {
        return { signal: globalThis.AbortSignal.any(signals), dispose: noop };
    }
    // Older WebViews have AbortController but no AbortSignal.any. Remove both
    // listeners on abort or completion, including when the tool callback rejects.
    const controller = new AbortController();
    const listeners = [];
    const dispose = () => {
        for (const [signal, listener] of listeners.splice(0)) signal.removeEventListener('abort', listener);
    };
    const forward = signal => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
        dispose();
    };
    for (const signal of signals) {
        if (signal.aborted) { forward(signal); break; }
        const listener = () => forward(signal);
        listeners.push([signal, listener]);
        signal.addEventListener('abort', listener, { once: true });
    }
    return { signal: controller.signal, dispose };
}

/** A run consumes one frozen story/material selection. UI chat switching is safe:
 * no live context is read here and no global generation/preset settings are edited. */
export async function runWorkbench(capture, options = {}) {
    const { signal, messages = [], tools = [], onText, onTool, onRunStart, onCancel } = options;
    aborted(signal);
    const saved = runtimeCapture(capture);
    const assembled = await assembleWorkbenchPrompt(capture, messages, capture.sourceId === 'main' ? NATIVE_INSTRUCTIONS : '');
    aborted(signal);
    if (capture.sourceId === 'main') return runNative(capture, saved, assembled, { signal, tools, onText, onTool, onRunStart, onCancel });
    const request = options.requestChannel ?? (await import('./providers.js')).requestChannel;
    return runProvider(capture, saved, assembled, { signal, tools, onText, onTool, request });
}

async function runProvider(capture, saved, assembled, { signal, tools, onText, onTool, request }) {
    const messages = toProviderMessages(assembled.promptSnapshot);
    const channel = { ...saved.channel, ...capture.generationSettings };
    const allow = new Set(tools.map(tool => tool.name));
    const completed = new Map();
    let usage = null, result;
    for (let round = 0; round < 12; round++) {
        aborted(signal);
        result = await request(channel, messages, { tools, signal, onText, round: round + 1 });
        aborted(signal);
        usage = result.usage ?? usage;
        if (!result.toolCalls?.length) {
            if (['length', 'max_tokens', 'content_filter'].includes(result.finishReason)) throw fail('本次输出未完整结束；已提交的草案仍可查看，请缩短下一批。', 'incomplete_response', result);
            return { text: result.text ?? '', usage, finishReason: result.finishReason ?? 'stop' };
        }
        // Only complete, parsed tool calls reach this boundary. Providers reject
        // truncated JSON; never guess or automatically replay a partial mutation.
        messages.push({ role: 'assistant', content: result.text ?? '', tool_calls: result.toolCalls.map(call => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: safeResult(call.arguments) },
        })) });
        for (const call of result.toolCalls) {
            aborted(signal);
            if (!call.id || !allow.has(call.name) || !onTool) throw fail('模型返回了未授权的工作台工具。', 'invalid_tool_call', result);
            const signature = call.name + ':' + safeResult(call.arguments);
            const previous = completed.get(call.id);
            if (previous && previous.signature !== signature) throw fail('模型重复使用工具调用编号且更改参数；已停止本批。', 'tool_call_id_collision', result);
            let value = previous?.value;
            if (!previous) {
                try { value = await onTool(call.name, call.arguments, { callId: call.id, signal, scope: capture.scope }); }
                catch (error) {
                    if (signal?.aborted || error.name === 'AbortError') throw error;
                    value = { ok: false, error: error.message };
                }
                completed.set(call.id, { signature, value });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: safeResult(value) });
        }
    }
    throw fail('本批工具往返超过 12 次，已停止。请查看已保存草案后缩小任务。', 'tool_round_limit', result);
}

async function runNative(capture, saved, assembled, { signal, tools, onText, onTool, onRunStart, onCancel }) {
    const agent = saved.runtime.api.agent;
    const profileId = await prepareNativeProfile(agent, tools, saved.duties + '\n' + NATIVE_INSTRUCTIONS);
    aborted(signal);
    const completed = new Map();
    const local = new AbortController();
    let watchdog;
    const handle = await startNativeRun(agent, {
        chatRef: capture.chatRef, stableChatId: capture.stableChatId, generationType: 'normal', profileId,
        promptSnapshot: assembled.promptSnapshot,
        frozenRunInputSnapshot: assembled.frozenRunInputSnapshot ?? saved.frozen,
        generationIntent: assembled.generationIntent, presentation: 'background',
        options: { stream: capture.generationSettings.stream, startWithEmptyPersist: true },
    }, async (name, args, execution) => {
        aborted(signal); aborted(execution.signal);
        if (!onTool) throw new Error('没有可用的记事簿工具处理器。');
        const signature = name + ':' + safeResult(args);
        const prior = completed.get(execution.callId);
        if (prior) {
            if (prior.signature !== signature) throw new Error('工具调用编号冲突。');
            return prior.promise;
        }
        // A native cancellation receipt may precede the native tool signal.
        // Forward the local stop immediately so an in-flight preparation cannot
        // submit stale drafts after the same workbench job has been retried.
        const combined = combineToolSignals(signal, local.signal, execution.signal);
        watchdog?.progress('执行工作台工具 ' + name);
        const promise = Promise.resolve().then(() => {
            aborted(combined.signal);
            return onTool(name, args, { ...execution, signal: combined.signal, scope: capture.scope });
        }).then(value => { watchdog?.progress('工作台工具 ' + name + ' 已返回'); return value; }).finally(combined.dispose);
        completed.set(execution.callId, { signature, promise });
        return promise;
    });
    try { await onRunStart?.({ runId: handle.runId, stableChatId: capture.stableChatId, sourceId: 'main' }); }
    catch (error) {
        local.abort(); releaseNativeRun(agent, handle.runId);
        try { await agent.cancel(handle.runId); } catch (cancelError) { error.cancelError = cancelError; }
        error.runId = handle.runId; throw error;
    }
    let stopEvents = () => {}, stopLive = () => {}, flushTimer;
    let settled = false, finalizing = false, preview = '', shown = '';
    const responses = new Map();
    let latestResponse = '';
    const flush = () => {
        flushTimer = undefined;
        if (!onText || settled || preview === shown) return;
        const delta = preview.startsWith(shown) ? preview.slice(shown.length) : '';
        shown = preview; try { onText(delta, preview); } catch { /* A view callback must not strand the run. */ }
    };
    const schedulePreview = () => { if (!flushTimer) flushTimer = setTimeout(flush, 60); };
    const cleanup = () => {
        local.abort(); stopEvents(); stopLive(); watchdog?.stop(); clearTimeout(flushTimer);
        signal?.removeEventListener('abort', onAbort); releaseNativeRun(agent, handle.runId);
    };
    let rejectRun;
    const stop = error => {
        if (settled) return;
        settled = true;
        // Cancellation is per run and never invokes the main-chat stop button.
        error.runId = handle.runId;
        error.cancellation = 'requested';
        Promise.resolve().then(() => agent.cancel(handle.runId)).then(
            receipt => { try { onCancel?.({ runId: handle.runId, receipt }); } catch {} },
            cancellationError => { error.cancelError = cancellationError; try { onCancel?.({ runId: handle.runId, error: cancellationError }); } catch {} },
        );
        cleanup(); rejectRun(error);
    };
    const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : new DOMException('已停止', 'AbortError'));
    return new Promise((resolve, reject) => {
        rejectRun = reject;
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        const seconds = capture.generationSettings.timeoutSec;
        watchdog = watchInactivity(seconds, '等待 TT 首条运行记录', stage =>
            stop(fail(`正文主 API 连续 ${seconds} 秒未见进展。最后阶段：${stage}。`, 'timeout', { text: preview })));
        try {
            stopEvents = agent.subscribe(handle.runId, event => {
                if (settled || finalizing) return;
                const stage = describeRunEvent(event);
                if (stage) watchdog.progress(stage);
                if (!['run_completed', 'run_partial_success', 'run_failed', 'run_cancelled'].includes(event.type)) return;
                finalizing = true;
                if (event.type !== 'run_completed') {
                    const cancelled = event.type === 'run_cancelled';
                    const error = cancelled ? new DOMException('已停止', 'AbortError')
                        : fail(event.payload?.message || 'TT 工作台任务未完整完成；已提交草案仍可查看。', event.type, { text: preview });
                    settled = true; cleanup(); reject(error); return;
                }
                watchdog.progress('读取已完成的工作台回复文件');
                Promise.resolve().then(() => agent.readWorkspaceFile({ runId: handle.runId, path: WORKBENCH_OUTPUT_PATH }))
                    .then(file => {
                        if (settled) return;
                        if (typeof file?.text !== 'string' || !file.text.trim()) throw fail('TT 已结束运行，但没有完整工作台回复文件。', 'missing_output');
                        settled = true; cleanup();
                        if (onText) { try { onText(file.text.startsWith(shown) ? file.text.slice(shown.length) : '', file.text); } catch { /* The completed file remains authoritative. */ } }
                        resolve({ text: file.text, usage: event.payload?.usage ?? null, finishReason: 'stop', runId: handle.runId });
                    }).catch(error => { if (!settled) { settled = true; cleanup(); reject(error); } });
            }, { afterSeq: 0, intervalMs: 750, limit: 100, onError: error => stop(error) });
            if (settled) stopEvents();
            if (!settled && capture.generationSettings.stream && typeof agent.subscribeLiveProjection === 'function') {
                stopLive = agent.subscribeLiveProjection(handle.runId, update => {
                    if (settled || finalizing) return;
                    const active = update.type === 'responseAppend' ? update
                        : update.type === 'responseReplace' ? update.response : null;
                    if (active?.text) watchdog.progress('已收到模型正文');
                    else if (active?.reasoning) watchdog.progress('已收到模型推理');
                    else if (active?.toolIds?.length || (update.type === 'append' && update.text) || (update.type === 'replace' && update.call))
                        watchdog.progress('已收到模型工具调用');
                    if (update.type === 'snapshot') {
                        responses.clear();
                        for (const response of update.responses ?? []) { responses.set(response.invocationId, response.text ?? ''); latestResponse = response.invocationId; }
                        if (update.calls?.length || update.responses?.some(r => r.text || r.reasoning || r.toolIds?.length)) watchdog.progress('已收到 TT 输出快照');
                    } else if (update.type === 'responseReplace') {
                        const response = update.response;
                        if (response) { responses.set(response.invocationId, response.text ?? ''); latestResponse = response.invocationId; }
                    } else if (update.type === 'responseAppend') {
                        latestResponse = update.invocationId;
                        responses.set(latestResponse, (responses.get(latestResponse) ?? '') + (update.text ?? ''));
                    } else if (update.type === 'responseRemove') responses.delete(update.invocationId);
                    preview = responses.get(latestResponse) ?? preview;
                    if (preview !== shown) schedulePreview();
                }, { onError: () => { /* Journal remains authoritative; losing preview is not a failed edit. */ } });
            }
        } catch (error) { stop(error); }
    });
}

// One user-initiated tail read, including runs saved by older notebook versions.
export async function readWorkbenchRunLog(runId, runtime) {
    const agent = (runtime ?? await getTTRuntime()).api.agent;
    if (typeof agent?.readEvents !== 'function') throw new Error('此 TT 版本未提供运行记录读取接口。');
    const page = await agent.readEvents({runId, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 40});
    return (page?.events ?? []).flatMap(event => {
        const stage = describeRunEvent(event);
        return stage ? ['#' + event.seq + '　' + stage] : [];
    });
}

/** Request cancellation of a saved native run after a workbench/page reload.
 * The returned receipt is an acknowledgement, not a claimed terminal state. */
export async function cancelWorkbenchRun(runId, runtime) {
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('工作台任务编号无效。');
    const host = runtime ?? await getTTRuntime();
    if (typeof host.api.agent?.cancel !== 'function') throw new Error('当前 TT 不支持按任务取消。');
    return host.api.agent.cancel(runId.trim());
}
