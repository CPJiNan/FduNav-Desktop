import {app, ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {AppDatabase} from './database'
import type {Result} from '../shared/accounts'
import {type GeneralSettings, isCloseAction, normalizeSidebarItems} from '../shared/general-settings'

export function registerGeneralSettingsHandlers(db: AppDatabase, trusted: (event: IpcMainInvokeEvent) => boolean) {
    const launchAtLoginAvailable = app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
    const loginOptions = {path: process.execPath, args: [] as string[]}

    function get(): GeneralSettings {
        const login = launchAtLoginAvailable ? app.getLoginItemSettings(loginOptions) : null
        return {
            launchAtLogin: !!login?.openAtLogin && (process.platform !== 'win32' || login.executableWillLaunchAtLogin),
            launchAtLoginAvailable,
            closeAction: db.getCloseAction(),
            sidebar: db.getSidebarItems(),
        }
    }

    function handle(channel: string, action: (input: unknown) => GeneralSettings) {
        ipcMain.handle(channel, (event, input): Result<GeneralSettings> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                return {ok: true, data: action(input)}
            } catch (error) {
                return {ok: false, error: error instanceof Error ? error.message : '无法保存通用设置，请重试。'}
            }
        })
    }

    handle('settings:get-general', get)
    handle('settings:set-launch-at-login', input => {
        if (typeof input !== 'boolean') throw new Error('开机启动设置无效。')
        if (!launchAtLoginAvailable) throw new Error('请在支持开机启动的系统中使用 FduNav 安装版设置此选项。')
        app.setLoginItemSettings({...loginOptions, openAtLogin: input, enabled: input, name: 'FduNav'})
        const settings = get()
        if (settings.launchAtLogin !== input) throw new Error('开机启动设置未生效，请检查系统的启动应用设置。')
        return settings
    })
    handle('settings:set-close-action', input => {
        if (!isCloseAction(input)) throw new Error('关闭方式无效。')
        db.setCloseAction(input)
        return get()
    })
    handle('settings:set-sidebar', input => {
        if (!Array.isArray(input)) throw new Error('侧边栏图标设置无效。')
        db.setSidebarItems(normalizeSidebarItems(input))
        return get()
    })
}
