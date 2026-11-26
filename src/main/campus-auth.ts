import {setTimeout as delay} from 'node:timers/promises'
import type {AppDatabase} from './database'
import type {SecretStorage} from './llm-settings'
import {ResearchError} from './research-error'
import {type CampusAuthStatus, type CampusState, readCampusTokens} from '../shared/research'

const AUTH_BASE = 'https://auth.fduhole.com/api'
const FORUM_BASE = 'https://forum.fduhole.com/api'
const DANKE_BASE = 'https://danke.fduhole.com/api'
const forumPath = /^\/(?:floors\/search|holes\/[1-9][0-9]{0,18}(?:\/floors)?)$/
const dankePath = /^\/(?:v3\/course_groups\/search|v3\/course_groups\/[1-9][0-9]{0,18}|courses\/[A-Za-z0-9_-]{1,64}\/reviews)$/

interface Tokens {
    access: string
    refresh: string
    email: string | null
}

function tokenEmail(token: string): string | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
        const value = payload.email ?? payload.preferred_username
        return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320 ? value : null
    } catch {
        return null
    }
}

export class CampusAuthService {
    private tokens = new Map<string, Tokens>()
    private statuses = new Map<string, CampusAuthStatus>()
    private invalidAccess = new Map<string, string>()
    private refreshing = new Map<string, Promise<void>>()

    private generations = new Map<string, number>()

    constructor(private db: AppDatabase, private secrets: SecretStorage, private request: typeof fetch = fetch) {
    }

    async state(username: string): Promise<CampusState> {
        const tokens = await this.load(username)
        const status = this.statuses.get(username) ?? (tokens ? 'configured' : 'missing')
        return {status, loggedIn: status === 'configured', email: tokens?.email ?? null}
    }

    hint(username: string): CampusState {
        const status = this.statuses.get(username) ?? (this.db.getCampusTokens(username) ? 'configured' : 'missing')
        return {status, loggedIn: status === 'configured', email: this.tokens.get(username)?.email ?? null}
    }

    async login(username: string, email: string, password: string): Promise<CampusState> {
        const generation = this.begin(username)
        const response = await this.fetchOnce(`${AUTH_BASE}/login`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({email, password})
        }, 30_000)
        if ([400, 401, 403].includes(response.status)) {
            throw new ResearchError('campus_login_failed', '旦挞登录失败，请检查邮箱、密码及账号状态后重试。', 401)
        }
        if (!response.ok) throw new ResearchError('campus_login_failed', '树洞登录暂时不可用，请稍后重试。', 502)
        const tokens = await this.parseTokens(response)
        await this.persist(username, {...tokens, email}, generation)
        this.invalidAccess.delete(username)
        return {status: 'configured', loggedIn: true, email}
    }

    async logout(username: string): Promise<CampusState> {
        this.begin(username)
        this.tokens.delete(username)
        this.statuses.set(username, 'missing')
        this.invalidAccess.delete(username)
        this.db.clearCampusTokens(username)
        return {status: 'missing', loggedIn: false, email: null}
    }

    async get(username: string, path: string, params: Record<string, string | number> | undefined,
              timeoutMs: number, signal?: AbortSignal): Promise<Response> {
        const base = forumPath.test(path) ? FORUM_BASE : dankePath.test(path) ? DANKE_BASE : null
        if (!base) throw new ResearchError('campus_endpoint_forbidden', '不允许请求此旦挞接口。', 400)
        const generation = this.generation(username)
        let tokens = await this.load(username)
        this.assertCurrent(username, generation)
        if (!tokens) throw this.missingError(username)
        const url = new URL(base + path)
        for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
        let response = await this.requestWithRetry(url.href, {
            method: 'GET', headers: {Authorization: `Bearer ${tokens.access}`}, signal
        }, timeoutMs)
        this.assertCurrent(username, generation)
        if (response.status !== 401) return response
        await this.refresh(username, tokens.access, generation, signal)
        this.assertCurrent(username, generation)
        tokens = this.tokens.get(username) ?? tokens
        response = await this.requestWithRetry(url.href, {
            method: 'GET', headers: {Authorization: `Bearer ${tokens.access}`}, signal
        }, timeoutMs)
        this.assertCurrent(username, generation)
        if (response.status === 401) {
            this.invalidAccess.set(username, tokens.access)
            this.statuses.set(username, 'expired')
            throw new ResearchError('campus_auth_failed', '旦挞认证已失效，请重新登录。', 401)
        }
        return response
    }

    private generation(username: string) {
        return this.generations.get(username) ?? 0
    }

    private begin(username: string) {
        const generation = this.generation(username) + 1
        this.generations.set(username, generation)
        this.refreshing.delete(username)
        return generation
    }

    private assertCurrent(username: string, generation: number) {
        if (this.generation(username) !== generation) throw new ResearchError('campus_auth_changed', '树洞账号状态已变化，请重试。', 409)
    }

    private async load(username: string): Promise<Tokens | null> {
        const cached = this.tokens.get(username)
        if (cached) return cached
        const generation = this.generation(username)
        const encrypted = this.db.getCampusTokens(username)
        if (!encrypted) {
            this.statuses.set(username, 'missing')
            return null
        }
        try {
            if (!await this.secrets.available()) throw new Error('security storage unavailable')
            const tokens = readCampusTokens(JSON.parse(await this.secrets.decrypt(encrypted)))
            if (!tokens) throw new Error('invalid tokens')
            if (!tokens.email) tokens.email = tokenEmail(tokens.access)
            this.assertCurrent(username, generation)
            const loaded = this.tokens.get(username)
            if (loaded) return loaded
            this.tokens.set(username, tokens)
            this.statuses.set(username, this.invalidAccess.get(username) === tokens.access ? 'expired' : 'configured')
            return tokens
        } catch {
            if (this.generation(username) !== generation) return this.tokens.get(username) ?? null
            this.statuses.set(username, 'invalid')
            return null
        }
    }

    private missingError(username: string): ResearchError {
        const status = this.statuses.get(username)
        if (status === 'invalid') {
            return new ResearchError('campus_credentials_invalid', '树洞凭据无法读取，请重新登录。', 503)
        }
        return new ResearchError('campus_login_required', '尚未登录旦挞，请在旦挞设置中登录。', 503)
    }

    private async refresh(username: string, failedAccess: string, generation: number, signal?: AbortSignal): Promise<void> {
        const current = this.tokens.get(username)
        if (!current || current.access !== failedAccess) return
        const running = this.refreshing.get(username)
        if (running) {
            await running
            return
        }
        const task = this.refreshLocked(username, failedAccess, generation, signal).finally(() => {
            if (this.refreshing.get(username) === task) this.refreshing.delete(username)
        })
        this.refreshing.set(username, task)
        await task
    }

    private async refreshLocked(username: string, failedAccess: string, generation: number, signal?: AbortSignal): Promise<void> {
        const current = this.tokens.get(username)
        if (!current || current.access !== failedAccess) return
        const response = await this.fetchOnce(`${AUTH_BASE}/refresh`, {
            method: 'POST', headers: {Authorization: `Bearer ${current.refresh}`}, signal
        }, 15_000)
        this.assertCurrent(username, generation)
        if (response.status === 401 || response.status === 403) {
            this.invalidAccess.set(username, current.access)
            this.statuses.set(username, 'expired')
            throw new ResearchError('campus_auth_failed', '旦挞刷新凭据失效，请重新登录。', 401)
        }
        if (!response.ok) throw new ResearchError('campus_upstream_error', '旦挞服务返回异常状态。', 502)
        const tokens = await this.parseTokens(response)
        await this.persist(username, {...tokens, email: current.email}, generation)
    }

    private async parseTokens(response: Response): Promise<Tokens> {
        const tokens = readCampusTokens(await response.json().catch(() => null))
        if (!tokens) throw new ResearchError('campus_invalid_response', '旦挞响应格式发生变化，无法安全读取。', 502)
        return tokens
    }

    private async persist(username: string, tokens: Tokens, generation: number): Promise<void> {
        if (!await this.secrets.available()) throw new ResearchError('campus_credentials_write_failed', '系统安全存储不可用，无法保存树洞凭据。', 503)
        const encrypted = await this.secrets.encrypt(JSON.stringify(tokens))
        this.assertCurrent(username, generation)
        this.db.saveCampusTokens(username, encrypted)
        this.tokens.set(username, tokens)
        this.statuses.set(username, 'configured')
    }

    private async fetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        try {
            return await this.request(url, {
                ...init, redirect: 'error', cache: 'no-store',
                signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            })
        } catch (error) {
            init.signal?.throwIfAborted()
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new ResearchError('campus_timeout', '旦挞请求超时，请稍后重试。', 504)
            }
            throw new ResearchError('campus_unreachable', '暂时无法连接旦挞服务。', 502)
        }
    }

    private async requestWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            const response = await this.fetchOnce(url, init, timeoutMs)
            if (![429, 502, 503, 504].includes(response.status) || attempt >= 1) return response
            const retryAfter = response.headers.get('retry-after')
            if (retryAfter !== null && (!/^\d+$/.test(retryAfter) || Number(retryAfter) > 1)) return response
            await delay(1000, undefined, {signal: init.signal ?? undefined})
        }
    }
}
