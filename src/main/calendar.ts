import {randomUUID} from 'node:crypto'
import {ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import {AuthError} from './fudan-auth'
import {validateCalendarEvent} from '../shared/calendar'
import type {Result} from '../shared/accounts'
import {CalendarReminderService} from './calendar-reminders'
import {examEvent, parseExamPage} from './exam-import'

export function registerCalendarHandlers(db: AppDatabase, accounts: AccountService,
                                         trusted: (event: IpcMainInvokeEvent) => boolean, onReminderClick: () => void) {
    const reminders = new CalendarReminderService(db, onReminderClick)

    function handle<T>(channel: string, action: (username: string, input: unknown) => T) {
        ipcMain.handle(channel, (event, input): Result<T> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                const account = accounts.getState()
                if (account.status !== 'signed-in' || !account.username) throw new AuthError('请先登录账号。')
                return {ok: true, data: action(account.username, input)}
            } catch (error) {
                return {ok: false, error: error instanceof AuthError ? error.message : '日程操作失败，请重试。'}
            }
        })
    }

    handle('calendar:list', username => db.getCalendarEvents(username))

    function save(username: string, input: unknown) {
        const result = validateCalendarEvent(input)
        if (!result.ok) throw new AuthError(result.error)
        if (result.data.id && !db.hasCalendarEvent(username, result.data.id)) throw new AuthError('日程不存在或已被删除。')
        const event = {...result.data, id: result.data.id ?? randomUUID()}
        db.saveCalendarEvent(username, event)
        db.afterCommit(() => reminders.changed(username, event.id))
        return event
    }

    function remove(username: string, input: unknown) {
        if (typeof input !== 'string' || !db.hasCalendarEvent(username, input)) throw new AuthError('日程不存在或已被删除。')
        db.removeCalendarEvent(username, input)
        db.afterCommit(() => reminders.changed(username, input))
        return null
    }

    handle('calendar:save', save)
    handle('calendar:remove', remove)

    ipcMain.handle('calendar:sync-exams', async (event): Promise<Result<{ added: number; total: number }>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const account = accounts.getState()
            if (account.status !== 'signed-in' || !account.username) throw new AuthError('请先登录账号。')
            const html = await accounts.readExamPage()
            if (!html) throw new AuthError('无法读取考试安排，请重新登录教务系统。')
            const exams = parseExamPage(html)
            if (!exams.length) throw new AuthError('未识别到考试安排，请确认教务系统页面可访问。')
            let added = 0
            for (const exam of exams) {
                const item = examEvent(exam)
                if (db.hasCalendarEvent(account.username, item.id)) continue
                db.saveCalendarEvent(account.username, item)
                reminders.changed(account.username, item.id)
                added++
            }
            return {ok: true, data: {added, total: exams.length}}
        } catch (error) {
            return {
                ok: false,
                error: error instanceof AuthError ? error.message : '同步考试安排失败，请稍后重试。'
            }
        }
    })
    return {save, remove}
}
