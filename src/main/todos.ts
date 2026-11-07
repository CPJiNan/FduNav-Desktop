import {BrowserWindow, ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import type {Result} from '../shared/accounts'
import {TodoError, TodoService} from './todo-service'
import {TodoReminderService} from './todo-reminders'
import {assignmentTodo, fetchAssignments, isUnfinishedAssignment} from './elearning'
import {AuthError} from './fudan-auth'

export function registerTodoHandlers(db: AppDatabase, accounts: AccountService,
                                     trusted: (event: IpcMainInvokeEvent) => boolean, onReminderClick: () => void) {
    const service = new TodoService(db)
    const reminders = new TodoReminderService(db, onReminderClick)

    function handle<T>(channel: string, action: (username: string, input: unknown) => T) {
        ipcMain.handle(channel, (event, input): Result<T> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                const account = accounts.getState()
                if (account.status !== 'signed-in' || !account.username) return {ok: false, error: '请先登录账号。'}
                return {ok: true, data: action(account.username, input)}
            } catch (error) {
                return {ok: false, error: error instanceof TodoError ? error.message : '待办操作失败，请重试。'}
            }
        })
    }

    handle('todos:list', username => db.getTodos(username))

    let syncing: Promise<{ todos: import('../shared/todos').Todo[]; total: number; syncedAt: string }> | null = null
    let syncingOwner = ''
    ipcMain.handle('todos:sync-elearning', async (event, interactive: unknown) => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const account = accounts.getState()
            if (account.status !== 'signed-in' || !account.username) throw new AuthError('请先登录账号。')
            const username = account.username
            const owner = `${username}:${account.lastLogin}`
            if (syncing && syncingOwner !== owner) throw new AuthError('账号已变化，请稍后重试。')
            if (!syncing) {
                syncingOwner = owner
                syncing = (async () => {
                    const rows = await accounts.withServiceSession(fetchAssignments,
                        BrowserWindow.fromWebContents(event.sender) ?? undefined, interactive === true)
                    const current = accounts.getState()
                    if (current.status !== 'signed-in' || `${current.username}:${current.lastLogin}` !== owner) {
                        throw new AuthError('账号已变化，请重新同步。')
                    }
                    const syncedAt = new Date().toISOString()
                    const existing = db.getTodos(username)
                    const bySource = new Map(existing.filter(todo => todo.elearning).map(todo =>
                        [`${todo.elearning!.courseId}:${todo.elearning!.assignmentId}`, todo]))
                    for (const {course, assignment, submission} of rows) {
                        if (!isUnfinishedAssignment(submission)) continue
                        const courseId = String(course.id), assignmentId = String(assignment.id)
                        if (db.hasElearningImport(username, courseId, assignmentId)) continue
                        const key = `${courseId}:${assignmentId}`
                        const previous = bySource.get(key)
                        if (previous) {
                            db.markElearningImport(username, courseId, assignmentId, syncedAt)
                            continue
                        }
                        const todo = assignmentTodo(course, assignment, submission, undefined, db.getTodoDefaultReminder(), syncedAt)
                        db.saveTodo(username, todo)
                        db.markElearningImport(username, courseId, assignmentId, syncedAt)
                        reminders.changed(username, todo.id)
                    }
                    const todos = db.getTodos(username)
                    return {todos, total: todos.length, syncedAt}
                })().finally(() => {
                    syncing = null
                })
            }
            return {ok: true, data: await syncing}
        } catch (error) {
            return {
                ok: false, error: error instanceof AuthError ? error.message :
                    '同步 eLearning 失败，已有待办已保留。请检查网络或重新认证后重试。'
            }
        }
    })

    ipcMain.handle('todos:open-elearning', async (event, id: unknown) => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const account = accounts.getState()
            if (account.status !== 'signed-in' || !account.username) throw new AuthError('请先登录账号。')
            const todo = typeof id === 'string' ? db.getTodo(account.username, id) : null
            if (!todo?.elearning) throw new AuthError('作业不存在，请重新同步。')
            await accounts.openPageWithBrowser(todo.elearning.url, BrowserWindow.fromWebContents(event.sender) ?? undefined)
            return {ok: true, data: null}
        } catch {
            return {ok: false, error: '无法打开作业，请登录后重试。'}
        }
    })

    function save(username: string, input: unknown) {
        const todo = service.save(username, input)
        db.afterCommit(() => reminders.changed(username, todo.id))
        return todo
    }

    handle('todos:save', save)

    function remove(username: string, input: unknown) {
        const result = service.remove(username, input)
        db.afterCommit(() => reminders.changed(username, input as string))
        return result
    }

    handle('todos:remove', remove)
    return {save, remove}
}
