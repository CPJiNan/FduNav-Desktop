import {ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import type {Result} from '../shared/accounts'
import {
    type CampusLoginInput,
    type CampusState,
    type ResearchSettings,
    type ResearchSettingsInput,
    validateCampusLogin
} from '../shared/research'
import {CampusAuthService} from './campus-auth'
import {ResearchSettingsService} from './research-settings'
import {secureStorage} from './secure-storage'

export interface ResearchServices {
    settings: ResearchSettingsService
    campus: CampusAuthService
}

export function registerResearchHandlers(db: AppDatabase, accounts: AccountService,
                                         trusted: (event: IpcMainInvokeEvent) => boolean): ResearchServices {
    const settings = new ResearchSettingsService(db, secureStorage)
    const campus = new CampusAuthService(db, secureStorage)

    function username() {
        const account = accounts.getState()
        if (account.status !== 'signed-in' || !account.username) throw new Error('请先登录账号。')
        return account.username
    }

    async function state(): Promise<CampusState> {
        return campus.state(username())
    }

    ipcMain.handle('research:get', async (event): Promise<Result<ResearchSettings>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            return {ok: true, data: settings.get(await state())}
        } catch (error) {
            return {ok: false, error: error instanceof Error ? error.message : '无法读取旦挞设置。'}
        }
    })

    ipcMain.handle('research:save', async (event, input: unknown): Promise<Result<ResearchSettings>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            return {ok: true, data: await settings.save(input as ResearchSettingsInput, await state())}
        } catch (error) {
            return {ok: false, error: error instanceof Error ? error.message : '无法保存旦挞设置。'}
        } finally {
            if (input && typeof input === 'object' && 'searchApiKey' in input) {
                (input as { searchApiKey: string }).searchApiKey = ''
            }
        }
    })

    ipcMain.handle('research:campus-login', async (event, input: unknown): Promise<Result<CampusState>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const user = username()
            const checked = validateCampusLogin(input as CampusLoginInput)
            if (!checked.ok) throw new Error(checked.error)
            return {ok: true, data: await campus.login(user, checked.data.email, checked.data.password)}
        } catch (error) {
            return {ok: false, error: error instanceof Error ? error.message : '无法登录树洞。'}
        } finally {
            if (input && typeof input === 'object' && 'password' in input) {
                (input as { password: string }).password = ''
            }
        }
    })

    ipcMain.handle('research:campus-logout', async (event): Promise<Result<CampusState>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            return {ok: true, data: await campus.logout(username())}
        } catch (error) {
            return {ok: false, error: error instanceof Error ? error.message : '无法退出树洞。'}
        }
    })

    return {settings, campus}
}
