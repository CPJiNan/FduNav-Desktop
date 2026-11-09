import {BrowserWindow, ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {Result} from '../shared/accounts'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import {secureStorage} from './secure-storage'
import {createMailTransport} from './mail-imap'
import {MailError, MailService} from './mail-service'
import {openWebmail} from './mail-web'

export function registerMailHandlers(db: AppDatabase, accounts: AccountService, trusted: (event: IpcMainInvokeEvent) => boolean) {
    const owner = () => {const account = accounts.getState(); return account.status === 'signed-in' ? account.username : null}
    const service = new MailService(db, secureStorage, createMailTransport(), owner)
    function handle<T>(channel: string, action: (input: unknown, event: IpcMainInvokeEvent) => Promise<T>) {
        ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {return {ok: true, data: await action(input, event)}}
            catch (error) {return {ok: false, error: error instanceof MailError ? error.message : '邮箱操作失败，请重试。'}}
            finally {if (input && typeof input === 'object' && typeof input.password === 'string') input.password = ''}
        })
    }
    handle('mail:get', () => service.get())
    handle('mail:test', input => service.test(input))
    handle('mail:save', input => service.save(input))
    handle('mail:cancel-setup', () => service.cancelSetup())
    handle('mail:set-enabled', input => service.setEnabled(input))
    handle('mail:disconnect', () => service.disconnect())
    handle('mail:open-webmail', async (input, event) => {
        if (input !== 'browser' && input !== 'app') throw new MailError('invalid_args', '邮箱打开方式无效。')
        const username = owner()
        if (!username) throw new MailError('forbidden', '请先登录校园账号。')
        return openWebmail(username, owner, input, BrowserWindow.fromWebContents(event.sender) ?? undefined)
    })
    return service
}
