import {lookup} from 'node:dns/promises'
import {request} from 'node:https'
import {isIP} from 'node:net'
import {sourceUrl} from '../shared/sources.ts'

export interface SourcePage {
    text: string;
    url: string
}

export function isPublicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number)
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113))
    }
    return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address)
}

export async function requestSourcePage(value: string, timeoutMs: number): Promise<SourcePage> {
    const {bytes, type, url} = await requestSource(value, 'page', undefined, timeoutMs)
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ??
        /charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString('ascii'))?.[1] ?? 'utf-8'
    try {
        return {text: new TextDecoder(charset).decode(bytes), url}
    } catch {
        throw new Error('无法识别来源网页编码。')
    }
}

export async function requestSourcePdf(value: string): Promise<Uint8Array> {
    const {bytes} = await requestSource(value, 'pdf', undefined, 25_000)
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('附件不是有效的 PDF。')
    return new Uint8Array(bytes)
}

export async function requestSourceImage(value: string, referer: string): Promise<Uint8Array> {
    const {bytes} = await requestSource(value, 'image', referer, 25_000)
    return bytes
}

async function requestSource(value: string, kind: 'page' | 'pdf' | 'image', referer: string | undefined, timeoutMs: number) {
    let url = sourceUrl(value)
    const signal = AbortSignal.timeout(timeoutMs)
    for (let redirects = 0; redirects < 6; redirects++) {
        const parsed = new URL(url)
        const addresses = await lookup(parsed.hostname, {all: true})
        if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) {
            throw new Error('来源网址未指向公开网站。')
        }
        const address = addresses.find(record => record.family === 4) ?? addresses[0]
        const response = await new Promise<{ location?: string; bytes: Buffer; type: string }>((resolve, reject) => {
            const req = request(parsed, {
                method: 'GET', agent: false, signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 FduNav/0.1',
                    'Accept-Encoding': 'identity', ...(referer ? {Referer: referer} : {})
                },

                lookup: (_hostname, options, callback) => {
                    if (options.all) callback(null, [address])
                    else callback(null, address.address, address.family)
                },
            }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
                    const location = res.headers.location
                    res.resume()
                    if (!location) reject(new Error('来源重定向缺少目标网址。'))
                    else resolve({location, bytes: Buffer.alloc(0), type: ''})
                    return
                }
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume()
                    reject(new Error(`来源网站返回 HTTP ${res.statusCode ?? 0}。`))
                    return
                }
                const type = res.headers['content-type'] ?? ''
                const allowedType = kind === 'pdf' ? /application\/(pdf|octet-stream)/i
                    : kind === 'image' ? /image\/|application\/octet-stream/i : /text\/|application\/(xhtml\+xml|xml)/i
                if (type && !allowedType.test(type)) {
                    res.resume()
                    reject(new Error('来源网址未返回网页。'))
                    return
                }
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > (kind === 'pdf' ? 20 : kind === 'image' ? 12 : 4) * 1024 * 1024) {
                        res.destroy(new Error('来源文件过大。'))
                    } else chunks.push(chunk)
                })
                res.on('error', reject)
                res.on('end', () => {
                    resolve({bytes: Buffer.concat(chunks), type})
                })
            })
            req.on('error', () => reject(new Error('连接来源网站失败或超时。')))
            req.end()
        })
        if (response.location) {
            url = sourceUrl(new URL(response.location, url).href)
            continue
        }
        return {bytes: response.bytes, type: response.type, url}
    }
    throw new Error('来源网站重定向次数过多。')
}
