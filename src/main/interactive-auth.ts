import {randomUUID} from 'node:crypto'
import {BrowserWindow, session} from 'electron'
import type {CookieJar} from 'tough-cookie'
import type {AdditionalAuthenticationRequired, Transport} from './fudan-auth.ts'
import {AuthError, FudanTransport, validateUrl, verifySession} from './fudan-auth.ts'
import {browserCookieJar, browserCookies} from './auth-cookies.ts'

export async function completeInteractiveAuthentication(
    challenge: AdditionalAuthenticationRequired, jar: CookieJar, parent?: BrowserWindow,
    verify: (transport: Transport) => Promise<boolean> = verifySession,
): Promise<CookieJar> {
    const loginUrl = validateUrl(challenge.loginUrl)
    const target = validateUrl(challenge.target)
    const targetOrigin = new URL(target).origin
    const browserSession = session.fromPartition(`fdunav-auth-${randomUUID()}`, {cache: false})
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', event => event.preventDefault())
    let window: BrowserWindow | undefined
    try {
        for (const cookie of browserCookies(jar)) await browserSession.cookies.set(cookie)
        if (parent?.isDestroyed()) throw new AuthError('已取消学校身份验证。')
        const authWindow = new BrowserWindow({
            width: 960, height: 760, minWidth: 480, minHeight: 540,
            title: '复旦统一身份认证', autoHideMenuBar: true,
            ...(parent ? {parent, modal: true} : {}),
            webPreferences: {
                session: browserSession, sandbox: true, contextIsolation: true,
                nodeIntegration: false, webviewTag: false,
            },
        })
        window = authWindow
        authWindow.setMenu(null)
        return await new Promise<CookieJar>((resolve, reject) => {
            const controller = new AbortController()
            let settled = false
            let checking = false
            const finish = (error?: AuthError, cookies?: CookieJar) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                controller.abort()
                parent?.removeListener('closed', cancel)
                if (!authWindow.isDestroyed()) authWindow.destroy()
                if (error) reject(error)
                else resolve(cookies!)
            }
            const cancel = () => finish(new AuthError('已取消学校身份验证。'))
            const timer = setTimeout(() => finish(new AuthError('学校身份验证超时，请重新登录。')), 5 * 60_000)
            parent?.once('closed', cancel)
            authWindow.once('closed', cancel)
            authWindow.webContents.on('render-process-gone', () => finish(new AuthError('认证窗口异常退出，请重试。')))

            const allowed = (value: string) => {
                try {
                    validateUrl(value)
                    return true
                } catch {
                    return false
                }
            }
            authWindow.webContents.on('will-frame-navigate', event => {
                if (event.isMainFrame && !allowed(event.url)) {
                    event.preventDefault()
                    finish(new AuthError('认证跳转到了非 HTTPS 复旦地址，已停止登录。'))
                }
            })
            authWindow.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
                if (mainFrame && !allowed(url)) {
                    event.preventDefault()
                    finish(new AuthError('认证跳转到了非 HTTPS 复旦地址，已停止登录。'))
                }
            })
            authWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
            authWindow.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
                if (mainFrame && code !== -3) finish(new AuthError('无法加载学校认证页面，请检查网络后重试。'))
            })

            const checkSession = async () => {
                if (settled || checking || authWindow.isDestroyed() || authWindow.webContents.isLoading()) return
                const current = authWindow.webContents.getURL()
                if (!allowed(current) || new URL(current).origin !== targetOrigin) return
                checking = true
                try {
                    const cookies = await browserCookieJar(await browserSession.cookies.get({}))
                    if (settled) return
                    const transport = new FudanTransport(cookies, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
                    if (!await verify(transport)) {
                        throw new AuthError('认证后未能建立目标网站会话，请重新登录。')
                    }
                    finish(undefined, cookies)
                } catch (error) {
                    finish(error instanceof AuthError ? error : new AuthError('无法同步学校登录会话，请重试。'))
                } finally {
                    checking = false
                }
            }
            authWindow.webContents.on('did-stop-loading', () => {
                void checkSession()
            })
            authWindow.webContents.on('did-navigate-in-page', () => {
                void checkSession()
            })
            void authWindow.loadURL(loginUrl).catch(error => {
                if (error?.code !== 'ERR_ABORTED') finish(new AuthError('无法加载学校认证页面，请检查网络后重试。'))
            })
        })
    } finally {
        if (window && !window.isDestroyed()) window.destroy()
        await browserSession.clearStorageData().catch(() => {
        })
        await browserSession.closeAllConnections().catch(() => {
        })
    }
}
