export const DEFAULT_TIMEOUT_SECONDS = 600;

// A streaming token updates one timestamp. Only the pending timeout wakes up to reschedule itself.
export function watchInactivity(seconds, initialStage, onTimeout) {
    const delay = seconds * 1000;
    let last = performance.now(), stage = initialStage;
    let timer = setTimeout(check, delay);
    function check() {
        const remaining = Math.ceil(delay - (performance.now() - last));
        if (remaining > 0) timer = setTimeout(check, remaining);
        else onTimeout(stage);
    }
    return {
        progress(next) { last = performance.now(); stage = next; },
        stop() { clearTimeout(timer); },
    };
}

const stages = {
    run_started: 'TT 已启动任务',
    context_assembled: 'TT 已组装上下文',
    model_request_created: 'TT 已创建模型请求',
    model_call_attempt_started: '等待模型响应',
    model_call_attempt_failed: '模型调用失败',
    model_call_retry_scheduled: 'TT 已安排重试',
    model_completed: '模型已返回',
    tool_call_requested: '等待工具执行',
    tool_call_completed: '工具已返回',
    tool_call_failed: '工具执行失败',
    drift_recovery_attempted: 'TT 正在引导模型完成工具调用',
    workspace_file_written: 'TT 已写入工作区文件',
    run_partial_success: 'TT 报告部分完成',
    run_completed: 'TT 报告完成',
    run_cancelled: 'TT 报告已取消',
    run_failed: 'TT 报告失败',
};
// Whitelist diagnostic fields. Journal payloads may contain prompts, arguments or provider credentials.
export function describeRunEvent(event) {
    if (!event || !Object.hasOwn(stages, event.type)) return '';
    const p = event.payload ?? {}, details = [];
    if (Number.isSafeInteger(p.round)) details.push('第' + p.round + '轮');
    if (Number.isSafeInteger(p.attempt)) details.push('第' + p.attempt + '次尝试');
    if (event.type.startsWith('tool_call_')) {
        const name = String(p.toolId || p.name || '').split(':').pop();
        if (/^[\w.-]{1,64}$/.test(name)) details.push(name);
    }
    if (event.type.endsWith('failed') || event.type === 'run_partial_success') {
        const code = p.code || p.errorCode || p.reasonCode;
        if (typeof code === 'string' && /^[\w.-]{1,96}$/.test(code)) details.push(code);
        const msg = typeof p.message === 'string' ? p.message : '';
        const http = msg.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*([45]\d\d)\b/i);
        if (http) details.push('HTTP ' + http[1]);
        else if (/\b(?:timeout|timed out)\b/i.test(msg)) details.push('TT 记录了超时');
        else if (/context_length_exceeded|maximum context length/i.test(msg)) details.push('超出模型上下文');
        else if (/connection refused|ECONNREFUSED/i.test(msg)) details.push('连接被拒绝');
    }
    return stages[event.type] + (details.length ? '（' + details.join('，') + '）' : '');
}

// Show the upstream reason rather than a generic "model call failed", but never
// stringify an event payload: it can contain prompt/tool bodies and credentials.
export function describeRunFailure(event, settings = {}) {
    const p = event?.payload ?? {};
    let message = p.message ?? p.error?.message ?? p.details?.message;
    if (typeof message !== 'string') return '';
    const secrets = [settings.proxy_password, settings.secret_id];
    const headers = [settings.custom_include_headers,
        ...Object.values(settings.additional_parameters_by_source ?? {}).map(value => value?.include_headers)];
    for (const raw of headers) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        try { secrets.push(...Object.values(JSON.parse(raw))); }
        catch {
            for (const line of raw.split('\n')) {
                const match = line.match(/^\s*[^:#]+:\s*["']?(.*?)["']?\s*$/);
                if (match?.[1]) secrets.push(match[1]);
            }
        }
    }
    for (const secret of secrets) if (typeof secret === 'string' && secret) message = message.split(secret).join('[已隐藏]');
    return message.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
        .replace(/((?:["']?(?:api[_-]?key|authorization|x-api-key|proxy_password|access_token)["']?)\s*[:=]\s*)[^\n,}]+/gi, '$1[已隐藏]')
        .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s"'<>]+/gi, '$1[已隐藏]')
        .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[已隐藏]@')
        .slice(0, 600);
}
