import {BrowserWindow, session} from 'electron'
import type {AppDatabase} from './database'
import {secureStorage} from './secure-storage'
import {webvpnLoginUrl, webvpnRoute, isWebvpnHost} from './webvpn'
import {
    DantaError,
    nextOffsetFor,
    parseCampusHoles,
    parseCampusPosts,
    parseCourseGroup,
    parseCourseGroups,
    parseReviews,
    parseThreadMeta,
} from './danta-parse'
import {
    campusFeedNotice,
    campusPostNotice,
    communityFeeds,
    type CampusFeedPage,
    type CampusPage,
    type CourseGroupDetail,
    type CourseReviewsResult,
    type CourseSearchPage,
    type CommunityTransport,
    type CommunityTransportIssue,
    type DantaLoginInput,
    type DantaStatus,
    type SchoolNetworkState,
} from '../shared/danta'

export const AUTH_BASE = 'https://auth.fduhole.com/api'
export const FORUM_BASE = 'https://forum.fduhole.com/api'
export const DANKE_BASE = 'https://danke.fduhole.com/api'
const PARTITION = 'fdunav-danta'
const timeoutMs = 15_000
/** 直连探测要快：慢到 5 秒还不通，就当作不可直连，改走 WebVPN。 */
const directTimeoutMs = 5_000
const maxResponseBytes = 3 * 1024 * 1024

/**
 * iOA 一类企业网关会用 502/503 加 x-proxy-by 头返回拦截页。
 * 这里不能用 response.url 判断：Electron 的 net.fetch 不填充该字段（45.0.0 实测恒为空字符串），
 * redirected 标志同样不可靠，所以只能看响应本身。
 */
function isGatewayResponse(response: Response): boolean {
    return Boolean(response.headers.get('x-proxy-by')) || response.status === 502 || response.status === 503
}

/** 期望 JSON 却拿到 HTML，通常是被劫持到拦截页或登录页。 */
function looksLikeHtml(response: Response, body: string): boolean {
    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('html')) return true
    return /^\s*</.test(body.slice(0, 64))
}

interface Tokens {
    access: string
    refresh: string
}

const text = (value: unknown) => typeof value === 'string' ? value : ''

export interface DantaSession {
    searchPosts(query: string, offset: number, limit: number): Promise<CampusPage>
    readThread(holeId: number, offset: number, limit: number): Promise<CampusPage>
    searchCourses(query: string, page: number, pageSize: number): Promise<CourseSearchPage>
    courseGroup(id: number): Promise<CourseGroupDetail>
    courseReviews(courseId: number, pageLimit?: number): Promise<CourseReviewsResult>
}

/** 社区账号与学校 WebVPN 通路是两套凭据；token 只在这里解密、只在这里使用。 */
export class DantaService implements DantaSession {
    private school: SchoolNetworkState = 'unknown'
    private transport: CommunityTransport = 'unknown'
    private transportIssue: CommunityTransportIssue | null = null
    private schoolMessage = ''
    private tokens: Tokens | null = null
    /** 同一时刻只允许一次通路探测，避免并发请求各自打开探测。 */
    private probing: Promise<void> | null = null
    private email: string | null = null
    private lastLogin: string | null = null
    private expired = false
    private loginWindow: BrowserWindow | null = null
    private refreshing: Promise<void> | null = null
    private offerings = new Map<number, import('../shared/danta').CourseOffering>()

    constructor(private db: AppDatabase) {
    }

    async initialize() {
        const saved = this.db.getCommunityAuth()
        if (!saved) return
        this.email = saved.email
        this.lastLogin = saved.updatedAt
        try {
            if (!await secureStorage.available()) throw new Error()
            const value = JSON.parse(await secureStorage.decrypt(saved.tokens)) as Partial<Tokens>
            if (typeof value.access !== 'string' || typeof value.refresh !== 'string' ||
                !value.access || !value.refresh) throw new Error()
            this.tokens = {access: value.access, refresh: value.refresh}
        } catch {
            this.expired = true
            this.tokens = null
        }
    }

    status(): DantaStatus {
        const message = this.expired ? '社区登录已失效，请重新登录。'
            : !this.tokens ? (this.schoolMessage || '尚未连接校园社区账号。')
                : this.school === 'login-required' ? '学校网络会话已失效，查询前需要重新登录学校网络。'
                    : this.schoolMessage || '校园社区账号已连接。'
        return {
            school: this.school,
            transport: this.transport,
            transportIssue: this.transportIssue,
            account: this.tokens ? (this.expired ? 'expired' : 'connected') : 'signed-out',
            email: this.email,
            lastLogin: this.lastLogin,
            message,
            agentEnabled: this.db.getCommunityAgentEnabled(),
            waitingLogin: this.loginWindow !== null && !this.loginWindow.isDestroyed(),
        }
    }

    /** Agent 工具要同时满足：开关打开、社区账号已连接、学校通路可用。 */
    agentToolState(): {enabled: boolean; reason: string} {
        if (!this.db.getCommunityAgentEnabled()) return {enabled: false, reason: '社区只读工具未在设置中启用。'}
        if (!this.tokens || this.expired) return {enabled: false, reason: '请先在设置中连接校园社区账号。'}
        return {enabled: true, reason: ''}
    }

    private campusSession() {
        return session.fromPartition(PARTITION)
    }

    async connectSchool(parent?: BrowserWindow): Promise<DantaStatus> {
        const existing = this.loginWindow
        if (existing && !existing.isDestroyed()) {
            existing.show(); existing.focus()
            return this.status()
        }
        this.school = 'checking'
        this.schoolMessage = '正在打开学校 WebVPN 登录窗口…'
        const partition = this.campusSession()
        const window = new BrowserWindow({
            width: 1120, height: 800, title: '复旦 WebVPN 登录',
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            webPreferences: {session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true},
        })
        this.loginWindow = window
        window.on('page-title-updated', event => event.preventDefault())
        window.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
        window.webContents.on('will-navigate', (event, value) => {
            let host = ''
            try {host = new URL(value).hostname} catch {
            }
            if (!['webvpn.fudan.edu.cn', 'id.fudan.edu.cn', 'uis.fudan.edu.cn'].includes(host)) event.preventDefault()
        })
        window.webContents.on('did-finish-load', () => {
            void this.afterSchoolPageLoad(window)
        })
        window.on('closed', () => {
            if (this.loginWindow === window) this.loginWindow = null
        })
        void window.loadURL(webvpnLoginUrl).catch(() => {
            this.school = 'unavailable'
            this.schoolMessage = '无法打开学校 WebVPN 登录页，请检查网络后重试。'
        })
        return this.status()
    }

    private async afterSchoolPageLoad(window: BrowserWindow) {
        if (window.isDestroyed()) return
        let url: URL
        try {
            url = new URL(window.webContents.getURL())
        } catch {
            return
        }
        if (!isWebvpnHost(url.href) || url.pathname.startsWith('/login')) return
        try {
            await this.probeSchool()
        } catch {
            return
        }
        if (this.school === 'ready' && !window.isDestroyed()) window.close()
    }

    /**
     * 直连探测：向蛋挞课程搜索发一次未认证请求。只要拿到落在社区域名上的 HTTP 响应，
     * 就说明网络本身可达——401 只代表没登录，不代表网络不通。
     * 失败要区分原因：网关拦截、TLS 被打断、超时、解析或建连失败，对应的处理方式完全不同。
     */
    private async probeDirect(): Promise<{ok: boolean; issue: CommunityTransportIssue | null}> {
        try {
            const response = await this.campusSession().fetch(
                `${DANKE_BASE}/v3/course_groups/search?query=${encodeURIComponent('概率论')}&page=1&page_size=1`,
                {
                    method: 'GET',
                    redirect: 'follow',
                    signal: AbortSignal.timeout(directTimeoutMs),
                    headers: {Accept: 'application/json', 'User-Agent': 'FduNav/0.1 (desktop)'},
                })
            // 不能靠 response.url 判断落点（Electron 的 net.fetch 恒返回空串），
            // 只能反过来问：这个响应像不像我们要的 API 响应？
            if (isGatewayResponse(response)) return {ok: false, issue: 'gateway'}
            let body = ''
            try {
                body = (await response.text()).slice(0, 4096)
            } catch {
                // 读不到正文就按普通网络失败处理，不影响后面的 WebVPN 回退。
            }
            if (/M0003|AIO-Forward|智能网关/.test(body)) return {ok: false, issue: 'gateway'}
            if (looksLikeHtml(response, body)) return {ok: false, issue: 'network'}
            // 401/400 都说明网络可达，只是没登录或参数不对。
            return {ok: true, issue: null}
        } catch (error) {
            const cause = (error as {cause?: {code?: string}} | null)?.cause
            const signal = [
                cause?.code ?? '',
                error instanceof Error ? error.name : '',
                error instanceof Error ? error.message : '',
            ].join(' ')
            if (/TIMEOUT|TimeoutError|TIME/i.test(signal)) return {ok: false, issue: 'timeout'}
            if (/SSL|TLS|CERT|WRONG_VERSION/i.test(signal)) return {ok: false, issue: 'tls'}
            return {ok: false, issue: 'network'}
        }
    }

    /** 先试直连，不通再退回学校 WebVPN；两条路都不需要用户额外操作。 */
    async probeSchool(): Promise<DantaStatus> {
        this.school = 'checking'
        this.schoolMessage = '正在检测网络通路…'
        if (this.probing) {
            await this.probing
            return this.status()
        }
        this.probing = (async () => {
            const direct = await this.probeDirect()
            this.transportIssue = direct.ok ? null : direct.issue
            if (direct.ok) {
                this.transport = 'direct'
                this.school = 'ready'
                this.schoolMessage = '可以直连旦挞社区，无需登录学校网络。'
                return
            }
            this.transport = 'webvpn'
            await this.probeViaWebvpn()
        })().finally(() => {
            this.probing = null
        })
        await this.probing
        return this.status()
    }

    private async probeViaWebvpn(): Promise<void> {
        try {
            await this.send('GET', `${DANKE_BASE}/v3/course_groups/search?query=${encodeURIComponent('概率论')}&page=1&page_size=1`)
            this.school = 'ready'
            this.schoolMessage = '学校网络已连接。'
        } catch (error) {
            if (error instanceof DantaError && (error.code === 'school_login_required' || error.code === 'network' || error.code === 'timeout')) {
                this.school = error.code === 'school_login_required' ? 'login-required' : 'unavailable'
                this.schoolMessage = error.code === 'school_login_required'
                    ? '直连不可用，需要先连接到学校网络（WebVPN）。'
                    : '直连不可用，也连不上学校 WebVPN，请检查网络后重试。'
            } else if (error instanceof DantaError && ['auth', 'forbidden', 'not_found'].includes(error.code)) {
                // 学校通路正常，只是社区 token 未登录或被拒绝。
                this.school = 'ready'
                this.schoolMessage = '学校网络已连接。'
            } else {
                this.school = 'unavailable'
                this.schoolMessage = '无法连接学校 WebVPN，请检查网络后重试。'
            }
        }
    }

    async login(input: DantaLoginInput): Promise<DantaStatus> {
        const email = typeof input?.email === 'string' ? input.email.trim() : ''
        const password = typeof input?.password === 'string' ? input.password : ''
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 || !password || password.length > 1024) {
            throw new DantaError('invalid_input', '请输入有效的社区邮箱和密码。')
        }
        try {
            if (!await secureStorage.available()) throw new DantaError('unavailable', '系统安全存储不可用，无法安全保存社区登录。')
            if (this.school !== 'ready') await this.probeSchool()
            if (this.school !== 'ready') throw new DantaError('school_login_required', '请先点击「连接学校网络」并完成 WebVPN 登录。')
            const payload = JSON.stringify({email, password})
            let raw: unknown
            try {
                raw = await this.send('POST', `${AUTH_BASE}/login`, payload)
            } finally {
                // 密码只在本次请求体内出现。
            }
            const value = (raw ?? {}) as Record<string, unknown>
            if (typeof value.access !== 'string' || typeof value.refresh !== 'string' ||
                !value.access || !value.refresh ||
                [value.access, value.refresh].some(item => (item as string).length > 8192 || /[\x00-\x20\x7f]/.test(item as string))) {
                throw new DantaError('schema', '社区登录返回的凭据格式发生变化。')
            }
            this.tokens = {access: value.access, refresh: value.refresh}
            this.expired = false
            this.email = email
            this.lastLogin = new Date().toISOString()
            this.schoolMessage = this.transport === 'direct'
                ? '直连旦挞社区可用，社区账号已登录。'
                : '学校网络已连接，社区账号已登录。'
            await this.db.saveCommunityAuth(email, await secureStorage.encrypt(JSON.stringify(this.tokens)))
            return this.status()
        } finally {
            input.password = ''
        }
    }

    async logout(): Promise<DantaStatus> {
        this.tokens = null
        this.expired = false
        this.email = null
        this.lastLogin = null
        this.offerings.clear()
        this.db.clearCommunityAuth()
        this.schoolMessage = '已断开校园社区账号。'
        return this.status()
    }

    setAgentEnabled(enabled: boolean): DantaStatus {
        if (typeof enabled !== 'boolean') throw new DantaError('invalid_input', '开关状态无效。')
        this.db.setCommunityAgentEnabled(enabled)
        return this.status()
    }

    private async accessToken(): Promise<string> {
        if (!this.tokens || this.expired) throw new DantaError('login_required', '请先在设置中连接校园社区账号。')
        return this.tokens.access
    }

    private async refresh(): Promise<void> {
        if (!this.tokens) throw new DantaError('login_required', '请先在设置中连接校园社区账号。')
        if (this.refreshing) return this.refreshing
        this.refreshing = (async () => {
            const refresh = this.tokens!.refresh
            let raw: unknown
            try {
                raw = await this.send('POST', `${AUTH_BASE}/refresh`, undefined,
                    {Authorization: `Bearer ${refresh}`})
            } catch (error) {
                if (error instanceof DantaError && ['auth', 'forbidden'].includes(error.code)) {
                    this.expired = true
                    this.tokens = null
                    throw new DantaError('login_required', '社区登录已失效，请重新登录。')
                }
                throw error
            }
            const value = (raw ?? {}) as Record<string, unknown>
            if (typeof value.access !== 'string' || typeof value.refresh !== 'string' || !value.access || !value.refresh) {
                this.expired = true
                this.tokens = null
                throw new DantaError('login_required', '社区登录已失效，请重新登录。')
            }
            this.tokens = {access: value.access, refresh: value.refresh}
            this.expired = false
            if (this.email) await this.db.saveCommunityAuth(this.email, await secureStorage.encrypt(JSON.stringify(this.tokens)))
        })().finally(() => {
            this.refreshing = null
        })
        return this.refreshing
    }

    private async get(url: string, retry = true): Promise<unknown> {
        const access = await this.accessToken()
        try {
            return await this.send('GET', url, undefined, {Authorization: `Bearer ${access}`})
        } catch (error) {
            if (error instanceof DantaError && error.code === 'auth' && retry) {
                await this.refresh()
                return this.get(url, false)
            }
            throw error
        }
    }

    private async send(method: 'GET' | 'POST', url: string, body?: string, headers: Record<string, string> = {}): Promise<unknown> {
        // 还没确定通路时先探一次，避免第一次查询直接失败。
        if (this.transport === 'unknown') await this.probeSchool()
        let route: string
        try {
            // 只要白名单内主机的固定路径；webvpnRoute 同时拒绝其他主机与端口。
            const parsed = new URL(url)
            if (!this.allowed(method, parsed)) throw new DantaError('forbidden', '不允许请求这个社区接口。')
            route = this.transport === 'webvpn' ? webvpnRoute(url) : url
        } catch (error) {
            if (error instanceof DantaError) throw error
            throw new DantaError('forbidden', '不允许请求这个社区接口。')
        }
        let response: Response
        try {
            response = await this.campusSession().fetch(route, {
                method,
                redirect: 'follow',
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'FduNav/0.1 (desktop)',
                    ...(body ? {'Content-Type': 'application/json'} : {}),
                    ...headers,
                },
                ...(body ? {body} : {}),
            })
        } catch (error) {
            // 直连在请求阶段就失败，说明当前网络变了；退回 WebVPN，让下次探测重新选择。
            if (this.transport === 'direct') this.transport = 'webvpn'
            if (error instanceof DOMException && error.name === 'TimeoutError') {
                throw new DantaError('timeout', '社区服务请求超时，请稍后重试。')
            }
            throw new DantaError('network', '暂时无法连接社区服务，请检查学校网络后重试。')
        }
        const buffer = new Uint8Array(await response.arrayBuffer().catch(() => new Uint8Array()))
        if (buffer.byteLength > maxResponseBytes) throw new DantaError('too_large', '社区服务返回内容过大，已停止读取。')
        const payload = Buffer.from(buffer).toString('utf8')
        // Electron 的 net.fetch 不填充 response.url，没法用最终 URL 判断是否被重定向，
        // 于是改成检查内容：该给 JSON 的接口返回 HTML，就是登录页或拦截页。
        if (looksLikeHtml(response, payload) || isGatewayResponse(response)) {
            if (this.transport === 'webvpn') {
                this.school = 'login-required'
                this.schoolMessage = '学校网络会话已失效，请重新登录学校网络。'
                throw new DantaError('school_login_required', '学校 WebVPN 会话已失效，请重新登录学校网络。')
            }
            // 直连被劫持到别处，说明这条路现在不可用。
            this.transport = 'webvpn'
            this.school = 'unknown'
            this.schoolMessage = '直连旦挞社区失败，已改用学校 WebVPN 通路。'
            throw new DantaError('network', '直连旦挞社区失败，已切回学校 WebVPN 通路，请重试。')
        }
        this.checkStatus(response.status)
        if (!buffer.byteLength) return null
        try {
            return JSON.parse(payload)
        } catch {
            throw new DantaError('schema', '社区服务没有返回有效 JSON。')
        }
    }

    private allowed(method: 'GET' | 'POST', url: URL): boolean {
        if (url.username || url.password || url.port || url.hash) return false
        if (method === 'POST') {
            return url.origin === 'https://auth.fduhole.com' && ['/api/login', '/api/refresh'].includes(url.pathname)
        }
        if (url.origin === 'https://forum.fduhole.com') {
            return url.pathname === '/api/floors/search' ||
                url.pathname === '/api/holes' ||
                url.pathname === '/api/holes/_homepage' ||
                /^\/api\/holes\/[1-9]\d*(?:\/floors)?$/.test(url.pathname)
        }
        if (url.origin === 'https://danke.fduhole.com') {
            return url.pathname === '/api/v3/course_groups/search' ||
                /^\/api\/v3\/course_groups\/[1-9]\d*$/.test(url.pathname) ||
                /^\/api\/courses\/[1-9]\d*\/reviews$/.test(url.pathname)
        }
        return false
    }

    private checkStatus(status: number) {
        if (status >= 200 && status < 300) return
        if (status === 401) throw new DantaError('auth', '社区登录已失效，请重新登录。', status)
        if (status === 403) throw new DantaError('forbidden', '当前社区账号无权访问该内容。', status)
        if (status === 404) throw new DantaError('not_found', '内容不存在或已被删除。', status)
        if (status === 429) throw new DantaError('rate_limited', '社区服务请求过于频繁，请稍后再试。', status)
        if (status >= 500) throw new DantaError('unavailable', '社区服务暂时不可用，请稍后再试。', status)
        throw new DantaError('unavailable', `社区服务返回异常状态（HTTP ${status}）。`, status)
    }

    async searchPosts(query: string, offset = 0, limit = 10): Promise<CampusPage> {
        if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new DantaError('invalid_input', '请输入 1–500 字的检索词。')
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647) throw new DantaError('invalid_input', '分页位置无效。')
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DantaError('invalid_input', '每页数量需在 1–20 之间。')
        const params = new URLSearchParams({search: query.trim(), offset: String(offset), size: String(limit)})
        const raw = await this.get(`${FORUM_BASE}/floors/search?${params}`)
        const results = parseCampusPosts(raw, {limit})
        return {
            results, offset, limit, rawCount: Array.isArray(raw) ? raw.length : 0,
            nextOffset: nextOffsetFor(offset, limit, Array.isArray(raw) ? raw.length : 0),
            complete: false, notice: campusPostNotice, thread: null,
        }
    }

    /**
     * 常驻分区：精选读 /holes/_homepage，其余按标签读 /holes。
     * 服务端一次最多返回 10 条且不认 length>10，所以 limit 上限收紧为 10。
     */
    async feed(feedId: string, cursor: string | null = null, limit = 10): Promise<CampusFeedPage> {
        const feed = communityFeeds.find(item => item.id === feedId)
        if (!feed) throw new DantaError('invalid_input', '未知的树洞分区。')
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new DantaError('invalid_input', '每页数量需在 1–10 之间。')
        if (cursor !== null && (typeof cursor !== 'string' || Number.isNaN(Date.parse(cursor)))) {
            throw new DantaError('invalid_input', '分页位置无效。')
        }
        let raw: unknown
        if (feed.kind === 'homepage') {
            raw = await this.get(`${FORUM_BASE}/holes/_homepage?size=${limit}`)
        } else {
            const params = new URLSearchParams({length: String(limit), tag: feed.tag ?? ''})
            if (cursor) params.set('start_time', cursor)
            raw = await this.get(`${FORUM_BASE}/holes?${params}`)
        }
        const results = parseCampusHoles(raw, {limit})
        const oldest = results.reduce<string | null>((acc, item) =>
            acc === null || Date.parse(item.timeCreated) < Date.parse(acc) ? item.timeCreated : acc, null)
        return {
            feedId,
            results,
            limit,
            cursor: oldest,
            rawCount: Array.isArray(raw) ? raw.length : 0,
            notice: campusFeedNotice,
        }
    }

    async readThread(holeId: number, offset = 0, limit = 10): Promise<CampusPage> {
        if (!Number.isSafeInteger(holeId) || holeId < 1) throw new DantaError('invalid_input', '帖子编号无效。')
        if (!Number.isSafeInteger(offset) || offset < 0) throw new DantaError('invalid_input', '分页位置无效。')
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DantaError('invalid_input', '每页数量需在 1–20 之间。')
        const thread = parseThreadMeta(await this.get(`${FORUM_BASE}/holes/${holeId}`), holeId)
        const params = new URLSearchParams({offset: String(offset), size: String(limit)})
        const raw = await this.get(`${FORUM_BASE}/holes/${holeId}/floors?${params}`)
        const results = parseCampusPosts(raw, {limit, holeId})
        return {
            results, offset, limit, rawCount: Array.isArray(raw) ? raw.length : 0,
            nextOffset: nextOffsetFor(offset, limit, Array.isArray(raw) ? raw.length : 0),
            complete: false, notice: campusPostNotice, thread,
        }
    }

    async searchCourses(query: string, page = 1, pageSize = 10): Promise<CourseSearchPage> {
        if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new DantaError('invalid_input', '请输入 1–200 字的课程关键词。')
        if (!Number.isInteger(page) || page < 1 || page > 200) throw new DantaError('invalid_input', '页码无效。')
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new DantaError('invalid_input', '每页数量需在 1–20 之间。')
        const params = new URLSearchParams({query: query.trim(), page: String(page), page_size: String(pageSize)})
        const raw = await this.get(`${DANKE_BASE}/v3/course_groups/search?${params}`)
        const parsed = parseCourseGroups(raw, pageSize)
        return {page, pageSize, total: parsed.total, items: parsed.items}
    }

    async courseGroup(id: number): Promise<CourseGroupDetail> {
        if (!Number.isSafeInteger(id) || id < 1) throw new DantaError('invalid_input', '课程组编号无效。')
        const detail = parseCourseGroup(await this.get(`${DANKE_BASE}/v3/course_groups/${id}`))
        for (const course of detail.courses) this.remember(course)
        return detail
    }

    async courseReviews(courseId: number, pageLimit = 100): Promise<CourseReviewsResult> {
        if (!Number.isSafeInteger(courseId) || courseId < 1) throw new DantaError('invalid_input', '开课编号无效。')
        const raw = await this.get(`${DANKE_BASE}/courses/${courseId}/reviews`)
        if (!Array.isArray(raw)) throw new DantaError('schema', '社区服务返回的数据格式发生变化，已停止解析。')
        const items = raw.length > pageLimit ? raw.slice(0, pageLimit) : raw
        const parsed = parseReviews(items, Math.max(items.length, 1))
        return {
            course: this.offerings.get(courseId) ?? {
                id: courseId, name: '', code: '', codeId: null, credit: null, department: '', teachers: '',
                year: null, semester: null, reviewCount: parsed.reviews.length,
            },
            reviews: parsed.reviews,
            truncated: parsed.truncated || raw.length > items.length,
        }
    }

    private remember(course: import('../shared/danta').CourseOffering) {
        this.offerings.set(course.id, course)
        if (this.offerings.size > 500) this.offerings.delete(this.offerings.keys().next().value!)
    }

    getPlan(username: string): import('../shared/danta').PlanItem[] {
        return this.db.getCommunityPlan(username)
    }

    savePlan(username: string, value: unknown): import('../shared/danta').PlanItem[] {
        if (!Array.isArray(value) || value.length > 60) throw new DantaError('invalid_input', '备选清单格式无效。')
        const items: import('../shared/danta').PlanItem[] = []
        const seen = new Set<number>()
        for (const entry of value) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new DantaError('invalid_input', '备选清单格式无效。')
            const item = entry as Record<string, unknown>
            const courseId = Number(item.courseId), groupId = Number(item.groupId)
            if (!Number.isSafeInteger(courseId) || courseId < 1 || !Number.isSafeInteger(groupId) || groupId < 1 || seen.has(courseId)) {
                throw new DantaError('invalid_input', '备选清单中的课程编号无效。')
            }
            const str = (key: string, max: number) => {
                const raw = item[key]
                if (typeof raw !== 'string' || raw.length > max) throw new DantaError('invalid_input', '备选清单中的课程信息无效。')
                return raw
            }
            seen.add(courseId)
            items.push({
                courseId, groupId,
                groupName: str('groupName', 200), name: str('name', 200), teachers: str('teachers', 200),
                term: str('term', 100), note: str('note', 500),
                addedAt: typeof item.addedAt === 'string' && !Number.isNaN(Date.parse(item.addedAt)) ? item.addedAt : new Date().toISOString(),
            })
        }
        this.db.saveCommunityPlan(username, items)
        return items
    }
}

export function communityErrorText(error: unknown): string {
    return error instanceof DantaError ? error.message : '社区服务操作未完成，请稍后重试。'
}

export const communityLoginText = (email: string | null) => email ? `已连接 ${email}` : text('')
