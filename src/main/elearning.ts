import {createHash} from 'node:crypto'
import type {Todo} from '../shared/todos'
import type {CalendarReminderMinutes} from '../shared/calendar-reminders'

export const ELEARNING = 'https://elearning.fudan.edu.cn'
type RecordValue = Record<string, unknown>
export type ServiceRead = <R>(url: string, parse: (text: string, link?: string) => R) => Promise<R>

function record(value: unknown): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('eLearning 数据格式无效。')
    return value as RecordValue
}

function identifier(value: unknown): string {
    if (!/^[1-9]\d*$/.test(String(value))) throw new Error('eLearning 编号无效。')
    return String(value)
}

export function apiUrl(value: string): string {
    const url = new URL(value, ELEARNING)
    if (url.origin !== ELEARNING || url.username || url.password || !url.pathname.startsWith('/api/v1/')) {
        throw new Error('eLearning 返回了无效的分页地址。')
    }
    return url.href
}

function json(text: string): unknown {
    return JSON.parse(text.replace(/^\s*while\(1\);\s*/, ''))
}

export async function readPages(read: ServiceRead, path: string): Promise<RecordValue[]> {
    const items: RecordValue[] = []
    const visited = new Set<string>()
    let url: string | undefined = apiUrl(path)
    while (url) {
        if (visited.has(url) || visited.size >= 200) throw new Error('eLearning 分页异常，请稍后重试。')
        visited.add(url)
        const page: { items: RecordValue[]; next: string | undefined } = await read(url, (text, link) => {
            const data = json(text)
            if (!Array.isArray(data)) throw new Error('无法读取 eLearning 列表，请重新认证。')
            const next = link?.match(/<([^>]+)>\s*;\s*rel="next"/i)?.[1]
            return {items: data.map(record), next: next ? apiUrl(next) : undefined}
        })
        items.push(...page.items)
        url = page.next
    }
    return items
}

function timestamp(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('eLearning 时间格式无效。')
    return new Date(value).toISOString()
}

export function assignmentTodo(course: RecordValue, assignment: RecordValue, submission: RecordValue,
                               previous: Todo | undefined, reminderMinutes: CalendarReminderMinutes, now: string): Todo {
    const courseId = identifier(course.id), assignmentId = identifier(assignment.id)
    if (identifier(submission.assignment_id) !== assignmentId) throw new Error('作业与提交记录不匹配。')
    if (typeof assignment.name !== 'string' || !assignment.name.trim() || typeof course.name !== 'string') {
        throw new Error('eLearning 作业信息不完整。')
    }
    const state = submission.workflow_state
    if (!['unsubmitted', 'submitted', 'pending_review', 'graded'].includes(String(state))) {
        throw new Error('无法识别作业提交状态，已保留原有待办。')
    }
    const completed = submission.excused === true || state !== 'unsubmitted'
    const status = submission.excused === true ? '免交' : state === 'graded' ? '已评分' :
        state === 'pending_review' ? '待批阅' : state === 'submitted' ? '已提交' : '未提交'
    const due = timestamp(Object.hasOwn(submission, 'cached_due_date') ? submission.cached_due_date : assignment.due_at)
    let dueDate = '', dueTime = '23:59'
    if (due) {
        const date = new Date(due)
        const pad = (n: number) => String(n).padStart(2, '0')
        dueDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        dueTime = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const hash = createHash('sha256').update(`elearning:${courseId}:${assignmentId}`).digest('hex')
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
    return {
        id, title: assignment.name.trim().slice(0, 200), notes: course.name.slice(0, 5000),
        dueDate, dueTime, completed, reminderMinutes: previous?.reminderMinutes ?? reminderMinutes,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
        elearning: {
            courseId, assignmentId, courseName: course.name,
            url: `${ELEARNING}/courses/${courseId}/assignments/${assignmentId}`,
            status, submittedAt: timestamp(submission.submitted_at),
            attempts: typeof submission.attempt === 'number' ? submission.attempt : 0, syncedAt: now,
        },
    }
}

export function isUnfinishedAssignment(submission: RecordValue): boolean {
    return submission.excused !== true && submission.workflow_state === 'unsubmitted'
}

export async function fetchAssignments(read: ServiceRead) {
    await read(`${ELEARNING}/dash`, () => null)
    const courses = await readPages(read, '/api/v1/courses?enrollment_type=student&enrollment_state=active&per_page=100')
    const result: { course: RecordValue; assignment: RecordValue; submission: RecordValue }[] = []
    for (const course of courses) {
        const courseId = identifier(course.id)
        const assignments = await readPages(read, `/api/v1/courses/${courseId}/assignments?include[]=submission&per_page=100`)
        for (const assignment of assignments) {
            if (assignment.published === false || (Array.isArray(assignment.submission_types) && assignment.submission_types.includes('not_graded'))) continue
            const assignmentId = identifier(assignment.id)
            const submission = assignment.submission ? record(assignment.submission) : await read(
                `${ELEARNING}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self`, text => record(json(text)))
            result.push({course, assignment, submission})
        }
    }
    return result
}
