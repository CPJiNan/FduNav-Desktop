import {BrowserWindow, session, type Session} from 'electron'
import type {CookieJar} from 'tough-cookie'
import {isAuthUrl, validateUrl} from './fudan-auth'
import {fetchNoticeImage, imageDataUrl} from './notice-image'
import {requestSourceImage} from './source-fetch'

const PARTITION = 'fdunav-reader'
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export async function clearReaderSession() {
    for (const window of readerWindows.values()) if (!window.isDestroyed()) window.destroy()
    readerWindows.clear()
    await session.fromPartition(PARTITION).clearStorageData({storages: ['cookies']})
}

interface SerializedCookie {
    key: string
    value: string
    domain?: string
    path?: string
    hostOnly?: boolean
    secure?: boolean
    httpOnly?: boolean
    expires?: string
}

async function seedCookies(jar: CookieJar, target: Session) {
    const serialized = jar.serializeSync()
    const cookies = (serialized?.cookies ?? []) as unknown as SerializedCookie[]
    for (const cookie of cookies) {
        const host = (cookie.domain || '').replace(/^\./, '')
        if (!host) continue
        const expires = cookie.expires && cookie.expires !== 'Infinity' ? new Date(cookie.expires) : null
        try {
            await target.cookies.set({
                url: `https://${host}${cookie.path || '/'}`,
                name: cookie.key,
                value: cookie.value,
                ...(cookie.hostOnly ? {} : {domain: cookie.domain}),
                path: cookie.path || '/',
                secure: cookie.secure !== false,
                httpOnly: !!cookie.httpOnly,
                ...(expires && !Number.isNaN(expires.getTime()) ? {expirationDate: expires.getTime() / 1000} : {}),
            })
        } catch {
        }
    }
}

export async function readAuthenticatedImage(url: string, referer: string, jar: CookieJar | null): Promise<string> {
    const host = new URL(url).hostname
    if (host !== 'fudan.edu.cn' && !host.endsWith('.fudan.edu.cn')) {
        return imageDataUrl(await requestSourceImage(url, referer))
    }
    const reader = session.fromPartition(PARTITION)
    if (jar) await seedCookies(jar, reader)
    return fetchNoticeImage(url, referer, (input, init) => reader.fetch(validateUrl(input), init))
}

export async function readAuthenticatedPage(value: string, jar: CookieJar | null): Promise<string | null> {
    if (!jar) return null
    const url = validateUrl(value)
    const targetHost = new URL(url).hostname
    const reader = session.fromPartition(PARTITION)
    await seedCookies(jar, reader)
    const window = new BrowserWindow({
        show: false,
        webPreferences: {session: reader, sandbox: true, contextIsolation: true, nodeIntegration: false},
    })
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    window.webContents.on('will-navigate', (event, next) => {
        try {
            validateUrl(next)
        } catch {
            event.preventDefault()
        }
    })
    try {
        void window.loadURL(url).catch(() => {
        })
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
            if (window.isDestroyed()) return null
            const current = window.webContents.getURL()
            if (current && !window.webContents.isLoading() && !isAuthUrl(current) &&
                new URL(current).hostname === targetHost) {
                const html: unknown = await window.webContents.executeJavaScript('document.documentElement.outerHTML')
                return typeof html === 'string' ? html : null
            }
            await wait(250)
        }
        return null
    } catch {
        return null
    } finally {
        if (!window.isDestroyed()) window.destroy()
    }
}

const readerWindows = new Map<string, BrowserWindow>()
const pendingPageLoads = new WeakMap<BrowserWindow, () => void>()

export async function openAuthenticatedPage(value: string, jar: CookieJar | null,
                                            parent?: BrowserWindow, title = '教学大纲'): Promise<void> {
    if (!jar) throw new Error('请先登录账号。')
    const url = validateUrl(value)
    const reader = session.fromPartition(PARTITION)
    await seedCookies(jar, reader)
    let pageWindow = readerWindows.get(title)
    if (pageWindow && !pageWindow.isDestroyed()) {
        if (pageWindow.isMinimized()) pageWindow.restore()
        pageWindow.show()
        pageWindow.focus()
        if (title === '校园卡消费记录') return
    } else {
        pageWindow = new BrowserWindow({
            width: 1100,
            height: 820,
            minWidth: 720,
            minHeight: 520,
            show: false,
            autoHideMenuBar: true,
            title,
            parent,
            webPreferences: {session: reader, sandbox: true, contextIsolation: true, nodeIntegration: false},
        })
        readerWindows.set(title, pageWindow)
        const openedWindow = pageWindow
        pageWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
        pageWindow.webContents.on('will-navigate', (event, next) => {
            try {
                validateUrl(next)
            } catch {
                event.preventDefault()
            }
        })
        pageWindow.once('ready-to-show', () => {
            if (!openedWindow.isDestroyed()) openedWindow.show()
        })
        pageWindow.on('closed', () => {
            readerWindows.delete(title)
        })
        if (title === '校园卡消费记录') {
            let returnedToRecords = false
            pageWindow.webContents.on('dom-ready', () => {
                if (openedWindow.isDestroyed() || returnedToRecords) return
                const current = new URL(openedWindow.webContents.getURL())
                if (current.origin === new URL(url).origin && /^\/epay\/(?:myepay(?:\/index)?\/?)?$/.test(current.pathname)) {
                    returnedToRecords = true
                    void openedWindow.loadURL(url).catch(() => {
                    })
                }
            })
        }
    }
    const loadingWindow = pageWindow
    pendingPageLoads.get(loadingWindow)?.()
    await new Promise<void>((resolve, reject) => {
        let finished = false
        const contents = loadingWindow.webContents
        const finish = (error?: Error) => {
            if (finished) return
            finished = true
            pendingPageLoads.delete(loadingWindow)
            contents.removeListener('dom-ready', ready)
            loadingWindow.removeListener('closed', closed)
            if (error) reject(error)
            else resolve()
        }
        const ready = () => finish()
        const closed = () => finish(new Error('窗口已关闭。'))
        pendingPageLoads.set(loadingWindow, () => finish(new Error('已切换页面。')))
        contents.once('dom-ready', ready)
        loadingWindow.once('closed', closed)
        void loadingWindow.loadURL(url).catch(error => {
            if (error?.code !== 'ERR_ABORTED') finish(error)
        })
    })
    if (!pageWindow.isDestroyed()) {
        pageWindow.show()
        pageWindow.focus()
    }
}

export async function readMyFudanPage(jar: CookieJar | null): Promise<string | null> {
    if (!jar) return null
    const url = validateUrl('https://my.fudan.edu.cn/')
    const reader = session.fromPartition(PARTITION)
    await seedCookies(jar, reader)
    const window = new BrowserWindow({
        show: false,
        webPreferences: {session: reader, sandbox: true, contextIsolation: true, nodeIntegration: false},
    })
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    window.webContents.on('will-navigate', (event, next) => {
        try {
            validateUrl(next)
        } catch {
            event.preventDefault()
        }
    })
    try {
        void window.loadURL(url).catch(() => {
        })
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
            if (window.isDestroyed()) return null
            const current = window.webContents.getURL()
            if (isAuthUrl(current)) return null
            if (current && !window.webContents.isLoading() && new URL(current).hostname === 'my.fudan.edu.cn') break
            await wait(250)
        }
        await wait(1500)
        const clicked = await window.webContents.executeJavaScript(`(() => {
            const target = [...document.querySelectorAll('a,button')]
                .find(element => /个人信息|我的信息|个人资料/.test(element.textContent || ''))
            if (!target) return false
            target.click()
            return true
        })()`).catch(() => false)
        if (clicked) await wait(1500)
        if (window.isDestroyed() || isAuthUrl(window.webContents.getURL())) return null
        const html: unknown = await window.webContents.executeJavaScript('document.documentElement.outerHTML')
        return typeof html === 'string' ? html : null
    } catch {
        return null
    } finally {
        if (!window.isDestroyed()) window.destroy()
    }
}

export async function readExamPage(jar: CookieJar | null): Promise<string | null> {
    if (!jar) return null
    const reader = session.fromPartition(PARTITION)
    await seedCookies(jar, reader)
    const window = new BrowserWindow({
        show: false,
        webPreferences: {session: reader, sandbox: true, contextIsolation: true, nodeIntegration: false},
    })
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    try {
        await window.loadURL('https://fdjwgl.fudan.edu.cn/student/home')
        await wait(1000)
        const clickDeadline = Date.now() + 6_000
        while (Date.now() < clickDeadline) {
            const clicked = await window.webContents.executeJavaScript(`(() => {
                const link = [...document.querySelectorAll('a')]
                    .find(item => (item.textContent || '').includes('考试信息'))
                if (link) {
                    link.click()
                    return true
                }
                return false
            })()`).catch(() => false)
            if (clicked) break
            await wait(250)
        }
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
            if (window.isDestroyed()) return null
            const html: unknown = await window.webContents.executeJavaScript(`(() => {
                for (const frame of document.querySelectorAll('iframe')) {
                    try {
                        if ((frame.getAttribute('src') || '').includes('exam-arrange') && frame.contentDocument) {
                            return frame.contentDocument.documentElement.outerHTML
                        }
                    } catch {
                    }
                }
                return null
            })()`).catch(() => null)
            if (typeof html === 'string' && /\d{4}[-/.年]\d{1,2}/.test(html) &&
                (html.includes('考试') || html.includes('考场'))) {
                return html
            }
            await wait(500)
        }
        return null
    } catch {
        return null
    } finally {
        if (!window.isDestroyed()) window.destroy()
    }
}
