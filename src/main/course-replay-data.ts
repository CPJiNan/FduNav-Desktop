import type {TimetableCourse} from '../shared/timetable'

export interface ReplayCourse {
    id: string
    name: string
    teachers: string[]
}

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '')
const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

export function courseReplayLoginUrl(courseId?: string): string {
    const params = new URLSearchParams({
        r: 'auth/login', school_login: '1', tenant_code: '222',
        forward: courseId === undefined ? 'https://icourse.fudan.edu.cn/coursepage?tenant_code=222' : courseReplayUrl(courseId),
    })
    return `https://icourse.fudan.edu.cn/casapi/index.php?${params}`
}

export function isReplayLoginPage(value: string): boolean {
    try {
        const url = new URL(value)
        return url.origin === 'https://icourse.fudan.edu.cn' && !url.username && !url.password &&
            /^\/(?:yjlogin|yjapplogin|validate|casapi)(?:\/|$)/.test(url.pathname)
    } catch {
        return false
    }
}

export function replayToken(value: string): string {
    try {
        return /\{i:\d+;s:\d+:"_token";i:\d+;s:\d+:"([^"\r\n]+)";\}/.exec(decodeURIComponent(value))?.[1] ?? ''
    } catch {
        return ''
    }
}

export function replayUser(value: unknown, username: string): string | null {
    const user = record(record(value).params)
    if (String(user.account ?? '') !== username || String(user.tenant_id ?? '') !== '222') return null
    const id = String(user.id ?? '')
    return /^[1-9]\d*$/.test(id) ? id : null
}

export function parseReplaySchedule(value: unknown): ReplayCourse[] {
    const list = record(record(value).result).list
    if (!Array.isArray(list)) throw new Error('无法读取 iCourse 本人课表，请重试。')
    const courses: ReplayCourse[] = []
    for (const day of list) {
        const entries = record(day).course
        if (entries === undefined || entries === null) continue
        if (!Array.isArray(entries)) throw new Error('iCourse 课表格式已变化，请更新应用。')
        for (const entry of entries) {
            const item = record(entry)
            const id = String(item.course_id ?? '')
            if (!/^[1-9]\d*$/.test(id) || typeof item.course_title !== 'string') continue
            const teachers = Array.isArray(item.teachers) && item.teachers.length
                ? item.teachers.map(teacher => record(teacher).realname).filter((name): name is string => typeof name === 'string')
                : String(item.lecturer_name || item.teacher_name || '').split(/[、,，;；/\s]+/).filter(Boolean)
            courses.push({id, name: item.course_title, teachers})
        }
    }
    return courses
}

export function matchReplayCourse(candidates: ReplayCourse[], course: Pick<TimetableCourse, 'name' | 'teachers'>): string | null {
    const teachers = course.teachers.flatMap(name => name.split(/[、,，;；/]+/)).map(normalize).filter(Boolean)
    if (!teachers.length) return null
    const ids = new Set(candidates.filter(item => normalize(item.name) === normalize(course.name) &&
        item.teachers.some(name => teachers.includes(normalize(name)))).map(item => item.id))
    return ids.size === 1 ? [...ids][0] : null
}

export function replayWeeks(startDate: string | null, weeks: number[]): { start: string; end: string }[] {
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('请先设置课表的学期开始日期。')
    const start = Date.parse(`${startDate}T00:00:00Z`)
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== startDate) throw new Error('学期开始日期无效。')
    const unique = [...new Set(weeks)].sort((a, b) => a - b)
    if (!unique.length || unique.some(week => !Number.isInteger(week) || week < 1 || week > 60)) throw new Error('课程教学周无效，请刷新课表。')
    const date = (days: number) => new Date(start + days * 86_400_000).toISOString().slice(0, 10)
    return unique.map(week => ({start: date((week - 1) * 7), end: date((week - 1) * 7 + 6)}))
}

export function courseReplayUrl(id: string): string {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('iCourse 课程编号无效。')
    return `https://icourse.fudan.edu.cn/coursedetail?course_id=${id}&tenant_code=222`
}
