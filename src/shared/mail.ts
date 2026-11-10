import type {Result} from './accounts'

export type MailSecurity = 'tls' | 'starttls'

export interface MailConnection {
    address: string;
    username: string;
    host: string;
    port: number;
    security: MailSecurity
}

export interface MailInput extends MailConnection {
    password: string;
    enabled: boolean
}

export interface MailSettings extends MailConnection {
    configured: boolean;
    enabled: boolean;
    lastVerifiedAt: string | null
}

export const fudanStudentMail = {
    domain: 'm.fudan.edu.cn',
    host: 'imap.exmail.qq.com',
    webmailUrl: 'https://mail.m.fudan.edu.cn/'
} as const
export const emptyMailSettings = (): MailSettings => ({
    configured: false,
    enabled: false,
    address: '',
    username: '',
    host: '',
    port: 993,
    security: 'tls',
    lastVerifiedAt: null,
})

export interface MailPreset {
    id: string
    label: string
    host: string
}

export const mailPresets: readonly MailPreset[] = [
    {id: 'fudan-cloud', label: '复旦学生邮箱', host: fudanStudentMail.host},
    {id: 'qq', label: 'QQ 邮箱', host: 'imap.qq.com'},
    {id: 'gmail', label: 'Gmail', host: 'imap.gmail.com'},
    {id: 'custom', label: '其他邮箱', host: ''},
]

export function validateMailInput(input: unknown): Result<MailInput> & { field?: keyof MailInput } {
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
    return {
        ok: true, data: {
            address: v.address.trim(),
            username: v.username.trim() || v.address.trim(),
            host: v.host.trim().toLowerCase(),
            port: v.port,
            security: v.security,
            password: v.password,
            enabled: v.enabled
        }
    }
}

export interface MailListInput {
    days?: number;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
    account?: string
}

export interface MailPeriod {
    from: string;
    to: string
}

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
    id: string;
    subject: string;
    from: string;
    receivedAt: string | null;
    sentAt: string | null;
    read: boolean
    summary: string;
    summaryStatus: 'available' | 'no_text' | 'unavailable'
    account?: string
}

export interface MailListResult extends MailPeriod {
    mailbox: 'INBOX';
    summaryKind: 'body_excerpt';
    items: MailSummary[];
    hasMore: boolean;
    nextCursor: string | null
    warnings?: { account: string; message: string }[]
}

export interface MailReadInput {
    id: string;
    offset?: number;
    limit?: number
}

export interface MailBody {
    id: string;
    subject: string;
    from: string;
    to: string;
    receivedAt: string | null;
    sentAt: string | null
    body: string;
    availableChars: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
    bodyTruncated: boolean;
    note: string
    account?: string
}

export type MailAPI = MailboxAPI

export interface MailSmtpInput extends MailConnection {
    password: string
    useImapCredentials: boolean
}

export interface MailAccountInput extends MailInput {
    id?: string
    label: string
    smtp: MailSmtpInput | null
}

export interface MailAccount extends MailSettings {
    id: string
    label: string
    smtp: Omit<MailSmtpInput, 'password'> | null
}

export const smtpPresets: Record<string, { host: string; port: number; security: MailSecurity }> = {
    'fudan-cloud': {host: 'smtp.exmail.qq.com', port: 465, security: 'tls'},
    qq: {host: 'smtp.qq.com', port: 465, security: 'tls'},
    gmail: {host: 'smtp.gmail.com', port: 465, security: 'tls'},
    '163': {host: 'smtp.163.com', port: 465, security: 'tls'},
}

export interface MailFolder {
    accountId: string;
    path: string;
    name: string;
    specialUse: string | null;
    delimiter?: string | null;
    selectable?: boolean;
    role?: MailFolderRole | null;
    messages: number | null;
    unread: number | null
}

export type MailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'starred'
export type MailScope = MailFolderRole

export interface MailQuery {
    accountIds?: string[];
    scope?: MailScope;
    folder?: string;
    query?: string;
    unreadOnly?: boolean;
    limit?: number;
    cursor?: string
}

export interface MailItem {
    id: string;
    accountId: string;
    accountAddress: string;
    folder: string
    subject: string;
    from: string;
    fromAddress: string;
    to: string;
    receivedAt: string | null
    read: boolean;
    starred: boolean;
    hasAttachments: boolean
}

export interface MailPage {
    items: MailItem[];
    hasMore: boolean;
    nextCursor: string | null
    errors: { accountId: string; address: string; message: string }[]
}

export interface MailAttachment {
    part: string;
    name: string;
    type: string;
    size: number
}

export interface MailMessage extends MailItem {
    body: string;
    html: string;
    truncated: boolean;
    attachments: MailAttachment[]
    replyTo: string[];
    recipients: string[];
    cc: string[];
    messageId: string;
    references: string[]
    remoteImagesBlocked: boolean
}

export interface MailUpload {
    name: string;
    type: string;
    data: string
}

export interface MailDraft {
    id: string;
    accountId: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string
    attachments: MailUpload[];
    inReplyTo?: string;
    references?: string[];
    updatedAt: string
    sendRequestId?: string;
    sendState?: 'unknown'
}

export interface MailDraftSummary {
    id: string;
    accountId: string;
    to: string;
    subject: string;
    preview: string;
    updatedAt: string;
    sendState?: 'unknown'
}

export interface MailSendResult {
    status: 'sent' | 'unknown';
    message: string;
    messageId: string | null
}

export interface MailboxAPI {
    accounts(): Promise<Result<MailAccount[]>>

    saveAccount(input: MailAccountInput): Promise<Result<MailAccount>>

    testAccount(input: MailAccountInput): Promise<Result<{ smtp: boolean }>>

    cancelSetup(): Promise<Result<null>>

    setAgentAccess(input: { id: string; enabled: boolean }): Promise<Result<MailAccount>>

    removeAccount(id: string): Promise<Result<null>>

    folders(accountIds?: string[]): Promise<Result<{ folders: MailFolder[]; errors: MailPage['errors'] }>>

    messages(input: MailQuery): Promise<Result<MailPage>>

    message(input: { id: string; markRead?: boolean }): Promise<Result<MailMessage>>

    setFlags(input: { id: string; read?: boolean; starred?: boolean }): Promise<Result<null>>

    moveToTrash(id: string): Promise<Result<null>>

    downloadAttachment(input: { id: string; part: string }): Promise<Result<{ saved: boolean }>>

    readAttachment(input: { id: string; part: string; forForward?: boolean }): Promise<Result<{
        data: string;
        name: string;
        type: string
    }>>

    drafts(): Promise<Result<MailDraftSummary[]>>

    draft(id: string): Promise<Result<MailDraft>>

    saveDraft(input: MailDraft): Promise<Result<MailDraftSummary>>

    releaseDraft(id: string): Promise<Result<MailDraft>>

    deleteDraft(id: string): Promise<Result<null>>

    send(input: { draft: MailDraft; requestId: string }): Promise<Result<MailSendResult>>

    openLink(url: string): Promise<Result<null>>
}

export function validateMailAccount(input: unknown): Result<MailAccountInput> & { field?: string } {
    const checked = validateMailInput(input)
    if (!checked.ok) return checked
    const value = input as Record<string, unknown>
    if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{16}$/.test(value.id))) return {
        ok: false,
        error: '邮箱账号引用无效。'
    }
    if (typeof value.label !== 'string' || value.label.length > 80 || /[\x00-\x1f\x7f]/.test(value.label)) return {
        ok: false,
        error: '邮箱名称最多 80 个字符。',
        field: 'label'
    }
    let smtp: MailSmtpInput | null = null
    if (value.smtp !== null) {
        if (!value.smtp || typeof value.smtp !== 'object' || Array.isArray(value.smtp)) return {
            ok: false,
            error: '请填写发信服务器设置。',
            field: 'smtpHost'
        }
        const raw = value.smtp as Record<string, unknown>
        const valid = validateMailInput({...raw, address: checked.data.address, enabled: true})
        if (!valid.ok) return {
            ok: false,
            error: '发信设置：' + valid.error,
            field: valid.field === 'host' ? 'smtpHost' : valid.field === 'password' ? 'smtpPassword' : 'smtpPort'
        }
        if (typeof raw.useImapCredentials !== 'boolean') return {ok: false, error: '发信账号设置无效。'}
        const {enabled: _enabled, ...connection} = valid.data
        smtp = {...connection, useImapCredentials: raw.useImapCredentials}
    }
    return {
        ok: true,
        data: {
            ...checked.data,
            id: value.id as string | undefined,
            label: value.label.trim() || checked.data.address,
            smtp
        }
    }
}

export const mailUploadBytes = (data: string) => data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

export function validateMailDraft(input: unknown): Result<MailDraft> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, error: '邮件草稿格式无效。'}
    const v = input as Record<string, unknown>
    if (typeof v.id !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(v.id) || typeof v.accountId !== 'string' || !/^[a-zA-Z0-9_-]{16}$/.test(v.accountId)) return {
        ok: false,
        error: '草稿或发件账号无效。'
    }
    for (const field of ['to', 'cc', 'bcc', 'subject', 'body'] as const) {
        if (typeof v[field] !== 'string' || (v[field] as string).length > (field === 'body' ? 1000000 : field === 'subject' ? 998 : 10000) ||
            (field !== 'body' && /[\r\n\x00]/.test(v[field] as string))) return {
            ok: false,
            error: '收件人、主题或正文格式无效。'
        }
    }
    if (!Array.isArray(v.attachments) || v.attachments.length > 20) return {
        ok: false,
        error: '每封邮件最多添加 20 个附件。'
    }
    let bytes = 0
    for (const a of v.attachments) {
        if (!a || typeof a !== 'object' || typeof a.name !== 'string' || a.name.length > 255 || /[\x00-\x1f\/\\]/.test(a.name) ||
            typeof a.type !== 'string' || a.type.length > 120 || /[\r\n]/.test(a.type) || typeof a.data !== 'string' || a.data.length > 27962028 || a.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(a.data.slice(0, a.data.length - (a.data.endsWith('==') ? 2 : a.data.endsWith('=') ? 1 : 0)))) return {
            ok: false,
            error: '附件格式无效，请重新添加。'
        }
        bytes += mailUploadBytes(a.data)
        if (bytes > 20 * 1024 * 1024) return {ok: false, error: '附件总大小不能超过 20 MB。'}
    }
    const messageId = (id: unknown) => typeof id === 'string' && id.length < 1000 && /^<[^\s<>]+@[^\s<>]+>$/.test(id)
    if (v.inReplyTo !== undefined && !messageId(v.inReplyTo)) return {ok: false, error: '回复邮件的引用无效。'}
    if (v.references !== undefined && (!Array.isArray(v.references) || v.references.length > 100 || !v.references.every(messageId))) return {
        ok: false,
        error: '邮件会话引用无效。'
    }
    if ((v.sendState === undefined) !== (v.sendRequestId === undefined) || (v.sendState !== undefined && v.sendState !== 'unknown')) return {
        ok: false,
        error: '草稿发送状态无效。'
    }
    if (v.sendRequestId !== undefined && (typeof v.sendRequestId !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(v.sendRequestId))) return {
        ok: false,
        error: '草稿发送引用无效。'
    }
    return {
        ok: true, data: {
            id: v.id, accountId: v.accountId, to: v.to as string, cc: v.cc as string, bcc: v.bcc as string,
            subject: v.subject as string, body: v.body as string, attachments: v.attachments as MailUpload[],
            ...(v.inReplyTo ? {inReplyTo: v.inReplyTo as string} : {}), ...(v.references ? {references: v.references as string[]} : {}),
            ...(v.sendState ? {
                sendState: 'unknown' as const,
                sendRequestId: v.sendRequestId as string | undefined
            } : {}), updatedAt: new Date().toISOString()
        }
    }
}
