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
/** Shape-only summary of an oversized result; a truncated JSON fragment must never reach the model. */
export function resultShape(value: unknown): Record<string, unknown> {
    if (Array.isArray(value)) return {kind: 'array', length: value.length}
    if (!value || typeof value !== 'object') return {kind: typeof value, ...(typeof value === 'string' ? {length: value.length} : {})}
    const record = value as Record<string, unknown>
    const fields = Object.fromEntries(Object.entries(record).slice(0, 12).map(([key, item]) => [key,
        Array.isArray(item) ? `array(${item.length})` : item && typeof item === 'object' ? 'object' : typeof item]))
    const items = record.items
    return {kind: 'object', fields, ...(Array.isArray(items) ? {
        itemCount: items.length,
        ...(typeof record.total === 'number' ? {total: record.total} : {}),
        ...(typeof record.hasMore === 'boolean' ? {hasMore: record.hasMore} : {}),
    } : {})}
}
export function toolSuccess(data: unknown, remaining: ToolBudget): Extract<ToolResult, {ok: true}> {
    const serialized = JSON.stringify(data) ?? 'null'
    if (serialized.length <= maxToolResultChars - 400) return {ok: true, data, truncated: false, remaining}
    return {ok: true, data: {
        truncated: true,
        originalChars: serialized.length,
        message: '结果超过长度上限，正文已省略。这里是结构摘要，不是完整数据。',
        shape: resultShape(data),
    }, truncated: true, remaining,
    suggestion: '请缩小日期或关键词范围、减少 limit，或按 ID 读取单条详情；不要根据结构摘要把数据当成完整结果。'}
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
        // Raw SSE bodies contain JSON frames and JSON-encoded function arguments. Redact them
        // structurally too; a credential inside a frame must not bypass object-field redaction.
        if (/^data:/m.test(value)) value = value.replace(/\r\n?/g, '\n').split('\n\n').map(frame => {
            const lines = frame.split('\n')
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
            try {
                const safe = JSON.stringify(redactTrace(JSON.parse(data), secrets))
                let written = false
                return lines.flatMap(line => {
                    if (!line.startsWith('data:')) return [line]
                    if (written) return []
                    written = true; return [`data: ${safe}`]
                }).join('\n')
            } catch {return frame}
        }).join('\n\n')
        const input = value as string
        if (/^\s*[\[{]/.test(input)) {
            try {return JSON.stringify(redactTrace(JSON.parse(input), secrets))} catch { /* preserve non-JSON text */ }
        }
        let text = input.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
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
