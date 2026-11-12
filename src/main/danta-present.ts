import {
    academicTerm,
    type CampusPage, type CampusPost, type CourseGroupSummary, type CourseOffering,
    type CourseSearchPage, type CourseReviewsResult, type CourseGroupDetail
} from '../shared/danta'

/**
 * 工具输出的压缩与清洗：网页侧继续用完整的 CampusPage / CourseSearchPage，
 * 这里只决定「模型看到什么」。原则是保留判断相关性所需的最小信息：
 * 去掉内部 ID、重复字段与恒为 null 的字段，时间统一成北京时间，正文按条截断。
 */

/** 单条帖子正文上限。模型只需要判断相关性，不需要全文。 */
export const presentedPostChars = 600
/** 单条课评正文上限。 */
export const presentedReviewChars = 600
/** 单次工具输出的字符预算，超出后丢弃尾部并显式告知模型。 */
export const presentedBudget = 6000

const timeFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})

/** ISO 时间 → 「2026-11-11 19:07」（北京时间）。解析失败返回 null，不抛错。 */
export function presentTime(value: string | null | undefined): string | null {
    if (!value) return null
    const stamp = Date.parse(value)
    if (!Number.isFinite(stamp)) return null
    const parts = timeFormat.formatToParts(new Date(stamp))
    const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '00'
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

/** 正文里的 dx 贴纸是 markdown 占位符，对模型没有语义，先剔除再压缩空白。 */
const dxSticker = /!\[\]\(dx_[a-z0-9_]+\)/g

function clip(text: string, max: number): {text: string; clipped: boolean} {
    const trimmed = text.replace(dxSticker, '').replace(/\s+/g, ' ').trim()
    if (trimmed.length <= max) return {text: trimmed, clipped: false}
    return {text: `${trimmed.slice(0, max)}…`, clipped: true}
}

export interface PresentedCampusPost {
    /** 本次工具调用内的稳定短引用（T1、T2…），回答引用它，不要另编编号。 */
    ref: string
    holeId: number
    /** 命中楼层的原始 ID：回答里被引用的片段要能靠它定位到确切楼层。 */
    floorId: number
    content: string
    time: string | null
    truncated?: boolean
}

export interface PresentedCampusPage {
    posts: PresentedCampusPost[]
    /** 续读位置：按「已交付条数」计算，不按服务端原始条数，避免跳过未展示的条目。 */
    nextOffset: number | null
    complete: boolean
    notice: string
    thread?: {id: number; replies: number | null; time: string | null}
    /** 本次交付覆盖情况：服务端原始条数与本工具实际交付条数。 */
    coverage?: {raw: number; returned: number}
    /** 因为预算被裁掉尾部、或上游已标记截断时为 true。 */
    truncated?: boolean
    note?: string
}

function presentPost(post: CampusPost, index: number): PresentedCampusPost {
    const body = clip(post.content, presentedPostChars)
    const result: PresentedCampusPost = {
        ref: `T${index + 1}`, holeId: post.holeId, floorId: post.floorId,
        content: body.text, time: presentTime(post.timeCreated)
    }
    if (body.clipped || post.truncated) result.truncated = true
    return result
}

/** 在字符预算内尽量多保留帖子；任何裁剪都要在返回值里说清楚。 */
export function presentCampusPage(page: CampusPage): PresentedCampusPage {
    const posts: PresentedCampusPost[] = []
    let used = 0
    let dropped = 0
    for (const [index, post] of page.results.entries()) {
        const item = presentPost(post, index)
        const size = JSON.stringify(item).length
        if (posts.length && used + size > presentedBudget) {
            dropped = page.results.length - posts.length
            break
        }
        posts.push(item)
        used += size
    }
    // 服务端的 nextOffset 按原始条数推进；一旦本层丢了尾部，就必须按已交付条数回退，
    // 否则模型照它继续读会跳过被丢弃的那几条（评审 T01）。
    const nextOffset = dropped > 0 ? page.offset + posts.length : page.nextOffset
    const result: PresentedCampusPage = {
        posts, nextOffset, complete: page.complete && dropped === 0, notice: page.notice,
        coverage: {raw: page.rawCount, returned: posts.length}
    }
    if (page.thread) {
        result.thread = {id: page.thread.id, replies: page.thread.reply, time: presentTime(page.thread.timeCreated)}
    }
    if (dropped > 0) {
        result.truncated = true
        result.note = `为控制长度省略了 ${dropped} 条结果；nextOffset 已按实际交付条数回退，可据此继续读取。`
        result.complete = false
    }
    return result
}

export interface PresentedCourseGroup {
    id: number
    name: string
    code: string
    department: string
    reviewCount: number
    weekHour?: number
}

function presentGroup(group: CourseGroupSummary): PresentedCourseGroup {
    const result: PresentedCourseGroup = {
        id: group.id, name: group.name, code: group.code, department: group.department, reviewCount: group.reviewCount
    }
    if (group.weekHour != null) result.weekHour = group.weekHour
    return result
}

export interface PresentedOffering {
    id: number
    name: string
    teachers: string
    term: string
    credit: number | null
    reviewCount: number
}

function presentOffering(course: CourseOffering): PresentedOffering {
    return {
        id: course.id, name: course.name, teachers: course.teachers,
        term: academicTerm(course.year, course.semester), credit: course.credit, reviewCount: course.reviewCount
    }
}

export interface PresentedCourseSearch {
    groups: PresentedCourseGroup[]
    page: number
    hasTotal: boolean
    total: number | null
    note?: string
}

export function presentCourseSearch(page: CourseSearchPage): PresentedCourseSearch {
    const result: PresentedCourseSearch = {
        groups: page.items.map(presentGroup), page: page.page,
        hasTotal: page.total != null, total: page.total
    }
    if (page.total == null) result.note = '接口未返回总数，翻页直到返回空列表为止。'
    return result
}

export interface PresentedCourseGroupDetail {
    group: PresentedCourseGroup
    offerings: PresentedOffering[]
    note?: string
}

/** 课程组详情：把「组 ID」和「开课 ID」放在同一份结果里，避免模型把两者混用。 */
export function presentCourseGroup(detail: CourseGroupDetail): PresentedCourseGroupDetail {
    const result: PresentedCourseGroupDetail = {
        group: presentGroup(detail),
        offerings: detail.courses.map(presentOffering),
    }
    if (!result.offerings.length) result.note = '该课程组没有可用的开课记录，无法读取课评。'
    return result
}

export interface PresentedReview {
    /** 本次工具调用内的稳定短引用（R1、R2…）。 */
    ref: string
    /** 课评原始 ID：引用要能反查到具体一条。 */
    id: number
    title: string
    content: string
    time: string | null
    vote: number
    truncated?: boolean
}

export interface PresentedReviews {
    course: PresentedOffering
    reviews: PresentedReview[]
    coverage?: {raw: number; returned: number}
    truncated?: boolean
    note?: string
}

export function presentCourseReviews(result: CourseReviewsResult): PresentedReviews {
    const reviews: PresentedReview[] = []
    let used = 0
    let dropped = 0
    for (const [index, review] of result.reviews.entries()) {
        const body = clip(review.content, presentedReviewChars)
        const item: PresentedReview = {
            ref: `R${index + 1}`, id: review.id,
            title: review.title, content: body.text, time: presentTime(review.timeCreated), vote: review.vote
        }
        if (body.clipped || review.truncated) item.truncated = true
        const size = JSON.stringify(item).length
        if (reviews.length && used + size > presentedBudget) {
            dropped = result.reviews.length - reviews.length
            break
        }
        reviews.push(item)
        used += size
    }
    const presented: PresentedReviews = {
        course: presentOffering(result.course), reviews,
        coverage: {raw: result.reviews.length, returned: reviews.length}
    }
    const notes: string[] = []
    if (dropped > 0) notes.push(`为控制长度省略了 ${dropped} 条课评`)
    // 上游（服务端）已截断时必须继续向下传播，不能因为本层没再裁剪就当作完整（评审 T05）。
    if (result.truncated) notes.push('服务端已标记该开课的课评不完整')
    if (notes.length) {
        presented.truncated = true
        presented.note = `${notes.join('；')}。可用同一 courseId 分段继续读取，或查看该课程的其他开课。`
    }
    return presented
}
