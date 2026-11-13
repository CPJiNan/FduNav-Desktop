import type {ToolChatMessage} from './llm-connection'
import {
    type AnswerIssue,
    answerIssues,
    factCheckErrors,
    fallbackAnswer,
    type ReviewAudit,
    shortFailure,
    validateAudit
} from '../shared/research-review'
import {modelSourceView, type ResearchSource} from '../shared/research'
import {auditSystemPrompt, reviewSystemPrompt} from '../shared/research-prompts'

export interface ReviewInput {
    question: string
    userTurns: string[]
    previousAnswer: string | null
    draft: string
    limit: number | null
    context: ToolChatMessage[]
    sources: ResearchSource[]
    known: Set<string>
    availableTools: string[]
    budget: Record<string, number>
    requiredActions: string[]
    retrievalForbidden: boolean
    runtimeNotices: string[]
}

export interface ReviewOutcome {
    answer: string
    reviewed: boolean
    warnings: string[]
    issues: AnswerIssue[]
}

export type ReviewComplete = (system: string, payload: unknown, label: string) => Promise<string>

interface ToolAction {
    tool: string
    status: 'complete' | 'error'
    arguments: unknown
}

interface ThreadRead {
    holeId: number
    reportedReplyCount: number | null
    offset: number
    rawCount: number
    sourceIds: string[]
}

function parseJson(text: string): unknown {
    let value = text.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value)
    if (fenced) value = fenced[1].trim()
    return JSON.parse(value)
}

function readEnvelope(content: string): {
    ok: boolean;
    data?: Record<string, unknown>;
    code?: string;
    message?: string
} | null {
    try {
        const parsed = JSON.parse(content)
        if (!parsed || typeof parsed !== 'object') return null
        if (parsed.ok === true && parsed.data && typeof parsed.data === 'object') return {ok: true, data: parsed.data}
        if (parsed.ok === false) return {
            ok: false,
            code: String(parsed.code ?? ''),
            message: String(parsed.message ?? '')
        }
        return null
    } catch {
        return null
    }
}

export function buildReviewPayload(input: ReviewInput): Record<string, unknown> {
    const evidence = new Map<string, Record<string, unknown>>()
    for (const source of input.sources) evidence.set(source.id, {...modelSourceView(source)})
    const toolNames = new Map<string, string>()
    const toolArguments = new Map<string, unknown>()
    const actions: ToolAction[] = []
    const errors: { tool: string; code: string; message: string }[] = []
    const threadReads: ThreadRead[] = []
    for (const message of input.context) {
        if (message.role === 'assistant') {
            for (const call of message.tool_calls ?? []) {
                toolNames.set(call.id, call.function.name)
                try {
                    toolArguments.set(call.id, JSON.parse(call.function.arguments))
                } catch {
                    toolArguments.set(call.id, {})
                }
            }
            continue
        }
        if (message.role !== 'tool') continue
        const tool = toolNames.get(message.tool_call_id) ?? ''
        const envelope = readEnvelope(message.content)
        if (!envelope) continue
        const args = toolArguments.get(message.tool_call_id) ?? {}
        if (!envelope.ok) {
            actions.push({tool, status: 'error', arguments: args})
            errors.push({tool, code: envelope.code ?? 'error', message: envelope.message ?? ''})
            continue
        }
        const data = envelope.data ?? {}
        actions.push({tool, status: 'complete', arguments: args})
        const sourceId = typeof data.sourceId === 'string' ? data.sourceId : ''
        if (sourceId && typeof data.text === 'string') {
            const source = evidence.get(sourceId)
            if (source) {
                delete source.snippet
                Object.assign(source, {
                    pageText: data.text.slice(0, 12_000),
                    pageRead: true,
                    pageTruncated: data.truncated === true,
                })
            }
        }
        if (data.thread && typeof data.thread === 'object') {
            const thread = data.thread as Record<string, unknown>
            const results = Array.isArray(data.results) ? data.results : []
            threadReads.push({
                holeId: Number(thread.id),
                reportedReplyCount: typeof thread.reply === 'number' ? thread.reply : null,
                offset: Number(data.offset ?? 0),
                rawCount: Number(data.rawCount ?? 0),
                sourceIds: results.map(item => item && typeof item === 'object' ? String((item as {
                    id?: unknown
                }).id ?? '') : '')
                    .filter(Boolean),
            })
        }
    }
    const missingActions = input.requiredActions.filter(action => !actions.some(item => item.tool === action))
    return {
        question: input.question,
        userTurns: input.userTurns,
        previousAnswer: input.previousAnswer,
        evidence: [...evidence.values()],
        currentToolErrors: errors,
        currentToolActions: actions,
        threadReads,
        allowedCitationIds: [...input.known].sort(),
        outputConstraints: {maxCharacters: input.limit, draftCharacters: input.draft.length},
        validationErrors: answerIssues(input.draft, input.known, input.limit, input.sources),
        draft: input.draft,
        runtimeNotices: input.runtimeNotices,
        retrievalBudget: input.budget,
        availableTools: input.availableTools,
        requiredActions: input.requiredActions,
        missingActions,
        retrievalForbidden: input.retrievalForbidden,
    }
}

function parseAudit(text: string): ReviewAudit | null {
    try {
        return validateAudit(parseJson(text))
    } catch {
        return null
    }
}

export async function reviewDraft(input: ReviewInput, complete: ReviewComplete): Promise<ReviewOutcome> {
    const warnings: string[] = []
    const payload = buildReviewPayload(input)
    let audit: ReviewAudit | null = null
    let formatError: string | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await complete(
            auditSystemPrompt,
            {...payload, ...(formatError ? {auditFormatError: formatError} : {})},
            attempt === 0 ? '核对答案与引用' : '重新核对答案格式',
        )
        if (response.trim().startsWith('{') || response.trim().startsWith('```')) {
            audit = parseAudit(response)
        }
        if (audit) break
        formatError = '仅返回合法 JSON 对象，不要附加正文或代码块。'
    }
    if (!audit) {
        warnings.push('答案核对结果格式无效，已保留未核对回答。')
        return {answer: input.draft, reviewed: false, warnings, issues: []}
    }
    const corrections = [...audit.corrections]
    const missingActions = (payload.missingActions as string[]) ?? []
    if (missingActions.length) {
        corrections.push(`本轮未能执行用户明确要求的操作：${missingActions.join(', ')}。请在回答中说明限制，不要声称已检索或读取。`)
        warnings.push(`未能执行要求的检索或读取：${missingActions.join(', ')}。`)
    }
    const factErrors = factCheckErrors(audit, new Map(input.sources.map(source => [source.id, source])), input.draft)
    if (factErrors.length) {
        warnings.push(factErrors.join(' '))
        corrections.push(...factErrors)
    }
    const mechanics = answerIssues(input.draft, input.known, input.limit, input.sources)
    if (!corrections.length && !mechanics.length) return {answer: input.draft, reviewed: true, warnings, issues: []}
    let issues = mechanics
    let answer = input.draft
    for (let attempt = 0; attempt < 2; attempt++) {
        const revised = await complete(
            reviewSystemPrompt,
            {
                ...payload, corrections, factChecks: audit.facts,
                validationErrors: issues.length ? issues : (payload.validationErrors ?? []),
            },
            attempt === 0 ? '按核对结果修订回答' : '修正引用与长度问题',
        )
        answer = revised.trim()
        issues = answerIssues(answer, input.known, input.limit, input.sources)
        if (!issues.length) return {answer, reviewed: true, warnings, issues}
    }
    const reason = issues.some(issue => issue.code === 'unknown_citations') ? '回答引用了不存在的来源。'
        : issues.some(issue => issue.code === 'whole_post_copy') ? '回答复制了完整帖子。'
            : '回答仍超出字数上限。'
    return {
        answer: input.limit !== null && input.limit < 80 ? shortFailure(input.limit) : fallbackAnswer(reason, true),
        reviewed: false, warnings: [...warnings, reason], issues,
    }
}
