import type {Result} from './accounts'

export interface Semester {
    id: string
    name: string
    startDate: string | null
}

export interface TimetableCourse {
    id: string
    lessonId?: string
    name: string
    teachers: string[]
    room: string
    weekday: number
    startUnit: number
    endUnit: number
    weeks: number[]
}

export interface Timetable {
    kind: 'undergraduate' | 'postgraduate'
    semesters: Semester[]
    semesterId: string
    startDate: string | null
    courses: TimetableCourse[]
    updatedAt: string
}

export interface TimetableAPI {
    cached(): Promise<Result<Timetable | null>>

    get(options?: { refresh?: boolean; semesterId?: string }): Promise<Result<Timetable>>

    setStartDate(date: string): Promise<Result<Timetable>>

    openSyllabus(courseId: string): Promise<Result<void>>

    openReplay(courseId: string): Promise<Result<void>>
}

export function courseSyllabusUrl({lessonId}: Pick<TimetableCourse, 'lessonId'>): string | null {
    if (!lessonId || !/^[1-9]\d*$/.test(lessonId) || !Number.isSafeInteger(Number(lessonId))) return null
    return `https://fdjwgl.fudan.edu.cn/student/for-all/lesson-search/teachingSyllabusInfo/${lessonId}`
}

export const courseStartTimes = ['08:00', '08:55', '09:55', '10:50', '11:45', '13:30', '14:25', '15:25',
    '16:20', '17:15', '18:30', '19:25', '20:20', '21:15', '22:10']

export function validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const time = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function dateAfter(date: string, days: number) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function currentWeek(startDate: string | null, today = new Date()) {
    if (!startDate) return 1
    const localDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    return Math.floor((localDay - Date.parse(`${startDate}T00:00:00Z`)) / (7 * 86_400_000)) + 1
}

export interface SemesterWindow {
    from: string
    to: string
}

/**
 * 推算某个学期的日期区间：截止到下个学期开学前一天。
 * 最后一个学期没有下一个开学日可依，按 181 天（教学 18 周 + 考试与假期）估算。
 * 学期缺少开学日期时返回 null，调用方应退回「不过滤」，避免误删数据。
 */
export function semesterWindow(semesters: Semester[], semesterId: string): SemesterWindow | null {
    const dated = semesters
        .filter(item => typeof item.startDate === 'string' && validDate(item.startDate))
        .map(item => ({id: item.id, startDate: item.startDate as string}))
        .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
    const index = dated.findIndex(item => item.id === semesterId)
    if (index < 0) return null
    const from = dated[index].startDate
    const next = dated[index + 1]?.startDate
    return {from, to: next ? dateAfter(next, -1) : dateAfter(from, 181)}
}
