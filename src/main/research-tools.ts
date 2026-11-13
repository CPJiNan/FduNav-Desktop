import type {ChatTool} from './llm-connection'
import {ToolError} from '../shared/agent'
import {defaultToolDescriptions} from '../shared/llm-prompts'
import {
    modelSourceView,
    nextSourceId,
    type ResearchSettings,
    type ResearchSource,
    type ResearchToolName,
    researchToolNames,
} from '../shared/research'
import type {AppDatabase} from './database'
import {CampusBudget, type CampusPost, type CampusResearchService} from './campus-research'
import type {CampusAuthService} from './campus-auth'
import {ResearchError} from './research-error'
import {readWebPage} from './research-reader'
import {parseToolArguments} from './tool-args'
import {searchWeb} from './web-search'

type Fields = Record<string, unknown>
const str = (description: string) => ({type: 'string', description})
const integer = (description: string, minimum: number, maximum: number) =>
    ({type: 'integer', minimum, maximum, description})
const stringList = (description: string) => ({type: 'array', items: {type: 'string'}, maxItems: 5, description})

function tool(name: ResearchToolName, properties: Fields, required: string[] = []): ChatTool {
    return {
        type: 'function',
        function: {
            name,
            description: defaultToolDescriptions[name],
            parameters: {type: 'object', properties, required, additionalProperties: false},
        }
    }
}

export const researchTools: ChatTool[] = [
    tool('search_web', {query: str('检索词，1–500 字；优先一个明确关键词')}, ['query']),
    tool('read_web', {sourceId: str('已检索到的网页来源编号，如 W1')}, ['sourceId']),
    tool('search_campus_posts', {
        query: str('树洞检索词，1–500 字；优先一个明确姓名或主题短词'),
        offset: integer('分页偏移，首次省略', 0, 2_147_483_647),
        limit: integer('每页楼层数，默认 20', 1, 50),
    }, ['query']),
    tool('read_campus_thread', {
        holeId: integer('洞号，来自 search_campus_posts', 1, Number.MAX_SAFE_INTEGER),
        offset: integer('楼层分页偏移，首次省略', 0, 2_147_483_647),
        limit: integer('每页楼层数，默认 20', 1, 50),
    }, ['holeId']),
    tool('plan_research', {
        questions: stringList('待回答的子问题，1–5 条'),
        gaps: stringList('仍缺的证据，最多 5 条'),
        nextAction: {type: 'string', enum: ['search', 'read_context', 'answer', 'clarify'], description: '下一步行动'},
        sources: {
            type: 'array',
            items: {type: 'string', enum: ['web', 'campus']},
            maxItems: 2,
            description: '计划使用的来源'
        },
    }, ['questions', 'nextAction']),
]

const campusAuthCodes = new Set([
    'campus_auth_failed', 'campus_credentials_invalid', 'campus_login_required', 'campus_credentials_write_failed',
])

function toolError(error: unknown): ToolError {
    if (error instanceof ToolError) return error
    if (error instanceof ResearchError) {
        const {code, message} = error
        if (code === 'invalid_args' || code === 'campus_endpoint_forbidden') return new ToolError('invalid_args', message)
        if (code === 'unknown_source' || code === 'campus_not_found' || code === 'page_http_error') return new ToolError('not_found', message)
        if (code.includes('budget')) return new ToolError('budget_exhausted', message)
        if (code.includes('auth') || code.includes('forbidden') || code.includes('login_required') || code.includes('credentials')) {
            return new ToolError('forbidden', message)
        }
        if (code.includes('timeout') || code.includes('unreachable') || code.includes('rate_limited') || code.includes('upstream')) {
            return new ToolError('transient', message)
        }
        return new ToolError('internal', message)
    }
    return new ToolError('internal', error instanceof Error ? error.message : '工具执行失败。')
}

function textArg(input: Fields, key: string, required = false, max = 500): string {
    const value = input[key]
    if (value === undefined) {
        if (required) throw new ToolError('invalid_args', `缺少 ${key}。`)
        return ''
    }
    if (typeof value !== 'string') throw new ToolError('invalid_args', `${key} 必须是字符串。`)
    const text = value.trim()
    if (required && !text) throw new ToolError('invalid_args', `${key} 不能为空。`)
    if (text.length > max) throw new ToolError('invalid_args', `${key} 过长。`)
    return text
}

export interface ResearchToolContext {
    db: AppDatabase
    username: string
    sources: ResearchSource[]
    settings: ResearchSettings
    searchApiKey: string
    auth: CampusAuthService
    campus: CampusResearchService
    campusBudget: CampusBudget
    deadline: number
    assertCurrent: () => void
}

export interface ResearchToolRunner {
    run(name: string, raw: string): Promise<unknown>

    campusAllowed(): boolean

    warnings(): string[]

    remaining(): { calls: number; campusPages: number; seconds: number }
}

export function createResearchToolRunner(context: ResearchToolContext): ResearchToolRunner {
    const {db, username, sources, settings, searchApiKey, campus, campusBudget, deadline, assertCurrent} = context
    const attempted = new Set<string>()
    let calls = 0
    let webAllowed = settings.hasSearchApiKey && !!searchApiKey
    let campusEnabled = settings.campus.loggedIn
    const notices: string[] = []

    function upsert(source: ResearchSource) {
        const index = sources.findIndex(item => item.id === source.id)
        if (index >= 0) sources[index] = source
        else sources.push(source)
        db.saveResearchSource(username, source)
    }

    function campusPostSource(post: CampusPost, read: boolean): ResearchSource {
        const existing = sources.find(item => item.source === 'campus' && item.holeId === post.holeId && item.floorId === post.floorId)
        const source: ResearchSource = {
            id: existing?.id ?? nextSourceId(sources, 'campus'),
            source: 'campus',
            title: `洞号 #${post.holeId} 楼层号 #${post.floorId}`,
            snippet: post.content,
            publishedAt: post.timeCreated,
            truncated: post.truncated,
            redacted: post.redacted,
            holeId: post.holeId,
            floorId: post.floorId,
            ...(read || existing?.threadRead ? {threadRead: true} : {}),
        }
        upsert(source)
        return source
    }

    function stopReason(): string | null {
        if (calls >= settings.researchMaxToolCalls) return `本轮已用完 ${settings.researchMaxToolCalls} 次检索调用，回答基于已取得的资料。`
        if (Date.now() >= deadline) return '本轮检索时间已用完，已停止查找并留出时间整理回答。'
        return null
    }

    function budgetLeft() {
        return {
            remainingCalls: Math.max(0, settings.researchMaxToolCalls - calls),
            remainingCampusPages: Math.max(0, campusBudget.maxPages - campusBudget.pages),
            remainingSeconds: Math.max(0, Math.round((deadline - Date.now()) / 1000)),
        }
    }

    function denyCampus(message: string) {
        if (!notices.includes(message)) notices.push(message)
        campusEnabled = false
    }

    return {
        campusAllowed: () => campusEnabled,
        warnings: () => notices,
        remaining: () => ({
            calls: Math.max(0, settings.researchMaxToolCalls - calls),
            campusPages: Math.max(0, campusBudget.maxPages - campusBudget.pages),
            seconds: Math.max(0, Math.round((deadline - Date.now()) / 1000)),
        }),
        async run(name: string, raw: string): Promise<unknown> {
            assertCurrent()
            const toolName = name as ResearchToolName
            const schema = researchTools.find(item => item.function.name === name)?.function.parameters
            if (!schema) throw new ToolError('forbidden', '不支持的工具。')
            const stop = stopReason()
            if (stop) throw new ToolError('budget_exhausted', stop)
            calls++
            const input = parseToolArguments(schema, raw)
            const signature = `${name}:${JSON.stringify(input, Object.keys(input).sort())}`
            if (attempted.has(signature)) {
                throw new ToolError('invalid_args', '本轮已尝试相同调用，请使用已有结果、换关键词或说明缺口。')
            }
            attempted.add(signature)
            const campusTool = toolName === 'search_campus_posts' || toolName === 'read_campus_thread'
            if (campusTool && !campusEnabled) {
                throw new ToolError('forbidden', '本轮未授权或无法使用树洞，只能使用公开网页。')
            }
            if (!campusTool && toolName !== 'plan_research' && !webAllowed) {
                throw new ToolError('forbidden', '本轮没有可用的网页检索，请先配置 Tavily 或改用已有资料。')
            }
            try {
                if (toolName === 'search_web') {
                    const response = await searchWeb({
                        apiKey: searchApiKey,
                        depth: settings.searchDepth,
                        maxResults: settings.searchMaxResults,
                        maxSnippetChars: settings.searchMaxSnippetChars,
                        timeoutSeconds: settings.searchTimeoutSeconds,
                    }, textArg(input, 'query', true))
                    assertCurrent()
                    const results = response.results.map(item => {
                        const existing = sources.find(source => source.source === 'web' && source.url === item.url)
                        const source: ResearchSource = {
                            id: existing?.id ?? nextSourceId(sources, 'web'),
                            source: 'web', title: item.title, url: item.url, snippet: item.snippet,
                            publishedAt: item.publishedAt, truncated: item.truncated,
                        }
                        upsert(source)
                        return {...source, source: 'web' as const}
                    })
                    return {
                        query: response.query,
                        provider: response.provider,
                        notice: response.notice,
                        results,
                        remainingResearch: budgetLeft()
                    }
                }
                if (toolName === 'read_web') {
                    const sourceId = textArg(input, 'sourceId', true, 20)
                    const source = sources.find(item => item.id === sourceId && item.source === 'web')
                    if (!source) throw new ResearchError('unknown_source', '来源编号不存在，请先搜索。', 404)
                    const page = await readWebPage(source, settings.httpTimeoutSeconds * 1000)
                    assertCurrent()
                    source.pageRead = true
                    source.pageTruncated = page.truncated
                    upsert(source)
                    return {...page, remainingResearch: budgetLeft()}
                }
                if (toolName === 'search_campus_posts') {
                    const page = await campus.searchPosts(username, textArg(input, 'query', true),
                        typeof input.offset === 'number' ? input.offset : 0,
                        typeof input.limit === 'number' ? input.limit : 20, campusBudget)
                    assertCurrent()
                    return {
                        ...page,
                        query: textArg(input, 'query', true),
                        results: page.results.map(post => modelSourceView(campusPostSource(post, false))),
                        remainingCampusPages: Math.max(0, campusBudget.maxPages - campusBudget.pages),
                        remainingResearch: budgetLeft(),
                    }
                }
                if (toolName === 'read_campus_thread') {
                    const page = await campus.readThread(username, input.holeId as number,
                        typeof input.offset === 'number' ? input.offset : 0,
                        typeof input.limit === 'number' ? input.limit : 20, campusBudget)
                    assertCurrent()
                    return {
                        ...page,
                        results: page.results.map(post => modelSourceView(campusPostSource(post, true))),
                        remainingCampusPages: Math.max(0, campusBudget.maxPages - campusBudget.pages),
                        remainingResearch: budgetLeft(),
                    }
                }
                const questions = input.questions as unknown[]
                if (!Array.isArray(questions) || !questions.length || questions.length > 5 ||
                    questions.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) {
                    throw new ToolError('invalid_args', 'questions 须为 1–5 条非空字符串。')
                }
                const gaps = input.gaps === undefined ? [] : input.gaps
                if (!Array.isArray(gaps) || gaps.length > 5 || gaps.some(item => typeof item !== 'string' || item.length > 500)) {
                    throw new ToolError('invalid_args', 'gaps 须为最多 5 条字符串。')
                }
                const planSources = input.sources === undefined ? [] : input.sources
                if (!Array.isArray(planSources) || planSources.some(item => item !== 'web' && item !== 'campus')) {
                    throw new ToolError('invalid_args', 'sources 只允许 web 或 campus。')
                }
                if (planSources.includes('campus') && !campusEnabled) {
                    throw new ToolError('forbidden', '计划包含未授权的树洞来源，请调整为公开网页。')
                }
                return {
                    skill: 'ask-danta-research',
                    plan: {
                        questions: questions.map(item => (item as string).trim()),
                        gaps: (gaps as string[]).map(item => item.trim()),
                        nextAction: input.nextAction,
                        sources: planSources,
                    },
                    remainingCampusPages: Math.max(0, campusBudget.maxPages - campusBudget.pages),
                    remainingResearch: budgetLeft(),
                }
            } catch (error) {
                if (error instanceof ResearchError && campusAuthCodes.has(error.code)) {
                    denyCampus('树洞认证已失效，本轮停止使用树洞，继续使用公开网页并说明限制。')
                }
                throw toolError(error)
            }
        },
    }
}

export function researchToolAllowed(name: string): boolean {
    return (researchToolNames as readonly string[]).includes(name)
}
