import {BrowserWindow, session, shell} from 'electron'
import {createHash} from 'node:crypto'
import {fudanWebmailUrl, isExternalMailLink, isWebmailNavigation} from './mail-web-policy'

const windows = new Map<string, BrowserWindow>()
export async function openWebmail(owner: string, currentOwner: () => string | null, mode: 'browser' | 'app', parent?: BrowserWindow): Promise<null> {
    if (currentOwner() !== owner) throw new Error('请先登录当前账号。')
    if (mode === 'browser') {await shell.openExternal(fudanWebmailUrl); return null}
    const existing = windows.get(owner)
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore()
        existing.show(); existing.focus(); return null
    }
    // A separate account-scoped session; no preload or application IPC bridge.
    const isolated = session.fromPartition('persist:fdunav-webmail-' + createHash('sha256').update(owner).digest('hex').slice(0, 24))
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    const webPreferences = {session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false}
    const window = new BrowserWindow({width: 1140, height: 820, minWidth: 360, minHeight: 420, show: false,
        autoHideMenuBar: true, title: '复旦邮箱 — FduNav', parent, webPreferences})
    const children = new Set<BrowserWindow>()
    function harden(target: BrowserWindow) {
        const guard = (event: Electron.Event, url: string) => {if (!isWebmailNavigation(url)) event.preventDefault()}
        target.webContents.on('will-navigate', guard); target.webContents.on('will-redirect', guard)
        target.webContents.setWindowOpenHandler(details => {
            if (isWebmailNavigation(details.url)) return {action: 'allow', overrideBrowserWindowOptions: {width: 960, height: 760, autoHideMenuBar: true, webPreferences}}
            if (isExternalMailLink(details.url) && ['foreground-tab', 'background-tab'].includes(details.disposition)) void shell.openExternal(details.url).catch(() => {})
            return {action: 'deny'}
        })
        target.webContents.on('did-create-window', child => {children.add(child); harden(child); child.once('closed', () => children.delete(child))})
    }
    harden(window); windows.set(owner, window)
    const watch = setInterval(() => {if (currentOwner() !== owner && !window.isDestroyed()) window.destroy()}, 250)
    window.once('closed', () => {
        clearInterval(watch); windows.delete(owner)
        for (const child of children) if (!child.isDestroyed()) child.destroy()
    })
    try {
        await window.loadURL(fudanWebmailUrl)
        if (currentOwner() !== owner || window.isDestroyed()) throw new Error('账号已变化。')
        window.show(); window.focus(); return null
    } catch {
        if (!window.isDestroyed()) window.destroy()
        throw new Error('应用内邮箱未能打开。请使用“在浏览器打开”，复用已有登录会话。')
    }
}
