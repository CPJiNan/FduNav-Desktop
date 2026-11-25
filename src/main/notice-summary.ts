import {createHash} from 'node:crypto'
import {type ChatMessage, completeLlm} from './llm-connection.ts'
import {SummaryQueue} from './summary-queue.ts'
import type {AppDatabase} from './database'
import type {LlmSettingsService} from './llm-settings'
import type {Notice, NoticeDetail, NoticeRef, NoticeRelevance, NoticeSummary} from '../shared/notices'
import type {LlmSettings} from '../shared/llm'
import {
    educationLevelOptions,
    genderOptions,
    identityOptions,
    type MessagePreferences,
    validateRequiredMessagePreferences,
} from '../shared/message-preferences.ts'

function normalizeRelevance(value: unknown): NoticeRelevance | null {
    if (value === 'related') return 'related'
    if (value === 'maybe') return 'maybe'
    return null
}

export function parseSummaryOutput(text: string): { content: string; relevance: NoticeRelevance | null } {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const object = cleaned.match(/\{[\s\S]*\}/)?.[0]
    const candidates = object && object !== cleaned ? [cleaned, object] : [cleaned]
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate) as Record<string, unknown> | null
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue
            if (typeof value.summary !== 'string' || !value.summary.trim()) continue
            return {content: value.summary.trim(), relevance: normalizeRelevance(value.relevance)}
        } catch {
        }
    }
    throw new Error('模型未返回有效的结构化摘要。')
}

export function summaryMessages(notice: Notice, content: string, preferences: MessagePreferences,
                                prompt: string): ChatMessage[] {
    return [
        {role: 'system', content: prompt},
        {
            role: 'user',
            content: JSON.stringify({
                messagePreferences: {
                    身份: identityOptions.find(option => option.value === preferences.identity)?.label ?? '未填写',
                    性别: genderOptions.find(option => option.value === preferences.gender)?.label ?? '未填写',
                    院系: preferences.department || '未填写',
                    学历阶段: educationLevelOptions.find(option => option.value === preferences.educationLevel)?.label ?? '未填写',
                    年级: preferences.grade === null ? '未填写' : `${preferences.grade}级`,
                    专业: preferences.major || '未填写',
                    校区: preferences.campus || '未填写',
                },
                notice: {
                    title: notice.title,
                    source: notice.sourceName,
                    published: notice.published,
                    content: content.slice(0, 24_000)
                }
            })
        }
    ]
}

function summaryProfileKey(preferences: MessagePreferences, settings: LlmSettings, username: string): string {
    return createHash('sha256').update(JSON.stringify({
        username, preferences, prompt: settings.summaryPrompt,
        baseUrl: settings.baseUrl, model: settings.model
    })).digest('hex')
}

export class NoticeSummaryService {
    readonly queue = new SummaryQueue()
    private pending = new Map<string, Promise<NoticeSummary>>()
    private db: AppDatabase
    private llm: LlmSettingsService
    private readDetail: (notice: NoticeRef) => Promise<NoticeDetail>
    private complete: typeof completeLlm

    constructor(db: AppDatabase, llm: LlmSettingsService,
                readDetail: (notice: NoticeRef) => Promise<NoticeDetail>, complete = completeLlm) {
        this.db = db
        this.llm = llm
        this.readDetail = readDetail
        this.complete = complete
    }

    relevanceFor(notice: Notice): NoticeRelevance | null {
        try {
            const context = this.contextFor(notice)
            return this.effectiveRelevance(notice, context.username,
                normalizeRelevance(this.db.getNoticeSummary(notice.sourceId, notice.url, context.key)?.relevance))
        } catch {
            return null
        }
    }

    needsSummary(ref: NoticeRef): boolean {
        const context = this.context(ref)
        const cached = this.db.getNoticeSummary(ref.sourceId, ref.url, context.key)
        return !this.pending.has(context.job) && (!cached?.summary.trim() || Date.now() - cached.checkedAt >= 86_400_000)
    }

    async summarize(ref: NoticeRef, force = false): Promise<NoticeSummary> {
        const context = this.context(ref)
        const running = this.pending.get(context.job)
        if (running) {
            const result = await running
            if (!force || !result.cached) return result
            if (this.context(ref).job !== context.job) throw new Error('通知或账号设置已变化，请重新生成摘要。')
            return this.summarize(ref, true)
        }
        const request = this.queue.enqueue(context.notice, context.username,
            (signal, stage) => this.generate(ref, context, force, signal, stage))
        this.pending.set(context.job, request)
        try {
            return await request
        } finally {
            this.pending.delete(context.job)
        }
    }

    profile() {
        const account = this.db.getAccount()
        if (!account) throw new Error('请先登录。')
        const checked = validateRequiredMessagePreferences(this.db.getMessagePreferences())
        if (!checked.ok) throw new Error('请先完善消息偏好。')
        const preferences = checked.data
        const settings = this.llm.get()
        return {
            preferences,
            settings,
            username: account.username,
            key: summaryProfileKey(preferences, settings, account.username)
        }
    }

    async detail(ref: NoticeRef) {
        const owner = this.db.getAccount()?.username
        const detail = await this.readDetail(ref)
        if (!owner || this.db.getAccount()?.username !== owner) throw new Error('账号已变化，请重新读取通知。')
        if (!detail.requiresLogin && detail.content.trim() && !detail.attachmentError) {
            this.db.observeNoticeBody(ref, createHash('sha256').update(detail.content.trim()).digest('hex'))
        }
        return detail
    }

    private effectiveRelevance(notice: NoticeRef, username: string, predicted: NoticeRelevance | null): NoticeRelevance | null {
        const choice = this.db.getNoticeRelevanceChoice(username, notice.sourceId, notice.url)
        return choice === null ? predicted : choice === 'none' ? null : choice
    }

    private contextFor(notice: Notice) {
        const profile = this.profile()
        return {
            ...profile,
            notice,
            job: JSON.stringify([profile.key, notice.sourceId, notice.url, notice.title, notice.published])
        }
    }

    private context(ref: NoticeRef) {
        const notice = this.db.getNotice(ref.sourceId, ref.url)
        if (!notice) throw new Error('未找到这条通知，请刷新列表。')
        return this.contextFor(notice)
    }

    private async generate(ref: NoticeRef, context: ReturnType<NoticeSummaryService['context']>, force: boolean, cancelled: AbortSignal,
                           stage: (status: 'reading' | 'generating' | 'saving') => void): Promise<NoticeSummary> {
        const assertCurrent = () => {
            cancelled.throwIfAborted()
            if (this.context(ref).job !== context.job) throw new Error('通知、账号、消息偏好或 LLM 设置已变化，请重新生成摘要。')
        }
        assertCurrent()
        const detail = await this.detail(ref)
        assertCurrent()
        if (detail.requiresLogin) throw new Error('需要登录后才能生成摘要。')
        const content = detail.content.trim()
        if (!content) throw new Error('这条通知没有可摘要的正文，请查看学校原文。')
        const digest = createHash('sha256').update(content).digest('hex')
        if (!detail.attachmentError && this.db.noticeBodyDigest(ref) !== digest) throw new Error('通知正文已变化，请重新生成摘要。')
        const cached = !force && !detail.attachmentError && this.db.getNoticeSummary(ref.sourceId, ref.url, context.key)
        if (cached && cached.summary.trim()) return {
            content: cached.summary, model: cached.model, cached: true,
            relevance: this.effectiveRelevance(ref, context.username, normalizeRelevance(cached.relevance))
        }
        const signal = AbortSignal.any([this.llm.getRequestSignal(), cancelled])
        const connection = await this.llm.getConnection()
        try {
            assertCurrent()
            if (connection.baseUrl !== context.settings.baseUrl || connection.model !== context.settings.model) {
                throw new Error('LLM 设置已变化，请重新生成摘要。')
            }
            const messages = summaryMessages(context.notice, content, context.preferences,
                context.settings.summaryPrompt)
            stage('generating')
            const result = (await this.complete(connection, messages, signal)).trim()
            assertCurrent()
            signal.throwIfAborted()
            if (!detail.attachmentError && this.db.noticeBodyDigest(ref) !== digest) throw new Error('通知正文已变化，请重新生成摘要。')
            if (!result) throw new Error('模型没有返回摘要内容。')
            const output = parseSummaryOutput(result)
            if (!output.content) throw new Error('模型没有返回摘要内容。')
            const summary = output.content.slice(0, 4000)
            stage('saving')
            if (!detail.attachmentError) this.db.saveNoticeSummary(ref.sourceId, ref.url, context.key, connection.model, summary,
                output.relevance ?? '')
            return {
                content: summary,
                relevance: this.effectiveRelevance(ref, context.username, output.relevance),
                model: connection.model,
                cached: false
            }
        } finally {
            connection.apiKey = ''
        }
    }
}
