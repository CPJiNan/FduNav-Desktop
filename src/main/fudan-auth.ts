import {constants, createPublicKey, publicEncrypt} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {load} from 'cheerio'
import {CookieJar} from 'tough-cookie'
import {parseNotices} from './notice-parser.ts'

const ID_BASE = 'https://id.fudan.edu.cn'
const LIST_URL = 'https://jwc.fudan.edu.cn/9397/list.htm'

export class AuthError extends Error {
}

export class AdditionalAuthenticationRequired extends AuthError {
    readonly loginUrl: string
    readonly target: string

    constructor(loginUrl: string, target: string) {
        super('请在学校认证窗口完成验证。')
        this.loginUrl = validateUrl(loginUrl)
        this.target = validateUrl(target)
    }
}

export function validateUrl(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new AuthError('认证服务返回了无效地址。')
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(url.hostname === 'fudan.edu.cn' || url.hostname.endsWith('.fudan.edu.cn'))) {
        throw new AuthError('已拒绝访问非 HTTPS 复旦地址。')
    }
    return url.href
}

export function isAuthUrl(value: string) {
    return ['id.fudan.edu.cn', 'uis.fudan.edu.cn'].includes(new URL(value).hostname)
}

export function authParameters(value: string) {
    const url = new URL(validateUrl(value))
    if (url.hostname !== 'id.fudan.edu.cn') throw new AuthError('当前仅支持学校的 Neo 认证，登录方式可能已更新。')
    const params = new URLSearchParams(url.hash.split('?').slice(1).join('?'))
    const lck = params.get('lck'), entityId = params.get('entityId')
    if (!lck || !entityId) throw new AuthError('无法解析登录参数，学校登录页面可能已更新。')
    return {lck, entityId}
}

export function encryptPassword(password: string, encodedKey: string) {
    try {
        const key = createPublicKey({key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki'})
        if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid key')
        return publicEncrypt({
            key,
            padding: constants.RSA_PKCS1_PADDING
        }, Buffer.from(password, 'utf8')).toString('base64')
    } catch {
        throw new AuthError('认证公钥无效或密码超过加密长度限制。')
    }
}

export function ticketUrl(html: string, base: string) {
    const $ = load(html)
    const form = $('form#logon').first()
    const action = form.attr('action')
    const ticket = form.find('input#ticket, input[name="ticket"]').first().attr('value')
    if (!action || !ticket) throw new AuthError('登录票据解析失败，学校页面可能已更新。')
    const url = new URL(validateUrl(new URL(action, base).href))
    url.searchParams.set('ticket', ticket)
    return url.href
}

function checkPage(html: string) {
    const title = load(html)('title').text().toLowerCase()
    if (title.includes('under maintenance') || title.includes('网络维护')) throw new AuthError('学校网站正在维护，请稍后重试。')
}

export interface Page {
    text: string;
    url: string
    link?: string
}

export interface Transport {
    request(url: string, payload?: Record<string, unknown>, form?: boolean): Promise<Page>

    post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
}

export class FudanTransport implements Transport {
    readonly jar: CookieJar
    private signal: AbortSignal

    constructor(jar = new CookieJar(), signal = AbortSignal.timeout(90_000)) {
        this.jar = jar
        this.signal = signal
    }

    async request(value: string, payload?: Record<string, unknown>, form = false): Promise<Page> {
        const start = validateUrl(value)
        for (let attempt = 0; attempt < (payload ? 1 : 3); attempt++) {
            try {
                let url = start
                let body = payload ? (form ? new URLSearchParams(payload as Record<string, string>).toString() : JSON.stringify(payload)) : undefined
                for (let redirects = 0; redirects < 12; redirects++) {
                    const headers: Record<string, string> = {'User-Agent': 'Mozilla/5.0 FduNav/0.1'}
                    const cookie = await this.jar.getCookieString(url)
                    if (cookie) headers.Cookie = cookie
                    if (body) Object.assign(headers, {
                        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
                        Origin: ID_BASE,
                        Referer: `${ID_BASE}/ac/`
                    })
                    const response = await fetch(url, {
                        method: body ? 'POST' : 'GET',
                        body,
                        headers,
                        redirect: 'manual',
                        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
                    })
                    for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url)
                    if ([301, 302, 303, 307, 308].includes(response.status)) {
                        const location = response.headers.get('location')
                        await response.body?.cancel()
                        if (!location) throw new AuthError('认证重定向缺少目标地址。')
                        const next = validateUrl(new URL(location, url).href)
                        if ([301, 302, 303].includes(response.status)) body = undefined
                        if (body && new URL(next).origin !== new URL(url).origin) throw new AuthError('已阻止跨站转发登录凭据。')
                        url = next
                        continue
                    }
                    if (!response.ok) {
                        await response.body?.cancel()
                        if (!payload && [429, 500, 502, 503, 504].includes(response.status) && attempt < 2) break
                        throw new AuthError(`学校服务器返回 HTTP ${response.status}，请稍后重试。`)
                    }
                    return {text: await response.text(), url, link: response.headers.get('link') ?? undefined}
                }
            } catch (error) {
                if (error instanceof AuthError) throw error
                if (payload || attempt === 2 || this.signal.aborted) throw new AuthError('连接学校服务失败或超时，请检查网络后重试。')
            }
            await delay(500 * (attempt + 1), undefined, {signal: this.signal}).catch(() => {
                throw new AuthError('登录超时，请重试。')
            })
        }
        throw new AuthError('重定向次数过多或学校服务暂时不可用。')
    }

    async post(path: string, payload: Record<string, unknown>) {
        const {text} = await this.request(ID_BASE + path, payload)
        try {
            const result: unknown = JSON.parse(text)
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
            return result as Record<string, unknown>
        } catch {
            throw new AuthError('学校认证响应格式发生变化，请稍后重试。')
        }
    }
}

export async function findLogin(transport: Transport) {
    const list = await transport.request(LIST_URL)
    checkPage(list.text)
    if (isAuthUrl(list.url)) return {loginUrl: list.url, target: LIST_URL}
    const targets = parseNotices(list.text, list.url, 'jwc').slice(0, 8).map(notice => notice.url)
    for (const target of targets) {
        const page = await transport.request(target)
        checkPage(page.text)
        if (isAuthUrl(page.url)) return {loginUrl: page.url, target}
    }
    throw new AuthError('未找到需要认证的教务通知，无法建立登录流程。请稍后重试。')
}

export async function authenticate(transport: Transport, username: string, password: string) {
    const {loginUrl, target} = await findLogin(transport)
    const additionalAuthentication = () => new AdditionalAuthenticationRequired(loginUrl, target)
    let params: ReturnType<typeof authParameters>
    try {
        params = authParameters(loginUrl)
    } catch (error) {
        if (error instanceof AuthError) throw additionalAuthentication()
        throw error
    }
    const methods = await transport.post('/idp/authn/queryAuthMethods', params)
    if (methods.second) throw additionalAuthentication()
    const entries = Array.isArray(methods.data) ? methods.data : []
    const chain = entries.find(item => item && item.moduleCode === 'userAndPwd')?.authChainCode
    if (typeof chain !== 'string' || !chain) throw additionalAuthentication()
    const key = (await transport.post('/idp/authn/getJsPublicKey', {})).data
    if (typeof key !== 'string') throw new AuthError('认证服务未返回有效公钥。')
    const result = await transport.post('/idp/authn/authExecute', {
        ...params, authModuleCode: 'userAndPwd', authChainCode: chain, requestType: 'chain_type',
        authPara: {loginName: username, password: encryptPassword(password, key), verifyCode: ''},
    })
    const message = typeof result.message === 'string' ? result.message : ''
    if (result.second || /验证码|二次验证|二次认证/.test(message)) throw additionalAuthentication()
    if (typeof result.loginToken !== 'string' || !result.loginToken) {
        if (/(?:密码|用户名|账号|帐号).*(?:错误|不正确|有误|不存在)|invalid credentials/i.test(message)) {
            throw new AuthError('学号或密码不正确，请检查后重试。')
        }
        throw additionalAuthentication()
    }
    const page = await transport.request(`${ID_BASE}/idp/authCenter/authnEngine`, {loginToken: result.loginToken}, true)
    let ticket: string
    try {
        ticket = ticketUrl(page.text, page.url)
    } catch (error) {
        if (error instanceof AuthError && isAuthUrl(page.url)) throw additionalAuthentication()
        throw error
    }
    await transport.request(ticket)
    if (!await verifySession(transport, target)) throw additionalAuthentication()
    return target
}

export async function verifySession(transport: Transport, target: string) {
    const page = await transport.request(validateUrl(target))
    checkPage(page.text)
    if (isAuthUrl(page.url)) return false
    if (new URL(page.url).hostname !== 'jwc.fudan.edu.cn') throw new AuthError('会话验证返回了非预期页面。')
    const $ = load(page.text)
    if (!$('.wp_articlecontent, #vsb_content, .v_news_content, article, a[href*="page.htm"]').length) {
        throw new AuthError('无法确认目标页面权限，学校页面可能已更新。')
    }
    return true
}
