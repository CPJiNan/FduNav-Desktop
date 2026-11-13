import {ResearchError} from './research-error'

export interface WebSearchResult {
    title: string
    url: string
    snippet: string
    publishedAt: string | null
    truncated: boolean
}

export interface WebSearchResponse {
    query: string
    provider: 'tavily'
    notice: string
    results: WebSearchResult[]
}

export interface WebSearchSettings {
    apiKey: string
    depth: 'basic' | 'advanced'
    maxResults: number
    maxSnippetChars: number
    timeoutSeconds: number
}

const notice = '实际网页搜索结果；日期仅在来源服务提供时展示，检索结果不代表全部资料。'

function webUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value || value.length > 2048) return null
    try {
        const url = new URL(value)
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
    } catch {
        return null
    }
}

export async function searchWeb(settings: WebSearchSettings, query: string,
                                request: typeof fetch = fetch): Promise<WebSearchResponse> {
    const trimmed = query.trim()
    if (!trimmed || trimmed.length > 500) throw new ResearchError('invalid_args', '搜索词须为 1–500 个字符。', 400)
    if (!settings.apiKey) throw new ResearchError('search_not_configured', '请在旦挞设置中填写 Tavily API Key。', 503)
    let response: Response
    try {
        response = await request('https://api.tavily.com/search', {
            method: 'POST', redirect: 'error', cache: 'no-store',
            signal: AbortSignal.timeout(Math.round(settings.timeoutSeconds * 1000)),
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}`},
            body: JSON.stringify({
                query: trimmed, search_depth: settings.depth, topic: 'general',
                max_results: settings.maxResults, include_answer: false, include_raw_content: false,
                include_published_date: true,
            }),
        })
    } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            throw new ResearchError('search_timeout', '搜索超时，请稍后重试。', 504)
        }
        throw new ResearchError('search_unreachable', '无法连接搜索服务，请检查网络后重试。', 502)
    }
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new ResearchError('search_auth_failed', '搜索服务认证失败，请检查 Tavily 密钥与权限。', 502)
        }
        if ([429, 432, 433].includes(response.status)) {
            throw new ResearchError('search_rate_limited', '搜索服务限流或额度不足，请检查服务配额后重试。', 429)
        }
        throw new ResearchError('search_upstream_error', '搜索服务暂时不可用，请稍后重试。', 502)
    }
    let payload: unknown
    try {
        payload = await response.json()
    } catch {
        throw new ResearchError('search_invalid_response', '搜索服务返回了不符合预期的数据。', 502)
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
        throw new ResearchError('search_invalid_response', '搜索服务返回了不符合预期的数据。', 502)
    }
    const seen = new Set<string>()
    const results: WebSearchResult[] = []
    for (const item of (payload as { results: unknown[] }).results) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const title = typeof record.title === 'string' ? record.title.trim() : ''
        const url = webUrl(record.url)
        const content = typeof record.content === 'string' ? record.content : ''
        if (!title || !url || title.length > 500) continue
        if (seen.has(url)) continue
        seen.add(url)
        const limit = settings.maxSnippetChars
        results.push({
            title,
            url,
            snippet: content.slice(0, limit),
            publishedAt: typeof record.published_date === 'string' && record.published_date.length <= 64
                ? record.published_date : null,
            truncated: content.length > limit,
        })
        if (results.length >= settings.maxResults) break
    }
    return {query: trimmed, provider: 'tavily', notice, results}
}
