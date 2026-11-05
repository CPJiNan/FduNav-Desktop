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
    return `https://fdjwgl.fudan.edu.cn/student/for-std/lesson-search/teachingSyllabusInfo/${lessonId}`
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
