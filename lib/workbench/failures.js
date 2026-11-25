import { redactDiagnostic } from './progress.js';

const labels = { tool: '工具执行失败', model: '模型请求失败', run: '工作台运行失败' };
export const failureLabel = failure => labels[failure?.kind] || labels.run;
export function failureSummary(failure) {
    return failureLabel(failure) + (failure.toolName ? '（' + failure.toolName + '）' : '')
        + '：' + failure.message.slice(0, 600) + '\n本次已停止。请检查报错后手动重试，或先补充要求。';
}
export function failureDetails(failure) {
    return [failure.message, failure.errorCode && '错误代码：' + failure.errorCode,
        failure.errorName && '异常类型：' + failure.errorName,
        failure.runId && 'TT 运行：' + failure.runId,
        failure.callId && '工具调用：' + failure.callId,
        failure.round && '轮次：' + failure.round,
        failure.resultPath && '工具错误文件：' + failure.resultPath,
        failure.eventMessage && failure.eventMessage !== failure.message && 'TT 原始记录：\n' + failure.eventMessage,
        failure.readError && '读取工具错误文件失败：' + failure.readError,
    ].filter(Boolean).join('\n\n');
}
export function runFailure(error, kind, metadata = {}, settings = {}) {
    if (error?.failure) return error;
    const failure = { version: 1, kind, ...metadata,
        message: redactDiagnostic(error?.message || error || '未提供错误说明', settings),
        ...(error?.name && error.name !== 'Error' ? { errorName: error.name } : {}),
        ...(error?.code ? { errorCode: String(error.code) } : {}),
    };
    const result = new Error(failureSummary(failure), { cause: error });
    result.code = error?.code || (kind === 'tool' ? 'tool_execution_failed' : kind + '_failed');
    result.failure = failure;
    if (error?.partial) result.partial = error.partial;
    return result;
}

function resultPath(event, events) {
    const p = event.payload ?? {};
    const stored = events.findLast(item => item.type === 'tool_result_stored'
        && p.callId && item.payload?.callId === p.callId
        && item.payload?.invocationId === p.invocationId && item.payload?.round === p.round);
    const path = stored?.payload?.path || p.message?.match(/full result:\s*(tool-results\/[^\s]+\.json)/)?.[1];
    return typeof path === 'string' && /^tool-results\/[\w./-]+\.json$/.test(path)
        && !path.split('/').some(part => !part || part === '.' || part === '..') ? path : '';
}
export function nativeToolFailure(runId, event, settings = {}, events = []) {
    const p = event.payload ?? {};
    return runFailure(p.message || 'TT 未提供工具错误说明', 'tool', {
        runId, toolName: String(p.name || p.toolId || '').split(':').pop(),
        callId: p.callId, round: p.round, errorCode: p.errorCode,
        resultPath: resultPath(event, events),
        eventMessage: redactDiagnostic(p.message || '', settings),
    }, settings);
}

// Read only the result referenced by this failed call. Never read its argument/prompt files.
export async function readToolFailure(agent, error, settings = {}) {
    const failure = error.failure;
    if (!failure.resultPath) return error;
    let timer;
    try {
        const file = await Promise.race([
            Promise.resolve().then(() => agent.readWorkspaceFile({ runId: failure.runId, path: failure.resultPath })),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('读取超过 5 秒；可稍后查看 TT 运行记录')), 5000); }),
        ]);
        const result = JSON.parse(file.text);
        if (result.callId && failure.callId && result.callId !== failure.callId) throw Error('工具结果与调用编号不符');
        if (typeof result.content !== 'string' || !result.content.trim()) throw Error('工具结果没有错误正文');
        failure.message = redactDiagnostic(result.content, settings);
        if (typeof result.errorCode === 'string') failure.errorCode = result.errorCode;
    } catch (readError) {
        failure.readError = redactDiagnostic(readError?.message || readError, settings);
    } finally { clearTimeout(timer); }
    error.message = failureSummary(failure);
    return error;
}
