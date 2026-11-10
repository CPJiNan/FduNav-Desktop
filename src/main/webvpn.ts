import {createCipheriv} from 'node:crypto'

/**
 * 学校 WebVPN 的公开主机编码：官方客户端公开的路由协议常量 wrdvpnisthebest! 作为
 * AES-128-CFB 的 key / IV。它只是路由编码，不是用户凭据，也不承担认证。
 */
export const webvpnLoginUrl = 'https://webvpn.fudan.edu.cn/login?cas_login=true'

/** 只允许这三个社区服务；任何其他主机都不在该通路能力范围内。 */
export const dantaHosts = new Set(['auth.fduhole.com', 'forum.fduhole.com', 'danke.fduhole.com'])

const routeKey = Buffer.from('wrdvpnisthebest!')

export function webvpnRoute(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error('无法识别的社区服务地址。')
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !dantaHosts.has(url.hostname)) {
        throw new Error('不在允许访问的社区服务范围内。')
    }
    const cipher = createCipheriv('aes-128-cfb', routeKey, routeKey)
    const host = Buffer.concat([cipher.update(Buffer.from(url.hostname)), cipher.final()]).toString('hex')
    return `https://webvpn.fudan.edu.cn/https/${routeKey.toString('hex')}${host}${url.pathname}${url.search}`
}

export function isWebvpnHost(value: string): boolean {
    try {
        return new URL(value).hostname === 'webvpn.fudan.edu.cn'
    } catch {
        return false
    }
}
