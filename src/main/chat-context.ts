import {validateMemory, memoryShortId, type Memory, type MemoryInput} from '../shared/memory'
import type {ToolChatMessage} from './llm-connection'

export interface ContextTurn {id: string; context: ToolChatMessage[]}
export interface Compaction {summary: string; coversUpTo: string; updatesThrough?: number}
export interface CompactPlan {older: ContextTurn[]; recent: ContextTurn[]}
/** Turns always kept verbatim in context after a compaction. */
export const recentTurns = 4
/** Reaching this many turns compacts everything older than the kept window. */
export const compactThreshold = 12
/** Character cap for one compaction request; older turns are folded in several chunks. */
export const compactionChunkChars = 24000
/** Placeholder for a tool result that was dropped from the prompt (the trace keeps the original). */
export const foldedToolResult = JSON.stringify({ok: true, data: {folded: true,
    note: '较早的工具结果已折叠以节省上下文；需要时请重新查询，原文可在执行记录中查看。'}})

/**
 * Replace older tool results with a short placeholder, keeping the last `keep` verbatim and every
 * tool_call_id intact so the assistant/tool pairing stays valid. Mutates only when `inPlace` is set.
 */
export function foldToolMessages(messages: ToolChatMessage[], keep = 2, inPlace = false): ToolChatMessage[] {
    const tools: number[] = []
    messages.forEach((message, index) => {if (message.role === 'tool') tools.push(index)})
    const folded = new Set(tools.slice(0, Math.max(0, tools.length - keep)))
    return messages.map((message, index) => {
        if (!folded.has(index)) return message
        if (inPlace) {
            (message as {content: string}).content = foldedToolResult
            return message
        }
        return {...message, content: foldedToolResult}
    })
}

/** Split compaction input on turn boundaries so a single request stays within the model window. */
export function compactionChunks(turns: ContextTurn[]): ContextTurn[][] {
    const chunks: ContextTurn[][] = []
    let current: ContextTurn[] = [], size = 0
    for (const turn of turns) {
        const length = JSON.stringify(turn.context).length
        if (current.length && size + length > compactionChunkChars) {
            chunks.push(current); current = []; size = 0
        }
        current.push(turn); size += length
    }
    if (current.length) chunks.push(current)
    return chunks
}
/** Preserve complete turns and tool-call/result pairs; oversized single turns go into the summary. */
export function compactTurns(turns: ContextTurn[]): CompactPlan {
    const recent = [...turns], older: ContextTurn[] = []
    while (recent.length && JSON.stringify(recent.map(turn => turn.context)).length > 60000) older.push(recent.shift()!)
    // At the threshold, drop the oldest turns and keep the newest four verbatim.
    if (turns.length >= compactThreshold && recent.length > recentTurns) {
        older.push(...recent.splice(0, recent.length - recentTurns))
    }
    return {older, recent}
}
export function uncompactedTurns(turns: ContextTurn[], saved: Compaction | null): ContextTurn[] {
    if (!saved) return turns
    const index = turns.findIndex(turn => turn.id === saved.coversUpTo)
    // Missing coverage marker means the conversation changed; do not silently drop history.
    return index < 0 ? turns : turns.slice(index + 1)
}
export const summaryKeys = ['facts', 'actions', 'pending', 'preferences'] as const
/**
 * Lenient summary validation: strip a JSON fence, fill missing sections with [] and drop unknown
 * keys, so a single cosmetic deviation does not burn all three compaction attempts.
 */
export function validateCompaction(raw: string): string {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    let parsed: unknown
    try {parsed = JSON.parse(text)} catch {throw new Error('摘要不是有效 JSON。')}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('摘要结构无效。')
    const record = parsed as Record<string, unknown>
    const summary: Record<string, unknown> = {}
    for (const key of summaryKeys) {
        const value = record[key] ?? []
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('摘要结构无效。')
        summary[key] = value
    }
    if (record.memories !== undefined) {
        if (!Array.isArray(record.memories)) throw new Error('摘要记忆候选格式无效。')
        summary.memories = record.memories
    }
    // The budget applies to the text the model reads, not to the JSON skeleton around it.
    const contentChars = summaryKeys.reduce((total, key) => total +
        (summary[key] as string[]).reduce((count, item) => count + item.length, 0), 0) +
        (Array.isArray(summary.memories) ? (summary.memories as Array<{text?: unknown}>).reduce((count, item) =>
            count + (typeof item?.text === 'string' ? item.text.length : 0), 0) : 0)
    if (contentChars > 1600) throw new Error('摘要超过 1600 字符。')
    return JSON.stringify(summary)
}

/**
 * Stored summaries are JSON text. Inject them as structured data so the model does not read — and
 * the trace panel does not display — escaped JSON inside JSON.
 */
export function parseSummary(summary: string | null | undefined): Record<string, unknown> | string | null {
    if (!summary) return null
    try {
        const parsed: unknown = JSON.parse(summary)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary
        // memories are proposal candidates, not summaries: injecting them back invites re-proposals.
        const {memories: _memories, ...rest} = parsed as Record<string, unknown>
        return rest
    } catch {
        return summary
    }
}

/** Reuse the compaction response for memory suggestions; every write still requires approval. */
/** A compaction memory proposal after server-side validation. */
export type MemoryCandidate =
    {op: 'add'; memory: MemoryInput} |
    {op: 'update'; targetId: string; memory: MemoryInput}

export interface CompactionMemoryScan {
    candidates: MemoryCandidate[]
    /** Candidates silently dropped (skip, invalid fields, fabricated evidence). */
    dropped: number
    /** Problems worth a trace event, e.g. an unknown targetId that was downgraded to add. */
    errors: string[]
}

/**
 * Validate the compaction response's memory proposals against existing memories. A proposal may be
 * `skip`ped, update a known target (`targetId`, 8-char handle or full id) or add a new memory.
 * One invalid proposal never discards its valid siblings.
 */
export function extractCompactionMemories(summary: string, userMessages: string[], existing: Memory[] = []): CompactionMemoryScan {
    const raw = JSON.parse(summary).memories
    if (raw === undefined) return {candidates: [], dropped: 0, errors: []}
    if (!Array.isArray(raw)) throw new Error('摘要记忆候选格式无效。')
    const scan: CompactionMemoryScan = {candidates: [], dropped: 0, errors: []}
    for (const item of raw.slice(0, 3)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {scan.dropped++; continue}
        const value = item as Record<string, unknown>
        if (value.op === 'skip') {scan.dropped++; continue}
        const op = value.op === 'update' ? 'update' : 'add'
        let target: Memory | undefined
        if (op === 'update') {
            const handle = typeof value.targetId === 'string' ? value.targetId : ''
            const matches = handle ? existing.filter(memory => memory.id === handle || memory.id.startsWith(handle)) : []
            if (matches.length === 1) target = matches[0]
            else scan.errors.push('压缩候选引用了不存在的记忆')
        }
        const checked = validateMemory({
            kind: value.kind, text: value.text,
            evidence: value.evidence,
            confidence: value.confidence ?? target?.confidence ?? 0.6,
            pinned: target?.pinned ?? false,
            expiresAt: value.expiresAt === undefined ? target?.expiresAt ?? null : value.expiresAt,
            status: 'active',
        })
        if (!checked.ok) {scan.dropped++; continue}
        // Both additions and updates must cite actual user input. Old evidence cannot establish
        // a new fact just because the model happened to name a valid target.
        if (!userMessages.some(text => text.includes(checked.data.evidence))) {scan.dropped++; continue}
        if (op === 'update' && target) scan.candidates.push({op: 'update', targetId: target.id, memory: checked.data})
        else {
            scan.candidates.push({op: 'add', memory: checked.data})
        }
    }
    if (raw.length > 3) scan.dropped += raw.length - 3
    return scan
}
