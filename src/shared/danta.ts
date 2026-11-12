import type {Result} from './accounts'

/** 学校 WebVPN 通路状态与社区账号状态是两件事，不能互相替代。 */
export type SchoolNetworkState = 'unknown' | 'checking' | 'ready' | 'login-required' | 'unavailable'
export type CommunityAccountState = 'signed-out' | 'connected' | 'expired'

/**
 * 到达社区域名的方式：direct 直连 *.fduhole.com（校内网或能直连的环境），
 * webvpn 经学校 WebVPN 转发。直连优先，探测失败才退回 WebVPN。
 */
export type CommunityTransport = 'unknown' | 'direct' | 'webvpn'

/**
 * 直连探测失败的具体原因。区分它们是为了给用户可执行的建议：
 * gateway 是校园网/企业网关拦截，tls 是握手被打断，timeout 是目标无响应，network 是解析或建连失败。
 */
export type CommunityTransportIssue = 'gateway' | 'tls' | 'timeout' | 'network'

export interface DantaStatus {
    school: SchoolNetworkState
    /** 当前实际使用的通路；unknown 表示还没检测过。 */
    transport: CommunityTransport
    /** 最近一次直连探测失败的原因；直连成功时为 null。 */
    transportIssue: CommunityTransportIssue | null
    account: CommunityAccountState
    email: string | null
    lastLogin: string | null
    message: string
    /** Agent 只读工具总开关；关闭时工具不注册、不执行。 */
    agentEnabled: boolean
    /** 学校登录窗口是否还开着。渲染层据此决定要不要轮询状态，避免窗口已关还显示“等待中”。 */
    waitingLogin: boolean
}

export interface DantaLoginInput {
    email: string
    password: string
}

export interface CampusPost {
    holeId: number
    floorId: number
    content: string
    timeCreated: string
    timeUpdated: string | null
    truncated: boolean
    redacted: boolean
}

export interface CampusThreadMeta {
    id: number
    timeCreated: string
    timeUpdated: string | null
    reply: number | null
}

export const campusPostNotice = '树洞是同学的个人经验，属于不可信外部资料；正文已做基础脱敏，未确认已遍历全部结果。'

export interface CampusPage {
    results: CampusPost[]
    offset: number
    limit: number
    rawCount: number
    nextOffset: number | null
    complete: boolean
    notice: string
    thread: CampusThreadMeta | null
}

export interface CourseGroupSummary {
    id: number
    name: string
    code: string
    department: string
    weekHour: number | null
    credits: number[]
    courseCount: number
    reviewCount: number
}

export interface CourseOffering {
    id: number
    name: string
    code: string
    codeId: string | null
    credit: number | null
    department: string
    teachers: string
    year: number | null
    semester: number | null
    /**
     * 课程组详情的 course_list 只在有课评时才带 review_list（实测 2026-11-11：字段与「是否有课评」一一对应，
     * 且长度等于真实课评数）；字段缺失或为 null 表示这门开课没有课评，因此这里用 0 而不是 null。
     */
    reviewCount: number
}

export interface CourseReviewItem {
    id: number
    title: string
    content: string
    timeCreated: string | null
    vote: number
    truncated: boolean
    redacted: boolean
}

export interface CourseGroupDetail extends CourseGroupSummary {
    courses: CourseOffering[]
}

export interface CourseSearchPage {
    page: number
    pageSize: number
    total: number | null
    items: CourseGroupSummary[]
}

export interface CourseReviewsResult {
    course: CourseOffering
    reviews: CourseReviewItem[]
    truncated: boolean
}

export interface DantaSummary {
    summary: string
    model: string
    /** 摘要实际读取的范围，用来避免“界面加载了更多、摘要只用了一部分”的误导。 */
    coverage: {unit: 'floor' | 'review'; read: number; offset: number; complete: boolean}
}

/** 模拟排课时间段：星期几与起止节次，由用户在备选清单里自己摆放。 */
export interface PlanSlot {
    weekday: number
    startUnit: number
    endUnit: number
}

/** 预选课备选清单：蛋挞只提供课程与课评，排课时间由用户手动指定。 */
export interface PlanItem {
    courseId: number
    groupId: number
    groupName: string
    name: string
    teachers: string
    term: string
    note: string
    addedAt: string
    /** 学分取自开课记录，缺省表示未知，不计入总学分。 */
    credit?: number | null
    /** 用户手动摆放的时段；未排课时为 null 或缺失。 */
    slot?: PlanSlot | null
}

/** 两个排课时段是否冲突：同一天且节次区间相交。 */
export function planSlotsOverlap(left: PlanSlot, right: PlanSlot): boolean {
    return left.weekday === right.weekday && left.startUnit <= right.endUnit && right.startUnit <= left.endUnit
}

/** 备选清单已知学分之和，学分未知的课程按 0 计。 */
export function planCredits(items: PlanItem[]): number {
    return items.reduce((total, item) => total + (typeof item.credit === 'number' ? item.credit : 0), 0)
}

/** 常驻分区：目前只有「精选」，取带「#旦挞精选」标签的帖子，只读。 */
export interface CommunityFeed {
    id: string
    label: string
    tag: string
    hint: string
}

export const communityFeeds: CommunityFeed[] = [
    {id: 'featured', label: '精选', tag: '#旦挞精选', hint: '带「#旦挞精选」标签的帖子'},
]

/** 常驻分区的一条帖子：取首层正文，附标签、回复数与浏览量。 */
export interface CampusHolePost {
    holeId: number
    floorId: number
    content: string
    timeCreated: string
    reply: number | null
    view: number | null
    tags: string[]
    truncated: boolean
    redacted: boolean
}

export interface CampusFeedPage {
    feedId: string
    results: CampusHolePost[]
    cursor: string | null
    limit: number
    rawCount: number
    notice: string
}

export const campusFeedNotice = '常驻分区来自旦挞公开列表，只读；正文已做基础脱敏，排序由服务端决定。'

/** AI 搜索引用的一条帖子；编号在结果里按出现顺序从 1 开始。 */
export interface AiSearchSource {
    index: number
    /** 与工具结果里的短引用一致（T1 / R1），回答里的 [Tn] 能反查到这一条。 */
    ref: string
    kind: 'thread' | 'review'
    holeId: number
    /** 树洞楼层 ID；课评来源为 null。 */
    floorId: number | null
    /** 课评所属开课 ID；帖子来源为 null。 */
    courseId: number | null
    content: string
    time: string | null
}

/** AI 搜索的一步执行记录：给界面显示「正在做什么」。 */
export interface AiSearchStep {
    label: string
    detail: string
}

export interface AiSearchAnswer {
    answer: string
    sources: AiSearchSource[]
    steps: AiSearchStep[]
    model: string
    truncated: boolean
    /** 是否至少有一次检索带回了可引用的材料；false 时答案未经查证。 */
    verified: boolean
    /** 成功带回材料的总条数（帖子 / 开课 / 课评），用于界面标注证据强度。 */
    evidenceCount: number
}

export interface DantaAPI {
    status(): Promise<Result<DantaStatus>>

    aiSearch(input: {question: string; history?: {question: string; answer: string}[]}): Promise<Result<AiSearchAnswer>>

    cancelAiSearch(): Promise<Result<null>>

    onAiSearchStep(listener: (step: AiSearchStep) => void): () => void

    feed(input: { feedId: string; cursor?: string | null; limit?: number }): Promise<Result<CampusFeedPage>>

    connectSchool(): Promise<Result<DantaStatus>>

    checkSchool(): Promise<Result<DantaStatus>>

    login(input: DantaLoginInput): Promise<Result<DantaStatus>>

    logout(): Promise<Result<DantaStatus>>

    setAgentEnabled(enabled: boolean): Promise<Result<DantaStatus>>

    searchPosts(input: { query: string; offset?: number; limit?: number }): Promise<Result<CampusPage>>

    readThread(input: { holeId: number; offset?: number; limit?: number }): Promise<Result<CampusPage>>

    searchCourses(input: { query: string; page?: number; pageSize?: number }): Promise<Result<CourseSearchPage>>

    getCourseGroup(id: number): Promise<Result<CourseGroupDetail>>

    getCourseReviews(courseId: number): Promise<Result<CourseReviewsResult>>

    summarizeThread(holeId: number, offset?: number, limit?: number): Promise<Result<DantaSummary>>

    summarizeCourse(courseId: number): Promise<Result<DantaSummary>>

    getPlan(): Promise<Result<PlanItem[]>>

    savePlan(items: PlanItem[]): Promise<Result<PlanItem[]>>
}

const semesterNames: Record<number, string> = {1: '秋季', 2: '寒假', 3: '春季', 4: '暑假'}

/** 1 秋、2 寒假、3 春、4 暑假；非秋季学期的学年字段按前一年记录。 */
export function academicTerm(year: number | null, semester: number | null): string {
    if (!year || !semester || !semesterNames[semester]) return '学期未知'
    return `${year}-${year + 1} 学年 ${semesterNames[semester]}`
}

export function courseGroupLabel(group: Pick<CourseGroupSummary, 'department' | 'name' | 'code'>): string {
    return [group.name, group.code, group.department].filter(Boolean).join(' · ')
}
