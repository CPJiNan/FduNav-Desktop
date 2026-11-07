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

export type MemorySource = 'tool' | 'compaction' | 'import' | 'edit' | 'restore' | 'consolidation'

export interface Memory extends MemoryInput {
    id: string;
    createdAt: string;
    updatedAt: string
    seenCount?: number
    mergedFrom?: string[]
    source?: MemorySource
}

export interface MemoryState {
    username: string;
    enabled: boolean;
    items: Memory[]
}

export interface ConsolidationGroup {
    id: string
    before: Memory[]
    after: MemoryInput
    status: 'ok' | 'failed'
    error?: string
}

export interface ConsolidationPreview {
    previewId: string
    groups: ConsolidationGroup[]
    failed: number
    skipped: number
}

export interface ConsolidationApplyResult {
    consolidationId: string
    groups: number
    removed: number
    state: MemoryState
}

export interface ConsolidationUndoResult {
    restored: number
    state: MemoryState
}

export interface MemoryAPI {
    get(): Promise<Result<MemoryState>>

    save(input: MemoryInput & { id: string }): Promise<Result<MemoryState>>

    remove(id: string): Promise<Result<MemoryState>>

    setEnabled(enabled: boolean): Promise<Result<MemoryState>>

    importJson(json: string, expectedUsername: string): Promise<Result<MemoryState>>

    exportJson(): Promise<Result<string>>

    consolidatePreview(input?: { ids?: string[] }): Promise<Result<ConsolidationPreview>>

    consolidateApply(input: { previewId: string; groupIds: string[] }): Promise<Result<ConsolidationApplyResult>>

    consolidateUndo(consolidationId: string): Promise<Result<ConsolidationUndoResult>>

    consolidateDiscard(previewId: string): Promise<Result<MemoryState>>

    consolidateCancel(): Promise<Result<null>>
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
    return {
        ok: true, data: {
            kind: v.kind as MemoryInput['kind'],
            text: v.text.trim(),
            evidence: v.evidence.trim(),
            confidence: v.confidence,
            pinned: v.pinned,
            status: v.status as MemoryInput['status'],
            expiresAt: v.expiresAt as string | null
        }
    }
}

export const memoryShortId = (id: string) => id.slice(0, 8)
export const memoryLine = (item: Pick<Memory, 'id' | 'kind' | 'text'>) => `- [${item.kind}] ${item.text} #${memoryShortId(item.id)}`
export const presentMemory = (item: Memory) => ({id: memoryShortId(item.id), kind: item.kind, text: item.text})
export const memoryLineBudget = 1200

export function selectMemories(items: Memory[], query: string, now = Date.now(), carryIds: string[] = []): Memory[] {
    const phrases = query.toLocaleLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []
    const words = [...new Set(phrases.flatMap(word => /^[\p{Script=Han}]+$/u.test(word) && word.length > 2
        ? Array.from({length: word.length - 1}, (_, index) => word.slice(index, index + 2)) : [word]))]
    const active = items.filter(item => item.status === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > now))
    const score = (item: Memory) => words.filter(word => item.text.toLocaleLowerCase().includes(word)).length
    const sorted = active.filter(item => item.pinned || score(item) > 0 || carryIds.includes(item.id))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
    const selected: Memory[] = []
    let unpinned = 0, chars = 0
    for (const item of sorted) {
        if (!item.pinned && unpinned >= 8) continue
        const line = memoryLine(item).length + 1
        if (chars + line > memoryLineBudget) continue
        selected.push(item);
        chars += line
        if (!item.pinned) unpinned++
    }
    return selected
}

export interface MemoryDigestEntry {
    id: string;
    kind: Memory['kind'];
    text: string
}

export const memoryDigestLimit = 20
export const memoryDigestChars = 800

function digestText(text: string): string {
    return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function hanChars(text: string): Set<string> {
    return new Set(text.match(/[\p{Script=Han}]/gu) ?? [])
}

function hanOverlap(text: string, messages: string[]): number {
    const own = hanChars(text)
    const known = new Set(messages.flatMap(message => [...hanChars(message)]))
    let count = 0
    for (const char of own) if (known.has(char)) count++
    return count
}

export function buildMemoryDigest(items: Memory[], turns: Array<{
    user: string
}>, now = Date.now()): MemoryDigestEntry[] {
    const active = items.filter(item => item.status === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > now))
    const picked = new Map<string, Memory>()
    const take = (list: Memory[], limit: number) => {
        for (const item of list.slice(0, limit)) if (!picked.has(item.id)) picked.set(item.id, item)
    }
    take(active.filter(item => item.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), 12)
    const messages = turns.map(turn => turn.user)
    const related = active.filter(item => !picked.has(item.id) && hanOverlap(item.text, messages) >= 2)
        .sort((a, b) => hanOverlap(b.text, messages) - hanOverlap(a.text, messages) || b.updatedAt.localeCompare(a.updatedAt))
    take(related, 12)
    take(active.filter(item => !picked.has(item.id) && Date.parse(item.createdAt) > now - 30 * 86400000)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), 6)
    const digest: MemoryDigestEntry[] = []
    for (const item of picked.values()) {
        const entry = {id: memoryShortId(item.id), kind: item.kind, text: digestText(item.text)}
        if (digest.length >= memoryDigestLimit) break
        if (JSON.stringify([...digest, entry]).length > memoryDigestChars) break
        digest.push(entry)
    }
    return digest
}

export function normalizeMemoryText(text: string): string {
    return text.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(text: string): Map<string, number> {
    const grams = new Map<string, number>()
    for (let index = 0; index < text.length - 1; index++) {
        const gram = text.slice(index, index + 2)
        grams.set(gram, (grams.get(gram) ?? 0) + 1)
    }
    return grams
}

export function diceCoefficient(left: string, right: string): number {
    if (!left || !right) return 0
    if (left === right) return 1
    const a = bigrams(left), b = bigrams(right)
    let total = 0, overlap = 0
    for (const [gram, count] of a) {
        total += count
        overlap += Math.min(count, b.get(gram) ?? 0)
    }
    for (const count of b.values()) total += count
    return total ? (2 * overlap) / total : 0
}

export interface MemoryCluster {
    items: Memory[];
    score: number
}

export function clusterMemories(items: Memory[], options: {
    threshold?: number;
    maxGroup?: number;
    maxGroups?: number
} = {}): MemoryCluster[] {
    const threshold = options.threshold ?? 0.55, maxGroup = options.maxGroup ?? 12, maxGroups = options.maxGroups ?? 8
    const parent = items.map((_, index) => index)
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]))
    const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra
    }
    const norms = items.map(item => normalizeMemoryText(item.text))
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const score = norms[i] === norms[j] ? 1 : diceCoefficient(norms[i], norms[j])
        if (score >= threshold) union(i, j)
    }
    const groups = new Map<number, number[]>()
    items.forEach((_, index) => {
        const root = find(index)
        groups.set(root, [...(groups.get(root) ?? []), index])
    })
    const clusters: MemoryCluster[] = []
    for (const indexes of groups.values()) {
        if (indexes.length < 2) continue
        let score = 0
        for (let i = 0; i < indexes.length; i++) for (let j = i + 1; j < indexes.length; j++) {
            const value = norms[indexes[i]] === norms[indexes[j]] ? 1 : diceCoefficient(norms[indexes[i]], norms[indexes[j]])
            if (value > score) score = value
        }
        clusters.push({items: indexes.slice(0, maxGroup).map(index => items[index]), score})
    }
    return clusters.sort((a, b) => b.score - a.score).slice(0, maxGroups)
}

export function mergeConsolidationGroup(before: Memory[], output: unknown): Result<MemoryInput> {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return {ok: false, error: '模型输出格式无效。'}
    const value = output as Record<string, unknown>
    if (typeof value.text !== 'string' || !value.text.trim()) return {ok: false, error: '模型未返回合并后的文本。'}
    const text = value.text.trim().slice(0, 600)
    if (!Array.isArray(value.keepIds) || !value.keepIds.length || value.keepIds.some(id => typeof id !== 'string')) {
        return {ok: false, error: '模型未说明保留了哪些条目。'}
    }
    const ids = value.keepIds.map(id => before.find(item => memoryShortId(item.id) === id || item.id === id)?.id)
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) return {
        ok: false,
        error: '模型引用了组外或不存在的记忆。'
    }
    const kind = before[0].kind
    const counts = new Map<Memory['kind'], number>()
    for (const item of before) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
    let chosen: Memory['kind'] = kind
    for (const [candidate, count] of counts) {
        if (count > (counts.get(chosen) ?? 0)) chosen = candidate
    }
    const evidence = [...new Set(before.map(item => item.evidence))].join('；').slice(0, 1000)
    const expiries = before.map(item => item.expiresAt).filter((value): value is string => !!value).sort()
    return {
        ok: true, data: {
            kind: chosen, text, evidence, status: 'active',
            confidence: Math.max(...before.map(item => item.confidence)),
            pinned: before.some(item => item.pinned),
            expiresAt: expiries[0] ?? null,
        }
    }
}
