import type {Result} from './accounts'

export type MailSecurity = 'tls' | 'starttls'
export interface MailConnection {
    address: string; username: string; host: string; port: number; security: MailSecurity
}
export interface MailInput extends MailConnection {password: string; enabled: boolean}
export interface MailSettings extends MailConnection {configured: boolean; enabled: boolean; lastVerifiedAt: string | null}
export const fudanStudentMail = {domain: 'm.fudan.edu.cn', host: 'imap.exmail.qq.com', webmailUrl: 'https://mail.m.fudan.edu.cn/'} as const
export const emptyMailSettings = (): MailSettings => ({
    configured: false, enabled: false, address: '', username: '', host: '', port: 993, security: 'tls', lastVerifiedAt: null,
})
export const mailPresets = [
    {id: 'fudan-cloud', label: '复旦学生邮箱', host: fudanStudentMail.host, hint: '开启“安全登录”后，需使用客户端专用密码，普通邮箱密码不可用。'},
    {id: 'fudan', label: '复旦邮箱（旧系统）', host: 'mail.fudan.edu.cn', hint: '使用邮箱密码；请在网页版邮箱的设置中确认已开启 IMAP 服务。'},
    {id: 'qq', label: 'QQ 邮箱', host: 'imap.qq.com', hint: '请先开启 IMAP 服务，并使用授权码。'},
    {id: 'custom', label: '其他邮箱', host: '', hint: '填写服务商提供的 IMAP 设置；部分邮箱需要应用专用密码。'},
] as const

export function validateMailInput(input: unknown): Result<MailInput> & {field?: keyof MailInput} {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, error: '邮箱设置格式无效。'}
    const v = input as Record<string, unknown>
    const invalid = (field: keyof MailInput, error: string) => ({ok: false as const, error, field})
    if (typeof v.address !== 'string' || v.address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.address.trim())) return invalid('address', '请输入完整的邮箱地址。')
    if (typeof v.username !== 'string' || v.username.length > 254 || /[\x00-\x1f\x7f]/.test(v.username)) return invalid('username', '登录账号格式无效。')
    if (typeof v.host !== 'string' || v.host.length > 253 || !v.host.trim() ||
        !v.host.trim().split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return invalid('host', '请输入服务器域名，不要填写网址或端口。')
    if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return invalid('port', '端口须为 1–65535 之间的整数。')
    if (v.security !== 'tls' && v.security !== 'starttls') return invalid('security', '请选择 TLS 或 STARTTLS 加密连接。')
    if (typeof v.password !== 'string' || v.password.length > 4096 || /[\r\n\x00]/.test(v.password)) return invalid('password', '密码或授权码格式无效。')
    if (typeof v.enabled !== 'boolean') return invalid('enabled', '邮箱读取开关无效。')
    return {ok: true, data: {address: v.address.trim(), username: v.username.trim() || v.address.trim(),
        host: v.host.trim().toLowerCase(), port: v.port, security: v.security, password: v.password, enabled: v.enabled}}
}

export interface MailListInput {days?: number; from?: string; to?: string; limit?: number; cursor?: string}
export interface MailPeriod {from: string; to: string}
const validDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
export function mailPeriod(input: MailListInput, now = new Date()): MailPeriod {
    if (input.from !== undefined || input.to !== undefined) {
        if (input.days !== undefined || !validDay(input.from) || !validDay(input.to) || input.from > input.to ||
            Date.parse(input.to) - Date.parse(input.from) > 364 * 86400000) throw new Error('请同时提供有效的 from/to 日期，跨度不超过 365 天；不要同时填写 days。')
        return {from: input.from, to: input.to}
    }
    const days = input.days ?? 30
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days 须为 1–365 之间的整数。')
    const to = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'})
    return {from: new Date(Date.parse(to) - (days - 1) * 86400000).toISOString().slice(0, 10), to}
}
export interface MailSummary {
    id: string; subject: string; from: string; receivedAt: string | null; sentAt: string | null; read: boolean
    summary: string; summaryStatus: 'available' | 'no_text' | 'unavailable'
}
export interface MailListResult extends MailPeriod {
    mailbox: 'INBOX'; summaryKind: 'body_excerpt'; items: MailSummary[]; hasMore: boolean; nextCursor: string | null
}
export interface MailReadInput {id: string; offset?: number; limit?: number}
export interface MailBody {
    id: string; subject: string; from: string; to: string; receivedAt: string | null; sentAt: string | null
    body: string; availableChars: number; offset: number; hasMore: boolean; nextOffset: number | null; bodyTruncated: boolean; note: string
}
export interface MailAPI {
    get(): Promise<Result<MailSettings>>
    test(input: MailInput): Promise<Result<{message: string}>>
    save(input: MailInput): Promise<Result<MailSettings>>
    cancelSetup(): Promise<Result<null>>
    setEnabled(enabled: boolean): Promise<Result<MailSettings>>
    disconnect(): Promise<Result<MailSettings>>
    openWebmail(mode: 'browser' | 'app'): Promise<Result<null>>
}
