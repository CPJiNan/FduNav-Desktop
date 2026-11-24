import {load} from 'cheerio'
import {weekStartDate} from '../shared/calendar.ts'
import {AuthError} from './fudan-auth.ts'
import {type Semester, type TimetableCourse, validDate} from '../shared/timetable.ts'

const invalid = () => new AuthError('无法解析学校课表数据，学校页面可能已更新。')

export function parseSemesters(html: string): { semesters: Semester[]; defaultId: string } {
    const $ = load(html)
    const expression = html.match(/\b(?:var|let|const)\s+semesters\s*=\s*JSON\.parse\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\)/)?.[1]
    if (!expression) throw invalid()
    let rows: unknown
    try {
        const text = expression[0] === '"' ? JSON.parse(expression)
            : expression.slice(1, -1).replace(/\\([\\'"/])/g, '$1').replace(/\\x([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
        rows = JSON.parse(text)
    } catch {
        throw invalid()
    }
    const entries = array(rows)
    if (!entries.length) throw invalid()
    const semesters: Semester[] = entries.map(value => {
        const row = record(value)
        if (!/^\d+$/.test(String(row.id)) || typeof row.name !== 'string') throw invalid()
        const date = typeof row.startDate === 'string' ? row.startDate.slice(0, 10) : ''
        const startDate = validDate(date) ? weekStartDate(date) : null
        return {id: String(row.id), name: row.name, startDate}
    }).reverse()
    const defaultId = $('#allSemesters option[selected]').first().attr('value') ?? $('#allSemesters option').first().attr('value')
    if (!defaultId || !semesters.some(semester => semester.id === defaultId)) throw invalid()
    return {semesters, defaultId}
}

function json(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw invalid()
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw invalid()
    return value
}

function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw invalid()
    const number = Number(value)
    if (!Number.isInteger(number) || number < min || number > max) throw invalid()
    return number
}

function text(value: unknown, optional = false): string {
    if (optional && value == null) return ''
    if (typeof value !== 'string') throw invalid()
    return value.trim()
}

export function parseUndergraduateCourses(body: string): TimetableCourse[] {
    const response = record(json(body))
    const tables = array(response.studentTableVms)
    if (!tables.length) throw invalid()
    const activities = array(record(tables[0]).activities)
    return activities.map((value, index) => {
        const activity = record(value)
        const weeks = array(activity.weekIndexes)
        const teachers = array(activity.teachers)
        const weekday = integer(activity.weekday, 1, 7)
        const startUnit = integer(activity.startUnit, 1, 15)
        const endUnit = integer(activity.endUnit, startUnit, 15)
        return {
            id: `${activity.lessonId ?? ''}-${activity.lessonCode ?? ''}-${index}`,
            lessonId: activity.lessonId == null ? undefined : String(integer(activity.lessonId, 1, Number.MAX_SAFE_INTEGER)),
            name: text(activity.courseName), teachers: teachers.map(value => text(value)),
            room: text(activity.room, true), weekday, startUnit, endUnit,
            weeks: [...new Set(weeks.map(week => integer(week, 1, 60)))].sort((a, b) => a - b),
        }
    })
}

export function parsePostgraduateCourses(body: string): TimetableCourse[] {
    const response = record(json(body))
    const courses: TimetableCourse[] = array(response.results).map((value, index) => {
        const row = record(value)
        if (typeof row.ZCBH !== 'string' || !/^[01]{1,60}$/.test(row.ZCBH)) throw invalid()
        const startUnit = integer(row.KSJCDM, 1, 15)
        return {
            id: `pg-${index}`, name: text(row.KCMC), room: text(row.JASMC, true),
            teachers: row.JSXM ? [text(row.JSXM)] : [], weekday: integer(row.XQ, 1, 7),
            startUnit, endUnit: row.JSJCDM == null ? startUnit : integer(row.JSJCDM, startUnit, 15),
            weeks: [...row.ZCBH].flatMap((bit, week) => bit === '1' ? [week + 1] : []),
        }
    })
    const merged: TimetableCourse[] = []
    for (const course of courses.sort((a, b) => a.weekday - b.weekday || a.startUnit - b.startUnit)) {
        const previous = merged.find(item => item.name === course.name && item.room === course.room && item.weekday === course.weekday &&
            item.endUnit + 1 === course.startUnit && JSON.stringify(item.weeks) === JSON.stringify(course.weeks) &&
            JSON.stringify(item.teachers) === JSON.stringify(course.teachers))
        if (previous) previous.endUnit = course.endUnit
        else merged.push(course)
    }
    return merged
}
