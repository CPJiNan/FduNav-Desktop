import type {Result} from './accounts'
import {type CalendarReminderMinutes, isCalendarReminderMinutes} from './calendar-reminders'
import {courseStartTimes, dateAfter, type Timetable, type TimetableCourse, validDate} from './timetable'

export type CalendarView = 'year' | 'month' | 'week' | 'day' | 'agenda'
export const calendarViews = [{id: 'year', label: '年'}, {id: 'month', label: '月'}, {id: 'week', label: '周'},
    {id: 'day', label: '日'}, {id: 'agenda', label: '日程'}] as const
export const calendarWeekdays = ['日', '一', '二', '三', '四', '五', '六']

export interface CalendarEventInput {
    id?: string
    title: string
    startDate: string
    endDate: string
    startTime: string
    endTime: string
    allDay: boolean
    reminderMinutes: CalendarReminderMinutes
    location: string
    notes: string
}

export interface CalendarEvent extends CalendarEventInput {
    id: string
    exam?: {course: string; term: string; sourceId: string; notes: string}
}

export interface CalendarAPI {
    list(): Promise<Result<CalendarEvent[]>>

    save(input: CalendarEventInput): Promise<Result<CalendarEvent>>

    remove(id: string): Promise<Result<null>>

    syncExams(): Promise<Result<{ added: number; updated: number; removed: number; total: number }>>
}

export interface CalendarOccurrence {
    key: string
    date: string
    title: string
    location: string
    startMinute: number
    endMinute: number
    allDay: boolean
    course?: TimetableCourse
    event?: CalendarEvent
}

export const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
export const dateString = (date: Date) => date.toISOString().slice(0, 10)
export const calendarDate = (value: unknown): value is string => validDate(value) && value >= '1900-01-01' && value <= '2100-12-31'
export const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
export const timeLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export function localToday() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export const weekStartDate = (date: string) => dateAfter(date, -asDate(date).getUTCDay())
export const dayDifference = (left: string, right: string) => Math.round((asDate(left).getTime() - asDate(right).getTime()) / 86_400_000)

export function monthDates(date: string) {
    const first = weekStartDate(`${date.slice(0, 7)}-01`)
    return Array.from({length: 42}, (_, index) => dateAfter(first, index))
}

export function shiftCalendarDate(date: string, view: CalendarView, amount: number) {
    const current = asDate(date)
    if (view === 'month' || view === 'year') {
        const day = current.getUTCDate()
        current.setUTCDate(1)
        current.setUTCMonth(current.getUTCMonth() + amount * (view === 'year' ? 12 : 1))
        const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate()
        current.setUTCDate(Math.min(day, last))
    } else current.setUTCDate(current.getUTCDate() + amount * (view === 'week' ? 7 : view === 'agenda' ? 30 : 1))
    const result = dateString(current)
    return result < '1900-01-01' ? '1900-01-01' : result > '2100-12-31' ? '2100-12-31' : result
}

export function calendarRange(date: string, view: CalendarView): [string, string] {
    if (view === 'year') return [`${date.slice(0, 4)}-01-01`, `${date.slice(0, 4)}-12-31`]
    if (view === 'month') {
        const days = monthDates(date);
        return [days[0], days[days.length - 1]]
    }
    if (view === 'week') {
        const start = weekStartDate(date);
        return [start, dateAfter(start, 6)]
    }
    return [date, view === 'agenda' ? dateAfter(date, 29) : date]
}

const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {month: 'long', day: 'numeric', timeZone: 'UTC'})

export function lunarDate(date: string, full = false) {
    const parts = lunarFormatter.formatToParts(asDate(date))
    const day = Number(parts.find(part => part.type === 'day')?.value)
    const month = parts.find(part => part.type === 'month')?.value ?? ''
    const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    const label = day === 10 ? '初十' : day === 20 ? '二十' : day === 30 ? '三十'
        : (day < 10 ? '初' : day < 20 ? '十' : '廿') + digits[(day - 1) % 10]
    return full ? `${month}${label}` : label
}

export function validateCalendarEvent(input: unknown): Result<CalendarEventInput> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, error: '日程格式无效。'}
    const value = input as Record<string, unknown>
    if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id))) return {
        ok: false,
        error: '日程编号无效。'
    }
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200) return {
        ok: false,
        error: '请输入 1–200 个字符的日程名称。'
    }
    if (!calendarDate(value.startDate) || !calendarDate(value.endDate) || value.endDate < value.startDate) return {
        ok: false,
        error: '请选择有效的起止日期。'
    }
    if (typeof value.allDay !== 'boolean') return {ok: false, error: '全天选项无效。'}
    if (!isCalendarReminderMinutes(value.reminderMinutes)) return {ok: false, error: '请选择有效的提醒时间。'}
    const validTime = (time: unknown): time is string => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    if (!value.allDay && (!validTime(value.startTime) || !validTime(value.endTime) ||
        (value.startDate === value.endDate && value.endTime <= value.startTime))) return {
        ok: false,
        error: '结束时间须晚于开始时间。'
    }
    if (typeof value.location !== 'string' || value.location.length > 500 || typeof value.notes !== 'string' || value.notes.length > 5000) return {
        ok: false,
        error: '地点或备注超过长度限制。'
    }
    return {
        ok: true, data: {
            id: value.id as string | undefined, title: value.title.trim(), startDate: value.startDate,
            endDate: value.endDate, startTime: value.allDay ? '00:00' : value.startTime as string,
            endTime: value.allDay ? '00:00' : value.endTime as string, allDay: value.allDay,
            reminderMinutes: value.reminderMinutes,
            location: value.location.trim(), notes: value.notes.trim()
        }
    }
}

export function calendarOccurrences(timetable: Timetable | null, events: CalendarEvent[], from: string, to: string): CalendarOccurrence[] {
    const result: CalendarOccurrence[] = []
    if (timetable?.startDate) {
        for (const course of timetable.courses) for (const week of new Set(course.weeks)) {
            const date = dateAfter(timetable.startDate,
                (week - 1) * 7 + (course.weekday === 7 ? 0 : course.weekday))
            if (date < from || date > to) continue
            result.push({
                key: `course:${course.id}:${date}`, date, title: course.name, location: course.room,
                startMinute: minuteOfDay(courseStartTimes[course.startUnit - 1]),
                endMinute: minuteOfDay(courseStartTimes[course.endUnit - 1]) + 45, allDay: false, course
            })
        }
    }
    for (const event of events) {
        const start = event.startDate > from ? event.startDate : from
        const end = event.endDate < to ? event.endDate : to
        for (let date = start; date <= end; date = dateAfter(date, 1)) {
            const startMinute = event.allDay || date !== event.startDate ? 0 : minuteOfDay(event.startTime)
            const endMinute = event.allDay || date !== event.endDate ? 1440 : minuteOfDay(event.endTime)
            if (!event.allDay && endMinute <= startMinute) continue
            result.push({
                key: `event:${event.id}:${date}`, date, title: event.title, location: event.location,
                startMinute, endMinute, allDay: event.allDay, event
            })
        }
    }
    return result.sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.startMinute - b.startMinute || a.title.localeCompare(b.title))
}

export function layoutCalendarDay(items: CalendarOccurrence[]) {
    const groups: CalendarOccurrence[][] = []
    for (const item of [...items].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)) {
        const last = groups.at(-1)
        if (last && item.startMinute < Math.max(...last.map(entry => entry.endMinute))) last.push(item)
        else groups.push([item])
    }
    return groups.flatMap(group => {
        const ends: number[] = []
        const entries = group.map(item => {
            let lane = ends.findIndex(end => end <= item.startMinute)
            if (lane < 0) lane = ends.length
            ends[lane] = item.endMinute
            return {item, lane}
        })
        return entries.map(entry => ({...entry, lanes: ends.length}))
    })
}
