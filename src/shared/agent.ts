/** Stable, persisted execution records. Payloads are fetched separately from live snapshots. */
export type ChatCancelReason = 'user' | 'timeout' | 'settings_changed' | 'account_changed'
export type TraceKind = 'context' | 'compaction' | 'model' | 'retry' | 'tool' | 'usage' | 'approval' | 'undo' | 'error' | 'finish'
export interface ChatTraceEvent {
    id: string
    kind: TraceKind
    label: string
    at: string
    elapsedMs?: number
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    details?: unknown
}
export interface ToolBudget {rounds: number; calls: number}
export type ToolErrorCode = 'invalid_args' | 'not_found' | 'forbidden' | 'transient' | 'internal' | 'budget_exhausted'
export type ToolResult = ({ok: true; data: unknown} | {ok: false; code: ToolErrorCode; message: string; retryable: boolean}) & {
    truncated: boolean; remaining: ToolBudget; suggestion?: string
}
export const maxToolResultChars = 12000
export function toolSuccess(data: unknown, remaining: ToolBudget): Extract<ToolResult, {ok: true}> {
    const serialized = JSON.stringify(data) ?? 'null'
    if (serialized.length <= maxToolResultChars - 400) return {ok: true, data, truncated: false, remaining}
    return {ok: true, data: {preview: serialized.slice(0, maxToolResultChars - 500), originalChars: serialized.length},
        truncated: true, remaining, suggestion: '结果已截断。请缩小日期或关键词范围、减少 limit，或按 ID 读取单条详情；不要把预览当成完整结果。'}
}
export class ToolError extends Error {
    constructor(public code: ToolErrorCode, message: string) {super(message)}
}
export function toolFailure(error: unknown, remaining: ToolBudget): Extract<ToolResult, {ok: false}> {
    const code = error instanceof ToolError ? error.code : 'internal'
    return {ok: false, code, message: error instanceof Error ? error.message : '工具执行失败。',
        retryable: code === 'transient', truncated: false, remaining}
}

/** Redact credential fields and common credential strings before persistence or IPC. */
export function redactTrace(value: unknown, secrets: string[] = []): unknown {
    if (typeof value === 'string') {
        if (/^\s*[\[{]/.test(value)) {
            try {return JSON.stringify(redactTrace(JSON.parse(value), secrets))} catch { /* preserve non-JSON text */ }
        }
        let text = value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
            .replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]')
        for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]')
        return text
    }
    if (Array.isArray(value)) return value.map(item => redactTrace(item, secrets))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, /^(authorization|api[_-]?key|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token)$/i.test(key)
            ? '[REDACTED]' : redactTrace(item, secrets)]))
    return value
}

export const cancellationMessages: Record<ChatCancelReason, string> = {
    user: '已停止回复。未允许的请求不会执行，已完成的操作保留。',
    timeout: '模型响应空闲超时，已停止回复。已完成的操作保留，请查询实际状态后继续。',
    settings_changed: 'LLM 设置已变化，已停止回复。请使用新设置重新发送。',
    account_changed: '账号已变化，已停止原账号的回复。',
}
