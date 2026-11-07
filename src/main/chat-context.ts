import {validateMemory, type MemoryInput} from '../shared/memory'
import type {ToolChatMessage} from './llm-connection'

export interface ContextTurn {id: string; context: ToolChatMessage[]}
export interface Compaction {summary: string; coversUpTo: string}
export interface CompactPlan {older: ContextTurn[]; recent: ContextTurn[]}
/** Turns always kept verbatim in context after a compaction. */
export const recentTurns = 4
/** Reaching this many turns compacts everything older than the kept window. */
export const compactThreshold = 12
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
export function validateCompaction(raw: string): string {
    const parsed = JSON.parse(raw)
    const keys = ['facts', 'actions', 'pending', 'preferences']
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || keys.some(key => !Array.isArray(parsed[key]) ||
        parsed[key].some((item: unknown) => typeof item !== 'string')) || Object.keys(parsed).some(key => ![...keys, 'memories'].includes(key))) throw new Error('摘要结构无效。')
    const summary = JSON.stringify(parsed)
    if (summary.length > 1600) throw new Error('摘要超过 1600 字符。')
    return summary
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
export function extractCompactionMemories(summary: string, userMessages: string[]): MemoryInput[] {
    const raw = JSON.parse(summary).memories
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > 3) throw new Error('摘要记忆候选格式无效。')
    return raw.map(item => {
        const result = validateMemory({...item, status: 'active', pinned: false})
        if (!result.ok) throw new Error(result.error)
        if (!userMessages.some(text => text.includes(result.data.evidence))) throw new Error('记忆依据不在用户原话中。')
        return result.data
    })
}
