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
}

/** 预选课备选清单：蛋挞只提供课程与课评，具体排课时间在课程表刷新后才有。 */
export interface PlanItem {
    courseId: number
    groupId: number
    groupName: string
    name: string
    teachers: string
    term: string
    note: string
    addedAt: string
}

export interface DantaAPI {
    status(): Promise<Result<DantaStatus>>

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

    summarizeThread(holeId: number): Promise<Result<DantaSummary>>

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
