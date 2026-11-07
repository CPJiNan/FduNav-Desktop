import type {Result} from './accounts'

export interface MemoryInput {
    kind: 'fact' | 'preference' | 'event'
    text: string
    confidence: number
    evidence: string
    pinned: boolean
    expiresAt: string | null
    status: 'active' | 'archived'
}
export interface Memory extends MemoryInput {id: string; createdAt: string; updatedAt: string}
export interface MemoryState {username: string; enabled: boolean; items: Memory[]}
export interface MemoryAPI {
    get(): Promise<Result<MemoryState>>
    save(input: MemoryInput & {id: string}): Promise<Result<MemoryState>>
    remove(id: string): Promise<Result<MemoryState>>
    setEnabled(enabled: boolean): Promise<Result<MemoryState>>
    importJson(json: string, expectedUsername: string): Promise<Result<MemoryState>>
    exportJson(): Promise<Result<string>>
}
export function validateMemory(input: unknown): Result<MemoryInput> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, error: '记忆格式无效。'}
    const v = input as Record<string, unknown>
    if (!['fact', 'preference', 'event'].includes(String(v.kind)) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 600 ||
        typeof v.evidence !== 'string' || !v.evidence.trim() || v.evidence.length > 1000 ||
        typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1 ||
        typeof v.pinned !== 'boolean' || !['active', 'archived'].includes(String(v.status)) ||
        !(v.expiresAt === null || (typeof v.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v.expiresAt) && Number.isFinite(Date.parse(v.expiresAt))))) {
        return {ok: false, error: '记忆需包含类型、1–600 字正文、来源依据、0–1 可信度、置顶状态和有效到期时间。'}
    }
    return {ok: true, data: {kind: v.kind as MemoryInput['kind'], text: v.text.trim(), evidence: v.evidence.trim(),
        confidence: v.confidence, pinned: v.pinned, status: v.status as MemoryInput['status'], expiresAt: v.expiresAt as string | null}}
}
/** Memory ids are UUIDs owned by the UI; the model only needs a stable, short handle. */
export const memoryShortId = (id: string) => id.slice(0, 8)
/** Compact injection line: no timestamps, evidence or status, which the model cannot use. */
export const memoryLine = (item: Pick<Memory, 'id' | 'kind' | 'text'>) => `- [${item.kind}] ${item.text} #${memoryShortId(item.id)}`
/** Model-facing memory record shared by recall and forget. */
export const presentMemory = (item: Memory) => ({id: memoryShortId(item.id), kind: item.kind, text: item.text})
/** Character budget applies to the exact JSON injected, including metadata. */
export function selectMemories(items: Memory[], query: string, now = Date.now()): Memory[] {
    const phrases = query.toLocaleLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []
    const words = [...new Set(phrases.flatMap(word => /^[\p{Script=Han}]+$/u.test(word) && word.length > 2
        ? Array.from({length: word.length - 1}, (_, index) => word.slice(index, index + 2)) : [word]))]
    const active = items.filter(item => item.status === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > now))
    const score = (item: Memory) => words.filter(word => item.text.toLocaleLowerCase().includes(word)).length
    const sorted = active.filter(item => item.pinned || score(item) > 0 || now - Date.parse(item.updatedAt) < 30 * 86400000)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
    const selected: Memory[] = []
    let unpinned = 0
    for (const item of sorted) {
        if (!item.pinned && unpinned >= 8) continue
        if (JSON.stringify([...selected, item]).length > 1200) continue
        selected.push(item)
        if (!item.pinned) unpinned++
    }
    return selected
}
