import {createHash} from 'node:crypto'
import {load} from 'cheerio'
import type {CalendarEvent} from '../shared/calendar.ts'
import {validDate} from '../shared/timetable.ts'

export interface ParsedExam {
    course: string
    date: string
    startTime: string
    endTime: string
    location: string
    seat: string
    term: string
    sourceId: string
    cancelled: boolean
}

const datePattern = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/

function parseDate(text: string): string | null {
    const match = datePattern.exec(text)
    if (!match) return null
    const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    return validDate(value) ? value : null
}

function parseTimes(text: string): [string, string] | null {
    const matches = [...text.matchAll(/(\d{1,2}):(\d{2})/g)]
    if (matches.length < 2) return null
    const normalize = (hour: string, minute: string) => {
        const value = Number(hour)
        return value >= 0 && value <= 23 && Number(minute) <= 59
            ? `${String(value).padStart(2, '0')}:${minute}`
            : null
    }
    const start = normalize(matches[0][1], matches[0][2])
    const end = normalize(matches[1][1], matches[1][2])
    if (!start || !end || end <= start) return null
    return [start, end]
}

export function parseExamPage(html: string) {
    const $ = load(html)
    const exams: ParsedExam[] = []
    const selectedTerm = $('select[name*="semester" i] option:selected, select[id*="semester" i] option:selected').first().text().trim()
    let rowCount = 0
    $('tr').each((_index, row) => {
        if ($(row).find('th').length) return
        const values = $(row).find('td').toArray().map(cell => $(cell).text().replace(/\s+/g, ' ').trim())
        const headers = $(row).closest('table').find('tr').filter((_i, tr) => $(tr).children('th').length > 0)
            .last().children('th').map((_i, th) => $(th).text().trim()).get()
        const field = (pattern: RegExp) => values[headers.findIndex(label => pattern.test(label))] ?? ''
        const cells = values.filter(Boolean)
        if (cells.length < 2) return
        rowCount++
        const text = cells.join(' ')
        const date = parseDate(text)
        const times = parseTimes(text)
        const sourceId = $(row).attr('data-exam-id') || field(/^(?:考试安排编号|考试编号)$/)
        const term = field(/学期/) || selectedTerm || (date ? examTerm(date) : '')
        const cancelled = /^(?:已取消|取消|已撤销)$/.test(field(/状态/))
        if ((!date || !times) && !(cancelled && sourceId && term)) return
        const descriptive = cells.filter(cell => !/^\d+$/.test(cell) && !datePattern.test(cell) && !/\d{1,2}:\d{2}/.test(cell) &&
            !/(考场|地点|教室|座位|考试形式|考试方式|校区|楼|室)/.test(cell))
        const course = field(/^(?:课程(?:名称)?|考试科目|科目)$/) || descriptive[0] || cells[0]
        if (!course) return
        const location = field(/考场|考试地点|教室/) || cells.find(cell => /(考场|地点|教室|校区|楼|室)/.test(cell) && !datePattern.test(cell)) || ''
        const seat = field(/座位/) || cells.find(cell => /座位/.test(cell)) || ''
        const exam: ParsedExam = {
            course,
            date: date ?? '',
            startTime: times?.[0] ?? '',
            endTime: times?.[1] ?? '',
            location,
            seat,
            term, sourceId, cancelled
        }
        exams.push(exam)
    })
    const total = /(?:本学期|当前学期)(?:的)?全部考试(?:安排)?[\s，,:：]*(?:共|总计)\s*(\d+)\s*(?:条|场)/.exec($.root().text())
    const completeTerm = selectedTerm && total && Number(total[1]) === exams.length && rowCount === exams.length &&
    exams.every(exam => exam.term === selectedTerm) ? selectedTerm : null
    return {exams, completeTerm}
}

function examTerm(date: string) {
    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7))
    return month === 1 ? `${year - 1}-fall` : month < 8 ? `${year}-spring` : `${year}-fall`
}

function examId(exam: ParsedExam): string {
    const identity = exam.sourceId ? JSON.stringify([exam.term, exam.sourceId]) : `${exam.course}\n${exam.date}\n${exam.startTime}`
    const hex = createHash('sha1').update(identity).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function examEvent(exam: ParsedExam): CalendarEvent {
    const notes = [exam.seat, '考试日程自动导入'].filter(Boolean).join('\n')
    return {
        id: examId(exam),
        title: `${exam.course}考试`,
        startDate: exam.date,
        endDate: exam.date,
        startTime: exam.startTime,
        endTime: exam.endTime,
        allDay: false,
        reminderMinutes: 30,
        location: exam.location,
        notes,
        exam: {course: exam.course, term: exam.term, sourceId: exam.sourceId, notes}
    }
}

export function reconcileExams({exams, completeTerm}: ReturnType<typeof parseExamPage>, existing: CalendarEvent[]) {
    const added: CalendarEvent[] = [], updated: CalendarEvent[] = [], removed: string[] = []
    const pending = exams.map(exam => ({exam, item: examEvent(exam), match: undefined as CalendarEvent | undefined}))
    const used = new Set<string>()
    const ambiguous = () => new Error('同一课程存在多条无法区分的考试安排，请核对教务系统。')
    if (new Set(pending.map(row => row.item.id)).size !== pending.length) throw ambiguous()
    for (const row of pending) {
        const {item, exam} = row
        const matches = existing.filter(event => event.id === item.id ||
            (!!exam.sourceId && event.exam?.sourceId === exam.sourceId && event.exam.term === exam.term))
        if (matches.length > 1 || (matches[0] && used.has(matches[0].id))) throw ambiguous()
        row.match = matches[0]
        if (row.match) used.add(row.match.id)
    }
    for (const row of pending) {
        const {exam, item} = row
        if (!row.match) {
            const candidates = existing.filter(event => !used.has(event.id) && event.exam?.course === exam.course &&
                event.exam.term === exam.term && !(event.exam.sourceId && exam.sourceId))
            if (candidates.length) {
                if (candidates.length !== 1 || pending.filter(other => !other.match && other.exam.course === exam.course && other.exam.term === exam.term).length !== 1) throw ambiguous()
                row.match = candidates[0]
                used.add(row.match.id)
            }
        }
        const current = row.match
        if (exam.cancelled) {
            if (current) removed.push(current.id)
        } else if (!current) {
            added.push(item)
        } else {
            const title = current.exam && current.title === `${current.exam.course}考试` ? item.title : current.title
            const next = {
                ...current, title, startDate: item.startDate, endDate: item.endDate, startTime: item.startTime,
                endTime: item.endTime, location: item.location, exam: item.exam,
                notes: current.notes === current.exam?.notes ? item.notes : current.notes
            }
            if (JSON.stringify(current) !== JSON.stringify(next)) updated.push(next)
        }
    }
    if (completeTerm) for (const event of existing) {
        if (event.exam?.term === completeTerm && !used.has(event.id)) removed.push(event.id)
    }
    return {added, updated, removed}
}
