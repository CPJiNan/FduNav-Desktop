import type {ResearchSource, ResearchToolName} from './research'

export interface ReviewFact {
    claim: string
    sourceId: string
    qualification: string
}

export interface ReviewAudit {
    corrections: string[]
    requiredActions: ResearchToolName[]
    facts: ReviewFact[]
}

const reviewActionNames: ResearchToolName[] = ['search_web', 'read_web', 'search_campus_posts', 'read_campus_thread']

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function retrievalForbidden(question: string): boolean {
    return /(?:不要|不再|不用|无需|禁止)(?:再)?(?:搜索|检索|查找|查阅)|只(?:依据|根据|用)(?:已有|现有)/.test(question)
}

export function requestedActions(question: string): Set<ResearchToolName> {
    if (retrievalForbidden(question)) return new Set()
    const text = question.replace(/[“「『].*?[”」』]/g, '')
    const actions = new Set<ResearchToolName>()
    for (const match of text.matchAll(/(?:^|请|帮我|先|再|并|同时|然后)(?:搜索|检索|查找|查阅|查)(?!到|无|不|完)([^。！？；]{0,120})/g)) {
        const target = match[1]
        if (/树洞|帖子/.test(target)) actions.add('search_campus_posts')
        if (/官网|官方|网页|公开/.test(target) || !/树洞|帖子/.test(target)) actions.add('search_web')
    }
    for (const match of text.matchAll(/(?:^|请|并|再|先|，|。|；|：)(?:读取|阅读|读一下|读一读)([^。！？；]{0,60})/g)) {
        const target = match[1]
        if (/帖子|树洞|上下文/.test(target)) actions.add('read_campus_thread')
        else if (/网页|正文|页面|官网/.test(target)) actions.add('read_web')
    }
    if (text.includes('只用公开网页') || /(?:对照|比较)[^。！？；]{0,30}官方/.test(text)) actions.add('search_web')
    return actions
}

export function characterLimit(question: string): number | null {
    const matches = [...question.matchAll(/(?:最多|不超过|至多|上限(?:为)?|控制在)\s*(\d{1,5})\s*(?:个)?字|(\d{1,5})\s*字(?:以内|以下)/g)]
    if (!matches.length) return null
    const last = matches[matches.length - 1]
    const value = Number(last[1] ?? last[2])
    return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function normalizedText(text: string): string {
    return [...text.normalize('NFKC')].filter(character => /[\p{L}\p{N}]/u.test(character)).join('')
}

export function copiedPostIds(answer: string, sources: readonly ResearchSource[]): string[] {
    const normalized = normalizedText(answer)
    return sources.filter(source => {
        if (source.source !== 'campus') return false
        const body = normalizedText(source.snippet)
        return body.length >= 8 && normalized.includes(body)
    }).map(source => source.id)
}

export interface AnswerIssue {
    code: 'unknown_citations' | 'answer_too_long' | 'whole_post_copy'
    ids?: string[]
    actual?: number
    maximum?: number
}

export function answerIssues(answer: string, known: ReadonlySet<string>, limit: number | null,
                             sources: readonly ResearchSource[] = []): AnswerIssue[] {
    const issues: AnswerIssue[] = []
    const unknown = [...new Set([...answer.matchAll(/\[([WwCc][1-9][0-9]{0,5})\]/g)]
        .map(match => match[1].toUpperCase()))].filter(id => !known.has(id))
    if (unknown.length) issues.push({code: 'unknown_citations', ids: unknown.sort()})
    if (limit !== null && answer.length > limit) issues.push({
        code: 'answer_too_long',
        actual: answer.length,
        maximum: limit
    })
    const copied = copiedPostIds(answer, sources)
    if (copied.length) issues.push({code: 'whole_post_copy', ids: copied})
    return issues
}

export function shortFailure(limit: number): string {
    for (const text of ['本轮未能生成符合要求的回答，请缩小问题后重试。', '本轮未完成，请重试。', '未完成。', '…']) {
        if (text.length <= limit) return text
    }
    return ''
}

export function fallbackAnswer(reason: string, hasEvidence: boolean): string {
    const text = `本轮未能完成回答：${reason}`
    return `${text}${hasEvidence ? '\n\n已取得部分检索资料，但尚未完成综合核对。' : ''}\n\n可以重新发送此问题。`
}

export function validateAudit(value: unknown): ReviewAudit | null {
    if (!isRecord(value)) return null
    const corrections = Array.isArray(value.corrections) ? value.corrections : []
    if (corrections.length > 8) return null
    const cleanedCorrections: string[] = []
    for (const item of corrections) {
        if (typeof item !== 'string' || !item.trim() || item.length > 800) return null
        cleanedCorrections.push(item.trim())
    }
    const required = Array.isArray(value.requiredActions) ? value.requiredActions : []
    if (required.length > 4) return null
    const actions: ResearchToolName[] = []
    for (const item of required) {
        if (typeof item !== 'string' || !reviewActionNames.includes(item as ResearchToolName)) return null
        if (!actions.includes(item as ResearchToolName)) actions.push(item as ResearchToolName)
    }
    const facts = Array.isArray(value.facts) ? value.facts : []
    if (facts.length > 8) return null
    const cleanedFacts: ReviewFact[] = []
    for (const item of facts) {
        if (!isRecord(item)) return null
        const {claim, sourceId, qualification} = item
        if (typeof claim !== 'string' || !claim.trim() || claim.length > 400) return null
        if (typeof sourceId !== 'string' || !/^[WC][1-9][0-9]{0,5}$/.test(sourceId)) return null
        if (typeof qualification !== 'string' || !qualification.trim() || qualification.length > 400) return null
        cleanedFacts.push({claim: claim.trim(), sourceId, qualification: qualification.trim()})
    }
    return {corrections: cleanedCorrections, requiredActions: actions, facts: cleanedFacts}
}

export function factCheckErrors(audit: ReviewAudit, evidence: ReadonlyMap<string, ResearchSource>,
                                draft: string): string[] {
    const errors: string[] = []
    if (/\d+(?:\.\d+)?\s*元|免费/.test(draft) && !audit.facts.length && !audit.corrections.length) {
        errors.push('回答包含费用结论，必须提供 facts 核对记录或明确指出无依据的费用断言。')
    }
    for (const fact of audit.facts) {
        if (!evidence.has(fact.sourceId)) errors.push('facts 必须指向本轮实际取回的非模拟来源编号。')
    }
    return errors
}
