import type {Result} from './accounts'
import {validDate} from './timetable.ts'
import {type CalendarReminderMinutes, calendarReminderSchedule, isCalendarReminderMinutes} from './calendar-reminders'

export interface TodoInput {
    id?: string
    title: string
    notes: string
    dueDate: string
    dueTime: string
    reminderMinutes: CalendarReminderMinutes
    completed: boolean
}

export interface Todo extends TodoInput {
    id: string
    createdAt: string
    updatedAt: string
    elearning?: {
        courseId: string
        assignmentId: string
        courseName: string
        url: string
        status: string
        submittedAt: string | null
        attempts: number
        syncedAt: string
    }
}

export interface TodosAPI {
    syncElearning(interactive?: boolean): Promise<Result<{ todos: Todo[]; total: number; syncedAt: string }>>

    openElearning(id: string): Promise<Result<null>>

    list(): Promise<Result<Todo[]>>

    save(input: TodoInput): Promise<Result<Todo>>

    remove(id: string): Promise<Result<null>>
}

export function validateTodo(input: unknown): Result<TodoInput> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, error: '待办格式无效。'}
    const value = input as Record<string, unknown>
    if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id))) {
        return {ok: false, error: '待办编号无效。'}
    }
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200) {
        return {ok: false, error: '请输入 1–200 个字符的待办名称。'}
    }
    if (typeof value.notes !== 'string' || value.notes.length > 5000) return {ok: false, error: '备注最多 5000 个字符。'}
    if (value.dueDate !== '' && (!validDate(value.dueDate) || value.dueDate < '1900-01-01' || value.dueDate > '2100-12-31')) {
        return {ok: false, error: '请选择有效的截止日期。'}
    }
    if (typeof value.completed !== 'boolean') return {ok: false, error: '待办状态无效。'}
    if (typeof value.dueTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.dueTime)) {
        return {ok: false, error: '请选择有效的截止时间。'}
    }
    if (!isCalendarReminderMinutes(value.reminderMinutes)) return {ok: false, error: '请选择有效的提醒时间。'}
    return {
        ok: true, data: {
            id: value.id as string | undefined, title: value.title.trim(), notes: value.notes.trim(),
            dueDate: value.dueDate as string, dueTime: value.dueTime,
            reminderMinutes: value.reminderMinutes, completed: value.completed
        }
    }
}

export function todoReminderSchedule(todo: TodoInput) {
    if (todo.completed || !todo.dueDate) return null
    return calendarReminderSchedule({
        startDate: todo.dueDate, startTime: todo.dueTime,
        allDay: false, reminderMinutes: todo.reminderMinutes
    })
}
