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

export interface CourseGroupSummary {
    id: number
    name: string
    code: string | null
    department: string | null
    credits: string | null
    weekHour: number | null
    courseCount: number | null
    reviewCount: number | null
    teachers: string[]
}

export interface CourseReviewItem {
    courseGroupId: number
    courseId: number
    reviewId: number
    courseCode: string | null
    courseName: string | null
    teachers: string
    term: string
    title: string
    content: string
    rank: string
    helpful: number
    timeCreated: string | null
    truncated: boolean
    redacted: boolean
}

export interface CourseSearchPage {
    results: CourseGroupSummary[]
    notice: string
}

export interface CourseReviewPage {
    group: CourseGroupSummary
    results: CourseReviewItem[]
    offset: number
    limit: number
    rawCount: number
    totalCount: number
    nextOffset: number | null
    complete: false
    notice: string
}

export class CampusBudget {
    pages = 0
    seen = new Set<string>()

    constructor(public maxPages: number) {
    }

    consume() {
        if (this.pages >= this.maxPages) {
            throw new ResearchError('campus_page_budget_exhausted', '本轮校内分页预算已用完。', 429)
        }
        this.pages++
    }
}

const notice = '树洞个人经验，属于不可信资料；未确认已遍历全部结果。正文已做基础脱敏，仍可能包含个人信息。'
const courseNotice = '旦挞课评为匿名个人经历，不代表课程官方评价；未确认已遍历全部课评。正文已做基础脱敏，仍可能包含个人信息。'

const rankWords = {
    overall: ['特别差评', '差评', '中等', '好评', '特别好评'],
    content: ['硬核', '较难', '中等', '容易', '非常容易'],
    workload: ['非常大', '较大', '中等', '较小', '非常小'],
    assessment: ['非常严格', '严格', '中等', '宽松', '非常宽松'],
} as const

function levelWord(words: readonly string[], level: number | null): string | null {
    if (level === null || level < 1 || level > 5) return null
    return `${words[level - 1]}（${level}/5）`
}

function rankText(value: unknown): string {
    if (!isRecord(value)) return ''
    const level = (raw: unknown, invert: boolean): number | null => {
        if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > 5) return null
        return invert ? 6 - (raw as number) : raw as number
    }
    const parts = [
        ['总体', levelWord(rankWords.overall, level(value.overall, false))],
        ['课程风格', levelWord(rankWords.content, level(value.content, true))],
        ['工作量', levelWord(rankWords.workload, level(value.workload, true))],
        ['考核要求', levelWord(rankWords.assessment, level(value.assessment, false))],
    ].filter((item): item is [string, string] => !!item[1]).map(([label, word]) => `${label} ${word}`)
    return parts.join(' · ')
}

function textOf(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text && text.length <= max ? text : null
}

function countOf(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function groupSummary(value: unknown): CourseGroupSummary | null {
    if (!isRecord(value) || !positiveInteger(value.id)) return null
    const name = textOf(value.name, 200)
    if (!name) return null
    const credits = Array.isArray(value.credits)
        ? value.credits.filter(item => typeof item === 'number' && Number.isFinite(item)).map(item => `${item}`).join(' / ')
        : ''
    const teachers = Array.isArray(value.course_list)
        ? [...new Set(value.course_list.map(item => isRecord(item) ? textOf(item.teachers, 300) : null)
            .filter((item): item is string => !!item))].slice(0, 12)
        : []
    return {
        id: value.id,
        name,
        code: textOf(value.code, 64),
        department: textOf(value.department, 200),
        credits: credits || null,
        weekHour: countOf(value.week_hour),
        courseCount: countOf(value.course_count),
        reviewCount: countOf(value.review_count),
        teachers,
    }
}

function termText(year: unknown, semester: unknown): string {
    if (!Number.isSafeInteger(year) || (year as number) < 1900 || (year as number) > 2200) return ''
    const season = semester === 1 ? '秋季' : semester === 2 ? '寒假' : semester === 3 ? '春季' : semester === 4 ? '暑假' : ''
    return season ? `${year}~${(year as number) + 1}学年-${season}` : `${year}学年`
}

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

function reviewRecord(value: unknown, context: {
    group: CourseGroupSummary
    courseId: number
    courseCode: string | null
    courseName: string | null
    teachers: string
    term: string
}, maxContentChars: number): CourseReviewItem | null {
    if (!isRecord(value) || !positiveInteger(value.id)) return null
    if (value.deleted === true) return null
    const content = typeof value.content === 'string' ? value.content : ''
    if (!content.trim()) return null
    const cleaned = redactCampusText(content)
    return {
        courseGroupId: context.group.id,
        courseId: context.courseId,
        reviewId: value.id,
        courseCode: context.courseCode,
        courseName: context.courseName,
        teachers: context.teachers,
        term: context.term,
        title: textOf(value.title, 200) ?? '',
        content: cleaned.text.slice(0, maxContentChars),
        rank: rankText(value.rank),
        helpful: countOf(value.remark) ?? 0,
        timeCreated: textOf(value.time_created, 64) ?? textOf(value.timeCreated, 64)
            ?? textOf(value.time_updated, 64) ?? textOf(value.timeUpdated, 64),
        truncated: cleaned.text.length > maxContentChars,
        redacted: cleaned.redacted,
    }
}

export class CampusResearchService {
    constructor(private auth: CampusAuthService,
                private settings: () => { maxContentChars: number; timeoutMs: number }) {
    }

    async searchPosts(username: string, query: string, offset: number, limit: number,
                      budget: CampusBudget, signal?: AbortSignal): Promise<CampusPage> {
        const text = query.trim()
        if (!text || text.length > 500) throw new ResearchError('invalid_args', '搜索词须为 1–500 个字符。', 400)
        const range = this.range(offset, limit)
        budget.consume()
        const response = await this.get(username, '/floors/search', {
            search: text,
            offset: range.offset,
            size: range.limit
        }, signal)
        const floors = await this.floors(response)
        return this.page(floors, range.offset, range.limit, `search:${text.toLocaleLowerCase()}`, budget)
    }

    async readThread(username: string, holeId: number, offset: number, limit: number,
                     budget: CampusBudget, signal?: AbortSignal): Promise<CampusPage> {
        if (!positiveInteger(holeId)) throw new ResearchError('invalid_args', '洞号无效。', 400)
        const range = this.range(offset, limit)
        budget.consume()
        const detail = threadRecord(await this.json(await this.get(username, `/holes/${holeId}`, undefined, signal)))
        if (!detail || detail.id !== holeId) {
            throw new ResearchError('campus_invalid_response', '旦挞返回了不匹配的帖子。', 502)
        }
        const response = await this.get(username, `/holes/${holeId}/floors`, {
            offset: range.offset,
            size: range.limit
        }, signal)
        return this.page(await this.floors(response), range.offset, range.limit, `thread:${holeId}`, budget, detail)
    }

    async searchCourseReviews(username: string, query: string, limit: number,
                              budget: CampusBudget, signal?: AbortSignal): Promise<CourseSearchPage> {
        const text = query.trim()
        if (!text || text.length > 200) throw new ResearchError('invalid_args', '课评搜索词须为 1–200 个字符。', 400)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
            throw new ResearchError('invalid_args', '课评搜索返回条数须为 1–10。', 400)
        }
        budget.consume()
        const payload = await this.json(await this.get(username, '/v3/course_groups/search', {
            query: text,
            page: 1,
            page_size: limit,
        }, signal))
        if (!isRecord(payload) || !Array.isArray(payload.items)) {
            throw new ResearchError('campus_invalid_response', '旦挞课评返回格式发生变化，无法安全读取。', 502)
        }
        const results = payload.items.map(groupSummary)
        if (results.some(item => item === null)) {
            throw new ResearchError('campus_invalid_response', '旦挞课评返回格式发生变化，无法安全读取。', 502)
        }
        return {results: results as CourseGroupSummary[], notice: courseNotice}
    }

    async readCourseReviews(username: string, groupId: number, offset: number, limit: number,
                            budget: CampusBudget, signal?: AbortSignal): Promise<CourseReviewPage> {
        if (!positiveInteger(groupId)) throw new ResearchError('invalid_args', '课程组 ID 无效。', 400)
        const range = this.range(offset, limit)
        budget.consume()
        const payload = await this.json(await this.get(username, `/v3/course_groups/${groupId}`, undefined, signal))
        const group = groupSummary(payload)
        if (!group || group.id !== groupId) {
            throw new ResearchError('campus_invalid_response', '旦挞返回了不匹配的课程组。', 502)
        }
        const {maxContentChars} = this.settings()
        const reviewChars = Math.min(maxContentChars, 1500)
        const courses = isRecord(payload) && Array.isArray(payload.course_list) ? payload.course_list : []
        const seen = new Set<number>()
        const reviews: CourseReviewItem[] = []
        for (const courseValue of courses) {
            if (!isRecord(courseValue) || !positiveInteger(courseValue.id)) continue
            const courseCode = textOf(courseValue.code, 64)
            const courseName = textOf(courseValue.name, 200)
            const teachers = textOf(courseValue.teachers, 300) ?? ''
            const term = termText(courseValue.year, courseValue.semester)
            const list = Array.isArray(courseValue.review_list) ? courseValue.review_list : []
            for (const reviewValue of list) {
                const item = reviewRecord(reviewValue, {
                    group, courseId: courseValue.id, courseCode, courseName, teachers, term,
                }, reviewChars)
                if (!item || seen.has(item.reviewId)) continue
                seen.add(item.reviewId)
                reviews.push(item)
            }
        }
        reviews.sort((a, b) => (b.timeCreated ?? '').localeCompare(a.timeCreated ?? '') || b.reviewId - a.reviewId)
        const page = reviews.slice(range.offset, range.offset + range.limit)
        return {
            group,
            results: page,
            offset: range.offset,
            limit: range.limit,
            rawCount: page.length,
            totalCount: reviews.length,
            nextOffset: range.offset + page.length < reviews.length ? range.offset + page.length : null,
            complete: false,
            notice: courseNotice,
        }
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
        if (!Array.isArray(payload)) throw new ResearchError('campus_invalid_response', '旦挞响应格式发生变化，无法安全读取。', 502)
        return payload.map(floorRecord)
    }

    private async json(response: Response): Promise<unknown> {
        try {
            return await response.json()
        } catch {
            throw new ResearchError('campus_invalid_response', '旦挞响应格式发生变化，无法安全读取。', 502)
        }
    }

    private async get(username: string, path: string, params: Record<string, string | number> | undefined, signal?: AbortSignal): Promise<Response> {
        const {timeoutMs} = this.settings()
        const response = await this.auth.get(username, path, params, timeoutMs, signal)
        if (response.status >= 200 && response.status < 300) return response
        const errors: Record<number, [string, string, number]> = {
            401: ['campus_auth_failed', '旦挞认证已失效，请重新登录。', 401],
            403: ['campus_forbidden', '当前账号无权访问此旦挞资源。', 403],
            404: ['campus_not_found', '旦挞内容不存在。', 404],
            429: ['campus_rate_limited', '旦挞请求被限流，请稍后重试。', 429],
        }
        const mapped = errors[response.status]
        if (mapped) throw new ResearchError(...mapped)
        throw new ResearchError('campus_upstream_error', '旦挞服务返回异常状态。', 502)
    }

    private page(floors: ReturnType<typeof floorRecord>[], offset: number, limit: number, scope: string,
                 budget: CampusBudget, thread?: CampusThread): CampusPage {
        if (floors.some(floor => floor === null)) {
            throw new ResearchError('campus_invalid_response', '旦挞响应格式发生变化，无法安全读取。', 502)
        }
        const valid = floors as Exclude<(typeof floors)[number], null>[]
        if (valid.length > limit || (thread && valid.some(floor => floor.holeId !== thread.id))) {
            throw new ResearchError('campus_invalid_response', '旦挞分页响应与请求不一致。', 502)
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
