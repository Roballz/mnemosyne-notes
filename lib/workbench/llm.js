import { assembleWorkbenchPrompt, runtimeCapture } from './context.js';
import { getTTRuntime, prepareNativeProfile, startNativeRun, releaseNativeRun, toProviderMessages, WORKBENCH_OUTPUT_PATH } from './tt.js';
import { describeRunEvent, describeRunFailure, watchInactivity } from './progress.js';

const NATIVE_INSTRUCTIONS = [
    '你在独立记事簿工作台中工作，正文聊天可以同时继续。',
    '修改工具只提交待审核草案；不要等人类在工具回调内审核。',
    '需要修改时调用已提供的记事簿工具。不要直接写入世界书、用户或角色设定。',
    '用 workspace.write_file 将给用户的本轮回复写入 ' + WORKBENCH_OUTPUT_PATH + '，然后调用 workspace.finish。讨论轮写对话回复，已登记计划时只写简短确认。只写这个输出文件，不调用 workspace.commit。',
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
function notify(callback, ...args) { try { callback?.(...args); } catch { /* Rendering cannot strand a run. */ } }

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
    const { signal, messages = [], tools = [], onText, onReasoning, onStatus, onTool, onRunStart, onCancel } = options;
    aborted(signal);
    const saved = runtimeCapture(capture);
    notify(onStatus, '正在组装已选材料');
    const assembled = await assembleWorkbenchPrompt(capture, messages, capture.sourceId === 'main' && !options.plainReply ? NATIVE_INSTRUCTIONS : '');
    aborted(signal);
    if (options.plainReply && capture.sourceId === 'main') {
        const {requestMainDiscussion} = await import('./providers.js');
        return requestMainDiscussion(capture, saved, toProviderMessages(assembled.promptSnapshot), {signal,onText,onReasoning,onStatus});
    }
    if (capture.sourceId === 'main') return runNative(capture, saved, assembled, { signal, tools, onText, onReasoning, onStatus, onTool, onRunStart, onCancel });
    const request = options.requestChannel ?? (await import('./providers.js')).requestChannel;
    return runProvider(capture, saved, assembled, { signal, tools, onText, onReasoning, onStatus, onTool, request });
}

async function runProvider(capture, saved, assembled, { signal, tools, onText, onReasoning, onStatus, onTool, request }) {
    const messages = toProviderMessages(assembled.promptSnapshot);
    const channel = { ...saved.channel, ...capture.generationSettings };
    const allow = new Set(tools.map(tool => tool.name));
    const completed = new Map();
    let usage = null, result, reasoning = '';
    for (let round = 0; round < 12; round++) {
        aborted(signal);
        const prefix = reasoning ? reasoning + '\n\n' : '';
        result = await request(channel, messages, { tools, signal, onText, onStatus,
            onReasoning: (delta, complete) => notify(onReasoning, delta, prefix + complete), round: round + 1 });
        aborted(signal);
        if (result.reasoning) reasoning = prefix + result.reasoning;
        usage = result.usage ?? usage;
        if (!result.toolCalls?.length) {
            if (['length', 'max_tokens', 'content_filter'].includes(result.finishReason)) throw fail('本次输出未完整结束；已提交的草案仍可查看，请缩短下一批。', 'incomplete_response', result);
            return { text: result.text ?? '', ...(reasoning ? { reasoning } : {}), usage, finishReason: result.finishReason ?? 'stop' };
        }
        // Only complete, parsed tool calls reach this boundary. Providers reject
        // truncated JSON; never guess or automatically replay a partial mutation.
        messages.push({ role: 'assistant', content: result.text ?? '', ...(result.reasoning ? { reasoning_content: result.reasoning } : {}), tool_calls: result.toolCalls.map(call => ({
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
                notify(onStatus, '执行工作台工具 ' + call.name);
                try { value = await onTool(call.name, call.arguments, { callId: call.id, signal, scope: capture.scope }); }
                catch (error) {
                    if (signal?.aborted || error.name === 'AbortError') throw error;
                    value = { ok: false, error: error.message };
                }
                completed.set(call.id, { signature, value });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: safeResult(value) });
            notify(onStatus, '工作台工具 ' + call.name + ' 已返回');
        }
    }
    throw fail('本批工具往返超过 12 次，已停止。请查看已保存草案后缩小任务。', 'tool_round_limit', result);
}

async function runNative(capture, saved, assembled, { signal, tools, onText, onReasoning, onStatus, onTool, onRunStart, onCancel }) {
    const agent = saved.runtime.api.agent;
    notify(onStatus, '正在连接正文主 API');
    const profileId = await prepareNativeProfile(agent, tools, saved.duties + '\n' + NATIVE_INSTRUCTIONS);
    aborted(signal);
    const completed = new Map();
    const local = new AbortController();
    let watchdog, lastStage;
    const progress = stage => {
        watchdog?.progress(stage);
        if (lastStage !== stage) { lastStage = stage; notify(onStatus, stage); }
    };
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
        progress('执行工作台工具 ' + name);
        const promise = Promise.resolve().then(() => {
            aborted(combined.signal);
            return onTool(name, args, { ...execution, signal: combined.signal, scope: capture.scope });
        }).then(value => { progress('工作台工具 ' + name + ' 已返回'); return value; }).finally(combined.dispose);
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
    let settled = false, finalizing = false, preview = '', shown = '', shownReasoning = '', lastFailure = '';
    const responses = new Map(), reasonings = new Map();
    const fullReasoning = () => [...reasonings.values()].filter(Boolean).join('\n\n');
    let latestResponse = '';
    const flush = () => {
        clearTimeout(flushTimer);
        flushTimer = undefined;
        if (settled) return;
        if (preview !== shown) {
            const delta = preview.startsWith(shown) ? preview.slice(shown.length) : '';
            shown = preview; notify(onText, delta, preview);
        }
        const reasoning = fullReasoning();
        if (reasoning !== shownReasoning) {
            const delta = reasoning.startsWith(shownReasoning) ? reasoning.slice(shownReasoning.length) : '';
            shownReasoning = reasoning; notify(onReasoning, delta, reasoning);
        }
    };
    const schedulePreview = () => { if (!flushTimer) flushTimer = setTimeout(flush, 60); };
    const cleanup = () => {
        local.abort(); stopEvents(); stopLive(); watchdog?.stop(); clearTimeout(flushTimer);
        signal?.removeEventListener('abort', onAbort); releaseNativeRun(agent, handle.runId);
    };
    let rejectRun;
    const stop = error => {
        if (settled) return;
        flush();
        error.partial = { ...error.partial, text: preview, reasoning: fullReasoning() };
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
        progress('等待 TT 首条运行记录');
        try {
            stopEvents = agent.subscribe(handle.runId, event => {
                if (settled || finalizing) return;
                const stage = describeRunEvent(event);
                if (stage) progress(stage);
                if (event.type === 'model_call_attempt_failed') {
                    lastFailure = describeRunFailure(event, saved.settings);
                    if (lastFailure) notify(onStatus, '模型调用失败：' + lastFailure);
                } else if (event.type === 'model_completed') lastFailure = '';
                if (!['run_completed', 'run_partial_success', 'run_failed', 'run_cancelled'].includes(event.type)) return;
                finalizing = true;
                if (event.type !== 'run_completed') {
                    const cancelled = event.type === 'run_cancelled';
                    const detail = describeRunFailure(event, saved.settings);
                    const error = cancelled ? new DOMException('已停止', 'AbortError')
                        : fail([detail, lastFailure].filter((value, index, all) => value && all.indexOf(value) === index).join('\n') || 'TT 工作台任务未完整完成；已提交草案仍可查看。', event.type,
                            { text: preview, reasoning: fullReasoning() });
                    error.runId = handle.runId; flush();
                    settled = true; cleanup(); reject(error); return;
                }
                progress('读取已完成的工作台回复文件');
                Promise.resolve().then(() => agent.readWorkspaceFile({ runId: handle.runId, path: WORKBENCH_OUTPUT_PATH }))
                    .then(file => {
                        if (settled) return;
                        if (typeof file?.text !== 'string' || !file.text.trim()) throw fail('TT 已结束运行，但没有完整工作台回复文件。', 'missing_output');
                        flush(); settled = true; cleanup();
                        notify(onText, file.text.startsWith(shown) ? file.text.slice(shown.length) : '', file.text);
                        const reasoning = fullReasoning();
                        resolve({ text: file.text, ...(reasoning ? { reasoning } : {}), usage: event.payload?.usage ?? null, finishReason: 'stop', runId: handle.runId });
                    }).catch(error => {
                        if (!settled) {
                            flush(); error.runId = handle.runId;
                            error.partial = { ...error.partial, text: preview, reasoning: fullReasoning() };
                            settled = true; cleanup(); reject(error);
                        }
                    });
            }, { afterSeq: 0, intervalMs: 750, limit: 100, onError: error => stop(error) });
            if (settled) stopEvents();
            if (!settled && typeof agent.subscribeLiveProjection === 'function') {
                stopLive = agent.subscribeLiveProjection(handle.runId, update => {
                    if (settled || finalizing) return;
                    const active = update.type === 'responseAppend' ? update
                        : update.type === 'responseReplace' ? update.response : null;
                    if (active?.text) progress('已收到模型正文');
                    else if (active?.reasoning) progress('已收到模型推理');
                    else if (active?.toolIds?.length || (update.type === 'append' && update.text) || (update.type === 'replace' && update.call))
                        progress('已收到模型工具调用');
                    if (update.type === 'snapshot') {
                        responses.clear(); reasonings.clear();
                        for (const response of update.responses ?? []) {
                            responses.set(response.invocationId, response.text ?? '');
                            reasonings.set(response.invocationId, response.reasoning ?? ''); latestResponse = response.invocationId;
                        }
                        if (update.calls?.length || update.responses?.some(r => r.text || r.reasoning || r.toolIds?.length)) progress('已收到 TT 输出快照');
                    } else if (update.type === 'responseReplace') {
                        const response = update.response;
                        if (response) {
                            responses.set(response.invocationId, response.text ?? '');
                            reasonings.set(response.invocationId, response.reasoning ?? ''); latestResponse = response.invocationId;
                        }
                    } else if (update.type === 'responseAppend') {
                        latestResponse = update.invocationId;
                        responses.set(latestResponse, (responses.get(latestResponse) ?? '') + (update.text ?? ''));
                        reasonings.set(latestResponse, (reasonings.get(latestResponse) ?? '') + (update.reasoning ?? ''));
                    } else if (update.type === 'responseRemove') { responses.delete(update.invocationId); reasonings.delete(update.invocationId); }
                    preview = responses.get(latestResponse) ?? preview;
                    schedulePreview();
                }, { onError: () => { /* Journal remains authoritative; losing preview is not a failed edit. */ } });
            }
        } catch (error) { stop(error); }
    });
}

// One user-initiated tail read, including runs saved by older notebook versions.
export async function readWorkbenchRunLog(runId, runtime) {
    const host = runtime ?? await getTTRuntime();
    const agent = host.api.agent;
    if (typeof agent?.readEvents !== 'function') throw new Error('此 TT 版本未提供运行记录读取接口。');
    const page = await agent.readEvents({runId, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 40});
    return (page?.events ?? []).flatMap(event => {
        const stage = describeRunEvent(event);
        if (!stage) return [];
        const failure = event.type.endsWith('_failed') || event.type === 'run_partial_success';
        const detail = failure ? describeRunFailure(event, host.openai?.oai_settings)
            || 'TT 只记录了失败状态，没有附上错误说明。' : '';
        return [{ label: '#' + event.seq + '　' + stage, detail }];
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
