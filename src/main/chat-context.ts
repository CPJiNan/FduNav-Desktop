import {type Memory, type MemoryInput, validateMemory} from '../shared/memory'
import type {ToolChatMessage} from './llm-connection'

export interface ContextTurn {
    id: string;
    context: ToolChatMessage[]
}

export interface Compaction {
    summary: string;
    coversUpTo: string;
    updatesThrough?: number
}

export interface CompactPlan {
    older: ContextTurn[];
    recent: ContextTurn[]
}

export const recentTurns = 4
export const compactThreshold = 12
export const compactionChunkChars = 24000
export const foldedToolResult = JSON.stringify({
    ok: true, data: {
        folded: true,
        note: '较早的工具结果已折叠以节省上下文；需要时请重新查询，原文可在执行记录中查看。'
    }
})

export function foldToolMessages(messages: ToolChatMessage[], keep = 2, inPlace = false): ToolChatMessage[] {
    const tools: number[] = []
    messages.forEach((message, index) => {
        if (message.role === 'tool') tools.push(index)
    })
    const folded = new Set(tools.slice(0, Math.max(0, tools.length - keep)))
    return messages.map((message, index) => {
        if (!folded.has(index)) return message
        if (inPlace) {
            (message as { content: string }).content = foldedToolResult
            return message
        }
        return {...message, content: foldedToolResult}
    })
}

export function compactionChunks(turns: ContextTurn[]): ContextTurn[][] {
    const chunks: ContextTurn[][] = []
    let current: ContextTurn[] = [], size = 0
    for (const turn of turns) {
        const length = JSON.stringify(turn.context).length
        if (current.length && size + length > compactionChunkChars) {
            chunks.push(current);
            current = [];
            size = 0
        }
        current.push(turn);
        size += length
    }
    if (current.length) chunks.push(current)
    return chunks
}

export function compactTurns(turns: ContextTurn[]): CompactPlan {
    const recent = [...turns], older: ContextTurn[] = []
    while (recent.length && JSON.stringify(recent.map(turn => turn.context)).length > 60000) older.push(recent.shift()!)
    if (turns.length >= compactThreshold && recent.length > recentTurns) {
        older.push(...recent.splice(0, recent.length - recentTurns))
    }
    return {older, recent}
}

export function uncompactedTurns(turns: ContextTurn[], saved: Compaction | null): ContextTurn[] {
    if (!saved) return turns
    const index = turns.findIndex(turn => turn.id === saved.coversUpTo)
    return index < 0 ? turns : turns.slice(index + 1)
}

export const summaryKeys = ['facts', 'actions', 'pending', 'preferences'] as const

export function validateCompaction(raw: string): string {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error('摘要不是有效 JSON。')
    }
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
    const contentChars = summaryKeys.reduce((total, key) => total +
            (summary[key] as string[]).reduce((count, item) => count + item.length, 0), 0) +
        (Array.isArray(summary.memories) ? (summary.memories as Array<{ text?: unknown }>).reduce((count, item) =>
            count + (typeof item?.text === 'string' ? item.text.length : 0), 0) : 0)
    if (contentChars > 1600) throw new Error('摘要超过 1600 字符。')
    return JSON.stringify(summary)
}

export function parseSummary(summary: string | null | undefined): Record<string, unknown> | null {
    if (!summary) return null
    const {memories: _memories, ...rest} = JSON.parse(summary) as Record<string, unknown>
    return rest
}

export type MemoryCandidate =
    { op: 'add'; memory: MemoryInput } |
    { op: 'update'; targetId: string; memory: MemoryInput }

export interface CompactionMemoryScan {
    candidates: MemoryCandidate[]
    dropped: number
    errors: string[]
}

export function extractCompactionMemories(summary: string, userMessages: string[], existing: Memory[] = []): CompactionMemoryScan {
    const raw = JSON.parse(summary).memories
    if (raw === undefined) return {candidates: [], dropped: 0, errors: []}
    if (!Array.isArray(raw)) throw new Error('摘要记忆候选格式无效。')
    const scan: CompactionMemoryScan = {candidates: [], dropped: 0, errors: []}
    for (const item of raw.slice(0, 3)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            scan.dropped++;
            continue
        }
        const value = item as Record<string, unknown>
        if (value.op === 'skip') {
            scan.dropped++;
            continue
        }
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
        if (!checked.ok) {
            scan.dropped++;
            continue
        }
        if (!userMessages.some(text => text.includes(checked.data.evidence))) {
            scan.dropped++;
            continue
        }
        if (op === 'update' && target) scan.candidates.push({op: 'update', targetId: target.id, memory: checked.data})
        else {
            scan.candidates.push({op: 'add', memory: checked.data})
        }
    }
    if (raw.length > 3) scan.dropped += raw.length - 3
    return scan
}
