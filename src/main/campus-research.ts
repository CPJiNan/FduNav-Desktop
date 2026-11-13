import type {CampusAuthService} from './campus-auth'
import {ResearchError} from './research-error'

export interface CampusPost {
    holeId: number
    floorId: number
    content: string
    timeCreated: string
    timeUpdated: string | null
    truncated: boolean
    redacted: boolean
}

export interface CampusThread {
    id: number
    timeCreated: string
    timeUpdated: string | null
    reply: number | null
}

export interface CampusPage {
    results: CampusPost[]
    offset: number
    limit: number
    rawCount: number
    nextOffset: number | null
    complete: false
    notice: string
    thread?: CampusThread
}

export class CampusBudget {
    pages = 0
    seen = new Set<string>()

    constructor(public maxPages: number) {
    }

    consume() {
        if (this.pages >= this.maxPages) {
            throw new ResearchError('campus_page_budget_exhausted', '本轮树洞分页预算已用完。', 429)
        }
        this.pages++
    }
}

const notice = '树洞个人经验，属于不可信资料；未确认已遍历全部结果。正文已做基础脱敏，仍可能包含个人信息。'

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown, max = 9_223_372_036_854_775_807): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
}

function timeText(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 64 || !value.trim()) return null
    return value
}

function optionalTime(value: unknown): string | null {
    if (value === undefined || value === null) return null
    return timeText(value)
}

function floorRecord(value: unknown): {
    holeId: number;
    floorId: number;
    content: string;
    timeCreated: string;
    timeUpdated: string | null;
    deleted: boolean
} | null {
    if (!isRecord(value)) return null
    const holeId = value.hole_id
    const floorId = value.id
    const content = value.content
    const created = timeText(value.time_created)
    const updated = optionalTime(value.time_updated)
    if (!positiveInteger(holeId) || !positiveInteger(floorId)) return null
    if (typeof content !== 'string' || content.length > 200_000) return null
    if (!created) return null
    if (value.time_updated !== undefined && value.time_updated !== null && !updated) return null
    if (value.deleted !== undefined && typeof value.deleted !== 'boolean') return null
    return {holeId, floorId, content, timeCreated: created, timeUpdated: updated, deleted: value.deleted === true}
}

function threadRecord(value: unknown): CampusThread | null {
    if (!isRecord(value) || !positiveInteger(value.id)) return null
    const created = timeText(value.time_created)
    const updated = optionalTime(value.time_updated)
    if (!created) return null
    if (value.reply !== undefined && value.reply !== null && (!Number.isSafeInteger(value.reply) || (value.reply as number) < 0)) return null
    return {
        id: value.id,
        timeCreated: created,
        timeUpdated: updated,
        reply: value.reply === undefined ? null : value.reply as number | null
    }
}

export function redactCampusText(text: string): { text: string; redacted: boolean } {
    let cleaned = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    cleaned = cleaned.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    return {text: cleaned, redacted: cleaned !== text}
}

export class CampusResearchService {
    constructor(private auth: CampusAuthService,
                private settings: () => { maxContentChars: number; timeoutMs: number }) {
    }

    async searchPosts(username: string, query: string, offset: number, limit: number,
                      budget: CampusBudget): Promise<CampusPage> {
        const text = query.trim()
        if (!text || text.length > 500) throw new ResearchError('invalid_args', '搜索词须为 1–500 个字符。', 400)
        const range = this.range(offset, limit)
        budget.consume()
        const response = await this.get(username, '/floors/search', {
            search: text,
            offset: range.offset,
            size: range.limit
        })
        const floors = await this.floors(response)
        return this.page(floors, range.offset, range.limit, `search:${text.toLocaleLowerCase()}`, budget)
    }

    async readThread(username: string, holeId: number, offset: number, limit: number,
                     budget: CampusBudget): Promise<CampusPage> {
        if (!positiveInteger(holeId)) throw new ResearchError('invalid_args', '洞号无效。', 400)
        const range = this.range(offset, limit)
        budget.consume()
        const detail = threadRecord(await this.json(await this.get(username, `/holes/${holeId}`, undefined)))
        if (!detail || detail.id !== holeId) {
            throw new ResearchError('campus_invalid_response', '树洞返回了不匹配的帖子。', 502)
        }
        const response = await this.get(username, `/holes/${holeId}/floors`, {offset: range.offset, size: range.limit})
        return this.page(await this.floors(response), range.offset, range.limit, `thread:${holeId}`, budget, detail)
    }

    private range(offset: number, limit: number) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647) {
            throw new ResearchError('invalid_args', '分页偏移无效。', 400)
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
            throw new ResearchError('invalid_args', '每页条数须为 1–50。', 400)
        }
        return {offset, limit}
    }

    private async floors(response: Response): Promise<ReturnType<typeof floorRecord>[]> {
        const payload = await this.json(response)
        if (!Array.isArray(payload)) throw new ResearchError('campus_invalid_response', '树洞响应格式发生变化，无法安全读取。', 502)
        return payload.map(floorRecord)
    }

    private async json(response: Response): Promise<unknown> {
        try {
            return await response.json()
        } catch {
            throw new ResearchError('campus_invalid_response', '树洞响应格式发生变化，无法安全读取。', 502)
        }
    }

    private async get(username: string, path: string, params?: Record<string, string | number>): Promise<Response> {
        const {timeoutMs} = this.settings()
        const response = await this.auth.get(username, path, params, timeoutMs)
        if (response.status >= 200 && response.status < 300) return response
        const errors: Record<number, [string, string, number]> = {
            401: ['campus_auth_failed', '树洞认证已失效，请重新登录。', 401],
            403: ['campus_forbidden', '当前账号无权访问此树洞资源。', 403],
            404: ['campus_not_found', '树洞帖子或资源不存在。', 404],
            429: ['campus_rate_limited', '树洞请求被限流，请稍后重试。', 429],
        }
        const mapped = errors[response.status]
        if (mapped) throw new ResearchError(...mapped)
        throw new ResearchError('campus_upstream_error', '树洞服务返回异常状态。', 502)
    }

    private page(floors: ReturnType<typeof floorRecord>[], offset: number, limit: number, scope: string,
                 budget: CampusBudget, thread?: CampusThread): CampusPage {
        if (floors.some(floor => floor === null)) {
            throw new ResearchError('campus_invalid_response', '树洞响应格式发生变化，无法安全读取。', 502)
        }
        const valid = floors as Exclude<(typeof floors)[number], null>[]
        if (valid.length > limit || (thread && valid.some(floor => floor.holeId !== thread.id))) {
            throw new ResearchError('campus_invalid_response', '树洞分页响应与请求不一致。', 502)
        }
        const {maxContentChars} = this.settings()
        const results: CampusPost[] = []
        for (const floor of valid) {
            const key = `${scope}:${floor.holeId}:${floor.floorId}`
            if (budget.seen.has(key) || floor.deleted) continue
            budget.seen.add(key)
            const cleaned = redactCampusText(floor.content)
            results.push({
                holeId: floor.holeId,
                floorId: floor.floorId,
                content: cleaned.text.slice(0, maxContentChars),
                timeCreated: floor.timeCreated,
                timeUpdated: floor.timeUpdated,
                truncated: cleaned.text.length > maxContentChars,
                redacted: cleaned.redacted,
            })
        }
        return {
            results, offset, limit, rawCount: valid.length,
            nextOffset: valid.length === limit ? offset + valid.length : null,
            complete: false, notice, ...(thread ? {thread} : {}),
        }
    }
}
