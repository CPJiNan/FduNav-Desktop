import type {Result} from './accounts'

export const researchSourceModes = ['auto', 'web', 'all'] as const
export type ResearchSourceMode = typeof researchSourceModes[number]

export type ResearchSourceKind = 'web' | 'campus'
export type CampusAuthStatus = 'missing' | 'configured' | 'expired' | 'invalid'

export const researchToolNames = ['search_web', 'read_web', 'search_campus_posts', 'read_campus_thread', 'plan_research'] as const
export type ResearchToolName = typeof researchToolNames[number]

export interface ResearchSource {
    id: string
    source: ResearchSourceKind
    title: string
    url?: string
    snippet: string
    publishedAt: string | null
    truncated: boolean
    pageRead?: boolean
    pageTruncated?: boolean
    redacted?: boolean
    holeId?: number
    floorId?: number
    threadRead?: boolean
}

export interface CampusState {
    status: CampusAuthStatus
    loggedIn: boolean
    email: string | null
}

export interface ResearchSettings {
    searchDepth: 'basic' | 'advanced'
    searchMaxResults: number
    searchMaxSnippetChars: number
    searchTimeoutSeconds: number
    httpTimeoutSeconds: number
    campusMaxContentChars: number
    researchMaxToolCalls: number
    maxCampusPages: number
    requestBudgetSeconds: number
    reviewEnabled: boolean
    hasSearchApiKey: boolean
    campus: CampusState
}

export interface ResearchSettingsInput extends Omit<ResearchSettings, 'hasSearchApiKey' | 'campus'> {
    searchApiKey: string
    clearSearchApiKey: boolean
}

export interface CampusLoginInput {
    email: string
    password: string
}

export interface ResearchAPI {
    get(): Promise<Result<ResearchSettings>>

    save(input: ResearchSettingsInput): Promise<Result<ResearchSettings>>

    login(input: CampusLoginInput): Promise<Result<CampusState>>

    logout(): Promise<Result<CampusState>>
}

export const emptyCampusState = (): CampusState => ({status: 'missing', loggedIn: false, email: null})

export const defaultResearchSettings = (): ResearchSettings => ({
    searchDepth: 'advanced',
    searchMaxResults: 5,
    searchMaxSnippetChars: 2000,
    searchTimeoutSeconds: 15,
    httpTimeoutSeconds: 15,
    campusMaxContentChars: 4000,
    researchMaxToolCalls: 12,
    maxCampusPages: 8,
    requestBudgetSeconds: 300,
    reviewEnabled: true,
    hasSearchApiKey: false,
    campus: emptyCampusState(),
})

export const defaultResearchSettingsInput = (): ResearchSettingsInput => ({
    searchDepth: 'advanced',
    searchMaxResults: 5,
    searchMaxSnippetChars: 2000,
    searchTimeoutSeconds: 15,
    httpTimeoutSeconds: 15,
    campusMaxContentChars: 4000,
    researchMaxToolCalls: 12,
    maxCampusPages: 8,
    requestBudgetSeconds: 300,
    reviewEnabled: true,
    searchApiKey: '',
    clearSearchApiKey: false,
})

export function isResearchSourceMode(value: unknown): value is ResearchSourceMode {
    return typeof value === 'string' && (researchSourceModes as readonly string[]).includes(value)
}

export function isResearchToolName(value: unknown): value is ResearchToolName {
    return typeof value === 'string' && (researchToolNames as readonly string[]).includes(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number, min = 1): value is string {
    return typeof value === 'string' && value.length >= min && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
}

export function isResearchSource(value: unknown): value is ResearchSource {
    if (!isPlainObject(value)) return false
    if (typeof value.id !== 'string' || !/^[WC][1-9][0-9]{0,5}$/.test(value.id)) return false
    if (value.source !== 'web' && value.source !== 'campus') return false
    if (!boundedString(value.title, 500) || !boundedString(value.snippet, 20000, 0)) return false
    if (value.publishedAt !== null && !boundedString(value.publishedAt, 64, 0)) return false
    if (typeof value.truncated !== 'boolean') return false
    if (value.url !== undefined && (!boundedString(value.url, 2048) || !/^https?:\/\//i.test(value.url))) return false
    for (const key of ['pageRead', 'pageTruncated', 'redacted', 'threadRead'] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') return false
    }
    for (const key of ['holeId', 'floorId'] as const) {
        if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)) return false
    }
    if (value.source === 'campus' && (typeof value.holeId !== 'number' || typeof value.floorId !== 'number')) return false
    if (value.source === 'web' && typeof value.url !== 'string') return false
    return true
}

export function readResearchSources(value: unknown): ResearchSource[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    return value.filter(item => {
        if (!isResearchSource(item) || seen.has(item.id)) return false
        seen.add(item.id)
        return true
    })
}

export function nextSourceId(sources: readonly ResearchSource[], kind: ResearchSourceKind): string {
    const prefix = kind === 'web' ? 'W' : 'C'
    let highest = 0
    for (const source of sources) {
        if (source.source !== kind) continue
        const number = Number(source.id.slice(1))
        if (Number.isSafeInteger(number) && number > highest) highest = number
    }
    return `${prefix}${highest + 1}`
}

export function citedSourceIds(text: string): Set<string> {
    return new Set([...text.matchAll(/\[([WwCc][1-9][0-9]{0,5})\]/g)].map(match => match[1].toUpperCase()))
}

export function modelSourceView(source: ResearchSource) {
    const {floorId: _floorId, ...rest} = source
    return source.source === 'campus'
        ? {
            ...rest,
            title: `树洞 #${source.holeId} · 来源 ${source.id}`,
            speakerAndPosition: '未提供楼层顺序或是否楼主；只用来源编号引用'
        }
        : rest
}

function finiteNumber(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function integer(value: unknown, min: number, max: number): value is number {
    return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

export function validateResearchSettings(input: unknown): Result<ResearchSettingsInput> {
    if (!isPlainObject(input)) return {ok: false, error: '调研设置格式无效。'}
    const value = input
    if (value.searchDepth !== 'basic' && value.searchDepth !== 'advanced') return {ok: false, error: '搜索深度无效。'}
    if (!integer(value.searchMaxResults, 1, 10)) return {ok: false, error: '每次搜索结果数须为 1–10 的整数。'}
    if (!integer(value.searchMaxSnippetChars, 100, 10000)) return {
        ok: false,
        error: '网页摘要字数上限须为 100–10000 的整数。'
    }
    if (!finiteNumber(value.searchTimeoutSeconds, 5, 120)) return {ok: false, error: '搜索超时须为 5–120 秒。'}
    if (!finiteNumber(value.httpTimeoutSeconds, 5, 120)) return {ok: false, error: '通用请求超时须为 5–120 秒。'}
    if (!integer(value.campusMaxContentChars, 100, 12000)) return {
        ok: false,
        error: '树洞正文字数上限须为 100–12000 的整数。'
    }
    if (!integer(value.researchMaxToolCalls, 1, 30)) return {ok: false, error: '每轮检索调用上限须为 1–30 的整数。'}
    if (!integer(value.maxCampusPages, 1, 20)) return {ok: false, error: '树洞分页上限须为 1–20 的整数。'}
    if (!finiteNumber(value.requestBudgetSeconds, 30, 600)) return {ok: false, error: '单轮总时限须为 30–600 秒。'}
    if (typeof value.reviewEnabled !== 'boolean') return {ok: false, error: '答案核对开关无效。'}
    if (typeof value.searchApiKey !== 'string' || value.searchApiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(value.searchApiKey)) {
        return {ok: false, error: 'Tavily API Key 设置无效。'}
    }
    if (typeof value.clearSearchApiKey !== 'boolean' || (value.clearSearchApiKey && value.searchApiKey.trim())) {
        return {ok: false, error: 'Tavily API Key 设置无效。'}
    }
    return {
        ok: true, data: {
            searchDepth: value.searchDepth,
            searchMaxResults: value.searchMaxResults,
            searchMaxSnippetChars: value.searchMaxSnippetChars,
            searchTimeoutSeconds: value.searchTimeoutSeconds,
            httpTimeoutSeconds: value.httpTimeoutSeconds,
            campusMaxContentChars: value.campusMaxContentChars,
            researchMaxToolCalls: value.researchMaxToolCalls,
            maxCampusPages: value.maxCampusPages,
            requestBudgetSeconds: value.requestBudgetSeconds,
            reviewEnabled: value.reviewEnabled,
            searchApiKey: value.searchApiKey.trim(),
            clearSearchApiKey: value.clearSearchApiKey,
        }
    }
}

export function validateCampusLogin(input: unknown): Result<{ email: string; password: string }> {
    if (!isPlainObject(input)) return {ok: false, error: '登录参数无效。'}
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length < 3 || email.length > 320) {
        return {ok: false, error: '请输入有效的邮箱。'}
    }
    if (!password || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password)) return {
        ok: false,
        error: '请输入密码。'
    }
    return {ok: true, data: {email, password}}
}

export function validCampusToken(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value)
}

export function readCampusTokens(value: unknown): { access: string; refresh: string; email: string | null } | null {
    if (!isPlainObject(value)) return null
    if (!validCampusToken(value.access) || !validCampusToken(value.refresh)) return null
    const email = typeof value.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) && value.email.length <= 320
        ? value.email : null
    return {access: value.access, refresh: value.refresh, email}
}
