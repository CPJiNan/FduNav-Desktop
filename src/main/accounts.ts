import {BrowserWindow, ipcMain, type IpcMainInvokeEvent} from 'electron'
import {CookieJar} from 'tough-cookie'
import type {AppDatabase} from './database'
import {
    AdditionalAuthenticationRequired,
    authenticate,
    AuthError,
    FudanTransport,
    isAuthUrl,
    verifySession
} from './fudan-auth'
import {completeInteractiveAuthentication} from './interactive-auth'
import {
    clearReaderSession,
    openAuthenticatedPage,
    readAuthenticatedImage,
    readAuthenticatedPage,
    readExamPage as readExamPageFromBrowser,
    readMyFudanPage as readMyFudanPageFromBrowser
} from './authenticated-page'
import type {AccountState, LoginInput, Result, Theme} from '../shared/accounts'
import {secureStorage} from './secure-storage'
import {readCampusCardWithBrowser} from './campus-card-browser'
import {syncMyFudanPreferences} from './my-fudan-preferences'

const signedOut = (): AccountState => ({username: null, status: 'signed-out', lastLogin: null, message: ''})

export class AccountService {
    private state = signedOut()
    private jar: CookieJar | null = null
    private target = ''
    private operationTail: Promise<void> = Promise.resolve()

    constructor(private db: AppDatabase) {
    }

    async initialize() {
        const saved = this.db.getAccount()
        if (saved) {
            this.state = {
                username: saved.username,
                lastLogin: saved.last_login,
                status: 'unverified',
                message: '登录已过期，请验证会话或重新登录。'
            }
            try {
                if (!await secureStorage.available()) throw new Error()
                this.jar = CookieJar.deserializeSync(JSON.parse(await secureStorage.decrypt(saved.cookies)))
                this.target = saved.target
            } catch {
                this.state.status = 'expired'
                this.state.message = '本地会话无法解密，请重新登录。'
            }
        }
    }

    getState() {
        return {...this.state}
    }

    async login(input: LoginInput, parent?: BrowserWindow) {
        return this.exclusive(async () => {
            if (!input || typeof input.username !== 'string' || typeof input.password !== 'string' ||
                !input.username.trim() || input.username.length > 128 || !input.password || input.password.length > 1024) {
                throw new AuthError('请输入有效的学号和密码。')
            }
            if (!await secureStorage.available()) {
                throw new AuthError('系统安全存储不可用，暂时无法安全保存登录会话。')
            }
            await clearReaderSession()
            const transport = new FudanTransport()
            const username = input.username.trim()
            let target: string
            let jar = transport.jar
            try {
                target = await authenticate(transport, username, input.password)
            } catch (error) {
                if (!(error instanceof AdditionalAuthenticationRequired)) throw error
                input.password = ''
                jar = await completeInteractiveAuthentication(error, transport.jar, parent)
                target = error.target
            } finally {
                input.password = ''
            }
            const lastLogin = new Date().toISOString()
            this.db.saveAccount({
                username,
                target,
                last_login: lastLogin,
                cookies: await secureStorage.encrypt(JSON.stringify(jar.serializeSync()))
            })
            this.jar = jar
            this.target = target
            this.state = {username, lastLogin, status: 'signed-in', message: '已登录复旦统一身份认证。'}
            return this.getState()
        })
    }

    async verify() {
        return this.exclusive(async () => {
            if (!this.jar || !this.state.username) throw new AuthError('请先登录账号。')
            try {
                const valid = await verifySession(new FudanTransport(this.jar), this.target)
                this.state = {
                    ...this.state,
                    status: valid ? 'signed-in' : 'expired',
                    message: valid ? '会话有效。' : '登录已过期，请重新登录。'
                }
                if (valid) this.db.saveAccount({
                    username: this.state.username!,
                    target: this.target,
                    last_login: this.state.lastLogin!,
                    cookies: await secureStorage.encrypt(JSON.stringify(this.jar.serializeSync()))
                })
                else {
                    this.jar = null;
                    this.db.clearAccount()
                }
            } catch (error) {
                this.state = {...this.state, status: 'unverified', message: '暂时无法验证会话，请检查网络后重试。'}
                throw error
            }
            return this.getState()
        })
    }

    async logout() {
        return this.exclusive(async () => {
            this.db.clearAccount()
            this.jar = null
            this.target = ''
            this.state = signedOut()
            await clearReaderSession()
            return this.getState()
        })
    }

    async readNotice(url: string): Promise<string | null> {
        return this.exclusive(async () => {
            const page = await new FudanTransport(this.jar ?? undefined).request(url)
            if (isAuthUrl(page.url)) {
                if (this.state.username) {
                    this.state = {...this.state, status: 'expired', message: '登录已过期，请重新登录。'}
                    this.jar = null
                    this.db.clearAccount()
                }
                return null
            }
            return page.text
        })
    }

    async readPage(url: string): Promise<string | null> {
        return this.exclusive(async () => {
            const page = await new FudanTransport(this.jar ?? undefined).request(url)
            return isAuthUrl(page.url) ? null : page.text
        })
    }

    async readPageWithBrowser(url: string): Promise<string | null> {
        return readAuthenticatedPage(url, this.jar)
    }

    async readExamPage(): Promise<string | null> {
        return readExamPageFromBrowser(this.jar)
    }

    async readMyFudanPage(): Promise<string | null> {
        return readMyFudanPageFromBrowser(this.jar)
    }

    async openPageWithBrowser(url: string, parent?: BrowserWindow): Promise<void> {
        await openAuthenticatedPage(url, this.jar, parent)
    }

    async openCampusCardRecords(parent?: BrowserWindow): Promise<void> {
        if (this.state.status !== 'signed-in' || !this.jar) throw new AuthError('请先登录账号。')
        await openAuthenticatedPage('https://ecard.fudan.edu.cn/epay/consume/index', this.jar, parent, '校园卡消费记录')
    }

    async readImage(url: string, referer: string): Promise<string> {
        return readAuthenticatedImage(url, referer, this.jar)
    }

    async readCampusCardBalance(interactive: boolean, parent?: BrowserWindow): Promise<string> {
        return this.exclusive(async () => {
            if (this.state.status !== 'signed-in' || !this.jar) throw new AuthError('请先登录账号。')
            const result = await readCampusCardWithBrowser(this.jar, interactive, parent)
            this.db.saveAccount({
                username: this.state.username!, target: this.target, last_login: this.state.lastLogin!,
                cookies: await secureStorage.encrypt(JSON.stringify(result.jar.serializeSync())),
            })
            this.jar = result.jar
            return result.balance
        })
    }

    async withServiceSession<T>(work: (read: <R>(url: string, parse: (text: string, link?: string) => R) => Promise<R>) => Promise<T>, parent?: BrowserWindow, interactive = true): Promise<T> {
        return this.exclusive(async () => {
            if (this.state.status !== 'signed-in' || !this.jar) throw new AuthError('请先登录账号。')
            let jar = CookieJar.deserializeSync(this.jar.serializeSync()!)
            const result = await work(async <R>(url: string, parse: (text: string, link?: string) => R): Promise<R> => {
                let page = await new FudanTransport(jar).request(url)
                if (isAuthUrl(page.url)) {
                    if (!interactive) throw new AuthError('请点击刷新同步 eLearning，在学校认证窗口完成登录。')
                    jar = await completeInteractiveAuthentication(new AdditionalAuthenticationRequired(page.url, url), jar, parent, async transport => {
                        const verified = await transport.request(url)
                        if (isAuthUrl(verified.url) || new URL(verified.url).origin !== new URL(url).origin) return false
                        parse(verified.text)
                        return true
                    })
                    page = await new FudanTransport(jar).request(url)
                }
                if (isAuthUrl(page.url) || new URL(page.url).origin !== new URL(url).origin) {
                    throw new AuthError('学校服务会话已失效，请重试。')
                }
                return parse(page.text, page.link)
            })
            this.db.saveAccount({
                username: this.state.username!, target: this.target, last_login: this.state.lastLogin!,
                cookies: await secureStorage.encrypt(JSON.stringify(jar.serializeSync()))
            })
            this.jar = jar
            return result
        })
    }

    private async exclusive<T>(work: () => Promise<T>): Promise<T> {
        const owner = JSON.stringify([this.state.username, this.state.lastLogin])
        const previous = this.operationTail
        let release!: () => void
        this.operationTail = new Promise<void>(resolve => {
            release = resolve
        })
        await previous
        try {
            if (JSON.stringify([this.state.username, this.state.lastLogin]) !== owner) {
                throw new AuthError('账号已变化，请重新发起请求。')
            }
            return await work()
        } finally {
            release()
        }
    }
}

export async function registerAccountHandlers(db: AppDatabase, trusted: (event: IpcMainInvokeEvent) => boolean) {
    const service = new AccountService(db)
    await service.initialize()

    function handle<T>(channel: string, action: (input: any, event: IpcMainInvokeEvent) => T | Promise<T>) {
        ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                return {ok: true, data: await action(input, event)}
            } catch (error) {
                return {ok: false, error: error instanceof AuthError ? error.message : '操作未完成，请重试。'}
            }
        })
    }

    handle('account:state', () => service.getState())
    handle('account:login', async (input: LoginInput, event) => {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const state = await service.login(input, parent)
        try {
            await syncMyFudanPreferences(service, db, parent)
        } catch {
        }
        return state
    })
    handle('account:verify', () => service.verify())
    handle('account:logout', () => service.logout())
    handle('preferences:get-theme', () => db.getTheme())
    handle('preferences:set-theme', (theme: Theme) => {
        if (!['light', 'dark', 'auto'].includes(theme)) throw new AuthError('主题选项无效。')
        db.setTheme(theme)
        return theme
    })
    return service
}
