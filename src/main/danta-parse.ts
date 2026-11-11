import {
    type CampusHolePost,
    type CampusPost,
    type CampusThreadMeta,
    type CourseGroupDetail,
    type CourseGroupSummary,
    type CourseOffering,
    type CourseReviewItem,
} from '../shared/danta'

export type DantaErrorCode =
    | 'schema'
    | 'invalid_input'
    | 'login_required'
    | 'school_login_required'
    | 'auth'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'network'
    | 'timeout'
    | 'too_large'
    | 'unavailable'

export class DantaError extends Error {
    constructor(public code: DantaErrorCode, message: string, public status?: number) {
        super(message)
        this.name = 'DantaError'
    }
}

/** 单条正文上限：进入页面的文本与进入模型的文本都受此约束。 */
export const maxPostChars = 1200
export const maxReviewChars = 3000

const emailPattern = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g
const phonePattern = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g

export function redactPersonal(text: string): {text: string; redacted: boolean} {
    const cleaned = text.replace(emailPattern, '[邮箱已隐藏]').replace(phonePattern, '[手机号已隐藏]')
    return {text: cleaned, redacted: cleaned !== text}
}

export const schemaError = () => new DantaError('schema', '社区服务返回的数据格式发生变化，已停止解析。')

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
const positive = (value: unknown): number | null =>
    Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const time = (value: unknown): string | null => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null

export function parseThreadMeta(value: unknown, holeId: number): CampusThreadMeta {
    const thread = object(value)
    const id = positive(thread.id)
    if (id !== holeId) throw schemaError()
    const created = time(thread.time_created)
    if (!created) throw schemaError()
    const reply = thread.reply === undefined || thread.reply === null ? null
        : Number.isSafeInteger(thread.reply) && (thread.reply as number) >= 0 ? thread.reply as number : null
    return {id, timeCreated: created, timeUpdated: time(thread.time_updated), reply}
}

export function parseCampusPosts(value: unknown, options: {limit: number; holeId?: number}): CampusPost[] {
    if (!Array.isArray(value) || value.length > options.limit) throw schemaError()
    const posts: CampusPost[] = []
    for (const entry of value) {
        const floor = object(entry)
        const id = positive(floor.id), holeId = positive(floor.hole_id)
        if (!id || !holeId || (options.holeId !== undefined && holeId !== options.holeId)) throw schemaError()
        if (floor.deleted === true) continue
        if (typeof floor.content !== 'string') throw schemaError()
        const created = time(floor.time_created)
        if (!created) throw schemaError()
        const redacted = redactPersonal(floor.content)
        posts.push({
            holeId,
            floorId: id,
            content: redacted.text.slice(0, maxPostChars),
            timeCreated: created,
            timeUpdated: time(floor.time_updated),
            truncated: redacted.text.length > maxPostChars,
            redacted: redacted.redacted,
        })
    }
    return posts
}

const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

function parseTagNames(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const names: string[] = []
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const name = (entry as Record<string, unknown>).name
        if (typeof name === 'string' && name) names.push(name)
    }
    return names
}

/**
 * 解析 /api/holes 与 /api/holes/_homepage 返回的帖子列表（每条是一个帖子，不是楼层）。
 * 正文字段在 floors.first_floor.content 内，隐藏、冻结、已删除或空正文的帖子会被跳过。
 */
export function parseCampusHoles(value: unknown, options: {limit: number}): CampusHolePost[] {
    if (!Array.isArray(value)) throw schemaError()
    const posts: CampusHolePost[] = []
    for (const entry of value) {
        if (posts.length >= options.limit) break
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw schemaError()
        const hole = entry as Record<string, unknown>
        const holeId = positive(hole.hole_id) ?? positive(hole.id)
        if (!holeId) throw schemaError()
        if (hole.hidden === true || hole.frozen === true) continue
        if (hole.floors === null || typeof hole.floors !== 'object' || Array.isArray(hole.floors)) throw schemaError()
        const first = (hole.floors as Record<string, unknown>).first_floor
        if (first === null || typeof first !== 'object' || Array.isArray(first)) throw schemaError()
        const floor = first as Record<string, unknown>
        if (floor.deleted === true) continue
        if (typeof floor.content !== 'string' || !floor.content.trim()) continue
        const created = time(floor.time_created) ?? time(hole.time_created)
        if (!created) throw schemaError()
        const redacted = redactPersonal(floor.content)
        posts.push({
            holeId,
            floorId: positive(floor.floor_id) ?? holeId,
            content: redacted.text.slice(0, maxPostChars),
            timeCreated: created,
            reply: numberOrNull(hole.reply),
            view: numberOrNull(hole.view),
            tags: parseTagNames(hole.tags),
            truncated: redacted.text.length > maxPostChars,
            redacted: redacted.redacted,
        })
    }
    return posts
}

function parseCredits(value: unknown): number[] {
    if (!Array.isArray(value)) return []
    if (value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw schemaError()
    return value.map(item => item as number)
}

function parseGroup(value: unknown): CourseGroupSummary {
    const group = object(value)
    const id = positive(group.id)
    const name = text(group.name)
    if (!id || !name) throw schemaError()
    return {
        id,
        name,
        code: text(group.code),
        department: text(group.department),
        weekHour: numberOrNull(group.week_hour),
        credits: parseCredits(group.credits),
        courseCount: Number.isSafeInteger(group.course_count) ? group.course_count as number : 0,
        reviewCount: Number.isSafeInteger(group.review_count) ? group.review_count as number : 0,
    }
}

function parseCourse(value: unknown): CourseOffering {
    const course = object(value)
    const id = positive(course.id)
    if (!id) throw schemaError()
    // 接口只在有课评时才给 review_list；缺失或 null 等价于 0 条（实测与 /courses/{id}/reviews 一致）。
    const reviewList = Array.isArray(course.review_list) ? course.review_list : []
    return {
        id,
        name: text(course.name),
        code: text(course.code),
        codeId: text(course.code_id) || null,
        credit: numberOrNull(course.credit),
        department: text(course.department),
        teachers: text(course.teachers),
        year: Number.isSafeInteger(course.year) ? course.year as number : null,
        semester: Number.isSafeInteger(course.semester) ? course.semester as number : null,
        reviewCount: reviewList.length,
    }
}

export function parseCourseGroups(value: unknown, pageSize: number): {items: CourseGroupSummary[]; total: number | null} {
    const payload = object(value)
    const items = payload.items
    if (!Array.isArray(items) || items.length > pageSize) throw schemaError()
    const total = Number.isSafeInteger(payload.total) ? payload.total as number : null
    return {items: items.map(parseGroup), total}
}

export function parseCourseGroup(value: unknown): CourseGroupDetail {
    const group = object(value)
    const summary = parseGroup(group)
    const list = group.course_list
    if (!Array.isArray(list)) throw schemaError()
    const courses = list.map(parseCourse)
    return {...summary, courseCount: summary.courseCount || courses.length, courses}
}

export function parseReviews(value: unknown, limit: number): {reviews: CourseReviewItem[]; truncated: boolean} {
    if (!Array.isArray(value) || value.length > limit) throw schemaError()
    const reviews: CourseReviewItem[] = []
    let truncated = false
    for (const entry of value) {
        const review = object(entry)
        const id = positive(review.id)
        if (!id) throw schemaError()
        if (review.deleted === true) continue
        if (typeof review.content !== 'string') throw schemaError()
        const redacted = redactPersonal(review.content)
        const content = redacted.text.slice(0, maxReviewChars)
        if (redacted.text.length > maxReviewChars) truncated = true
        reviews.push({
            id,
            title: text(review.title),
            content,
            timeCreated: time(review.time_created),
            vote: Number.isSafeInteger(review.vote) ? review.vote as number : 0,
            truncated: redacted.text.length > maxReviewChars,
            redacted: redacted.redacted,
        })
    }
    return {reviews, truncated}
}

/** 裸数组没有权威的 hasMore / 总数：只有满页才给出 nextOffset，永不宣称已遍历全部。 */
export function nextOffsetFor(offset: number, limit: number, length: number): number | null {
    return length === limit ? offset + length : null
}
