import {randomBytes} from 'node:crypto'
import {emptyMailSettings, mailPeriod, validateMailInput, type MailInput, type MailSettings, type MailPeriod,
    type MailListInput, type MailListResult, type MailSummary, type MailReadInput, type MailBody} from '../shared/mail.ts'
import type {AppDatabase} from './database'
import type {SecretStorage} from './llm-settings'
import type {MailSession, MailTransport} from './mail-imap.ts'

type StoredMail = MailInput & {id: string; lastVerifiedAt: string}
type Repository = Pick<AppDatabase, 'getMailConfiguration' | 'saveMailConfiguration' | 'clearMailConfiguration'>
type Cursor = MailPeriod & {account: string; validity: string; before: number}
export class MailError extends Error {
    constructor(public code: 'invalid_args' | 'forbidden' | 'transient' | 'not_found', message: string) {super(message)}
}
const invalid = (message: string): never => {throw new MailError('invalid_args', message)}
const isUid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 4294967295
const header = (v: unknown, limit = 200) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit)
const iso = (v: unknown) => {
    const date = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function decodeCursor(value: string): Cursor {
    try {
        if (!value || value.length > 1024 || !/^[a-z0-9_-]+$/i.test(value)) throw new Error()
        const v = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
        if (!v || typeof v.account !== 'string' || !/^[a-z0-9_-]{16}$/i.test(v.account) ||
            typeof v.validity !== 'string' || !/^\d{1,10}$/.test(v.validity) || !isUid(v.before)) throw new Error()
        mailPeriod({from: v.from, to: v.to}); return v
    } catch {return invalid('分页游标无效，请重新列出邮件。')}
}

export class MailService {
    private revisions = new Map<string, number>()
    private sessions = new Map<string, Set<AbortController>>()
    private setup = new Map<string, Set<AbortController>>()
    private saving = new Set<string>()
    constructor(private db: Repository, private secrets: SecretStorage, private transport: MailTransport,
                private currentOwner: () => string | null) {}

    private owner(expected?: string) {
        const owner = this.currentOwner()
        if (!owner || (expected !== undefined && owner !== expected)) throw new MailError('forbidden', '请先登录当前校园账号，再使用邮箱。')
        return owner
    }
    private revision(owner: string) {return this.revisions.get(owner) ?? 0}
    private assertCurrent(owner: string, revision: number) {
        if (this.currentOwner() !== owner || this.revision(owner) !== revision) throw new MailError('forbidden', '账号或邮箱设置已变化，请重新发起请求。')
    }
    private invalidate(owner: string) {
        this.revisions.set(owner, this.revision(owner) + 1)
        for (const operation of this.sessions.get(owner) ?? []) operation.abort()
    }
    private async storageAvailable() {
        try {if (await this.secrets.available()) return} catch {}
        throw new MailError('forbidden', '系统安全存储不可用，无法安全读取或保存邮箱凭据。')
    }
    private async load(owner: string): Promise<StoredMail | null> {
        const encrypted = this.db.getMailConfiguration(owner)
        if (!encrypted) return null
        await this.storageAvailable()
        try {
            const v = JSON.parse(await this.secrets.decrypt(encrypted)) as StoredMail, checked = validateMailInput(v)
            if (!checked.ok || !checked.data.password || !/^[a-z0-9_-]{16}$/i.test(v.id) || !iso(v.lastVerifiedAt)) throw new Error()
            return {...checked.data, id: v.id, lastVerifiedAt: v.lastVerifiedAt}
        } catch {throw new MailError('forbidden', '无法解密本机保存的邮箱连接，请重新配置。')}
    }
    private present(v: StoredMail | null): MailSettings {
        if (!v) return emptyMailSettings()
        const {address, username, host, port, security, enabled, lastVerifiedAt} = v
        return {configured: true, address, username, host, port, security, enabled, lastVerifiedAt}
    }
    async get(): Promise<MailSettings> {
        const owner = this.owner(), revision = this.revision(owner), v = await this.load(owner)
        this.assertCurrent(owner, revision)
        try {return this.present(v)} finally {if (v) v.password = ''}
    }
    private async draft(raw: unknown, owner: string): Promise<StoredMail> {
        const checked = validateMailInput(raw)
        if (!checked.ok) return invalid(checked.error)
        const value = checked.data
        let saved: StoredMail | null
        try {saved = await this.load(owner)} catch (error) {if (!value.password) throw error; saved = null}
        const same = saved && saved.address === value.address && saved.username === value.username &&
            saved.host === value.host && saved.port === value.port && saved.security === value.security
        if (!value.password) {
            if (!same || !saved) return invalid('首次连接或更换邮箱、服务器时，请重新输入密码或授权码。')
            value.password = saved.password
        }
        const id = same && saved ? saved.id : randomBytes(12).toString('base64url')
        if (saved) saved.password = ''
        return {...value, id, lastVerifiedAt: new Date().toISOString()}
    }
    private beginSetup(owner: string) {
        const operation = new AbortController(), pending = this.setup.get(owner) ?? new Set<AbortController>()
        pending.add(operation); this.setup.set(owner, pending); return operation
    }
    private finishSetup(owner: string, operation: AbortController) {
        const pending = this.setup.get(owner); pending?.delete(operation)
        if (!pending?.size) this.setup.delete(owner)
    }
    async cancelSetup(): Promise<null> {
        for (const operation of this.setup.get(this.owner()) ?? []) operation.abort()
        return null
    }
    async test(raw: unknown) {
        const owner = this.owner(), revision = this.revision(owner), operation = this.beginSetup(owner)
        let value: StoredMail | undefined
        try {
            value = await this.draft(raw, owner)
            await this.withSession(owner, revision, value, async () => undefined, operation.signal)
            return {message: '连接成功，可以读取收件箱。测试不会保存设置或读取邮件正文。'}
        } finally {if (value) value.password = ''; this.finishSetup(owner, operation)}
    }
    async save(raw: unknown): Promise<MailSettings> {
        const owner = this.owner(), revision = this.revision(owner)
        if (this.saving.has(owner)) throw new MailError('transient', '正在保存邮箱连接，请稍候。')
        this.saving.add(owner)
        const operation = this.beginSetup(owner)
        let value: StoredMail | undefined
        try {
            await this.storageAvailable(); value = await this.draft(raw, owner)
            await this.withSession(owner, revision, value, async () => undefined, operation.signal)
            value.lastVerifiedAt = new Date().toISOString()
            let encrypted: Uint8Array
            try {encrypted = await this.secrets.encrypt(JSON.stringify(value))}
            catch {throw new MailError('forbidden', '邮箱凭据加密失败，设置未保存。')}
            this.assertCurrent(owner, revision)
            if (operation.signal.aborted) throw new MailError('forbidden', '邮箱连接操作已停止，设置未保存。')
            this.db.saveMailConfiguration(owner, encrypted); this.invalidate(owner); return this.present(value)
        } finally {if (value) value.password = ''; this.saving.delete(owner); this.finishSetup(owner, operation)}
    }
    async setEnabled(enabled: unknown): Promise<MailSettings> {
        if (typeof enabled !== 'boolean') return invalid('邮箱读取开关无效。')
        const owner = this.owner(), revision = this.revision(owner)
        if (this.saving.has(owner)) throw new MailError('transient', '正在保存邮箱连接，请稍候。')
        const value = await this.load(owner)
        if (!value) throw new MailError('forbidden', '请先在设置的“邮箱”中连接邮箱。')
        try {
            value.enabled = enabled
            const encrypted = await this.secrets.encrypt(JSON.stringify(value))
            this.assertCurrent(owner, revision)
            this.db.saveMailConfiguration(owner, encrypted); this.invalidate(owner); return this.present(value)
        } catch (error) {
            if (error instanceof MailError) throw error
            throw new MailError('forbidden', '无法安全更新邮箱设置，请重试。')
        } finally {value.password = ''}
    }
    async disconnect(): Promise<MailSettings> {
        const owner = this.owner()
        this.invalidate(owner); this.db.clearMailConfiguration(owner); return emptyMailSettings()
    }
    private async withSession<T>(owner: string, revision: number, input: MailInput,
                                 work: (session: MailSession, signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
        this.assertCurrent(owner, revision)
        const pending = this.sessions.get(owner) ?? new Set<AbortController>()
        if (pending.size >= 2) throw new MailError('transient', '邮箱操作正在进行，请稍候重试。')
        const operation = new AbortController()
        pending.add(operation); this.sessions.set(owner, pending)
        const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(45000), ...(external ? [external] : [])])
        const watch = setInterval(() => {
            if (this.currentOwner() !== owner || this.revision(owner) !== revision) operation.abort()
        }, 200)
        let session: MailSession | undefined
        try {
            signal.throwIfAborted(); session = await this.transport(input, signal)
            const result = await work(session, signal)
            signal.throwIfAborted(); this.assertCurrent(owner, revision); return result
        } catch (error) {
            this.assertCurrent(owner, revision)
            if (external?.aborted) throw new MailError('forbidden', '邮箱读取或连接操作已停止。')
            if (signal.aborted) throw new MailError('transient', '邮箱操作已取消或超时，请重试。')
            if (error instanceof MailError) throw error
            const v = error as {code?: string; authenticationFailed?: boolean}
            if (v?.authenticationFailed || /AUTH|EAUTH|LOGIN/i.test(v?.code ?? '')) throw new MailError('forbidden', '邮箱登录失败。请确认已开启 IMAP，并使用邮箱密码或客户端专用密码；网页登录状态不能替代 IMAP 授权。')
            if (/CERT|TLS|SSL|SELF_SIGNED/i.test(v?.code ?? '')) throw new MailError('forbidden', '邮箱服务器的安全连接验证失败，请检查服务器地址和系统时间。')
            throw new MailError('transient', '暂时无法读取邮箱，请检查网络、IMAP 服务器和端口后重试。')
        } finally {
            clearInterval(watch); try {session?.close()} catch {}
            pending.delete(operation); if (!pending.size) this.sessions.delete(owner)
        }
    }
    private async configured<T>(expectedOwner: string, work: (session: MailSession, value: StoredMail, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
        const owner = this.owner(expectedOwner), revision = this.revision(owner), value = await this.load(owner)
        if (!value?.enabled) {
            if (value) value.password = ''
            throw new MailError('forbidden', '邮箱未连接或助手读取已关闭，请在设置的“邮箱”中配置。')
        }
        try {return await this.withSession(owner, revision, value, (session, active) => work(session, value, active), signal)}
        finally {value.password = ''}
    }
    async list(owner: string, input: MailListInput = {}, signal?: AbortSignal): Promise<MailListResult> {
        const limit = input.limit ?? 5
        if (!Number.isInteger(limit) || limit < 1 || limit > 10 || (input.cursor !== undefined && typeof input.cursor !== 'string')) return invalid('邮件分页参数无效，limit 须为 1–10。')
        const cursor = input.cursor ? decodeCursor(input.cursor) : null
        let period: MailPeriod
        try {
            if (cursor && (input.days !== undefined || input.from !== undefined || input.to !== undefined)) return invalid('继续分页时只填写 cursor 和可选 limit，不要更改日期范围。')
            period = cursor ? {from: cursor.from, to: cursor.to} : mailPeriod(input)
        } catch (error) {return invalid(error instanceof Error ? error.message : '邮件日期范围无效。')}
        return this.configured(owner, async (session, account, active) => {
            if (cursor && (cursor.account !== account.id || cursor.validity !== session.uidValidity)) return invalid('邮箱或收件箱已变化，请重新列出邮件。')
            const uids = (await session.search(period)).filter(uid => isUid(uid) && (!cursor || uid < cursor.before)).sort((a, b) => b - a)
            const items: MailSummary[] = []
            let consumed = 0
            for (const uid of uids.slice(0, limit)) {
                active.throwIfAborted()
                const message = await session.message(uid)
                if (!message) {consumed++; continue}
                let summary = '', summaryStatus: MailSummary['summaryStatus'] = 'unavailable'
                try {
                    summary = (await session.text(message, 32768)).text.replace(/\s+/g, ' ').trim().slice(0, 240)
                    summaryStatus = summary ? 'available' : 'no_text'
                } catch {active.throwIfAborted()}
                const item: MailSummary = {
                    id: 'mail.' + account.id + '.' + session.uidValidity + '.' + uid,
                    subject: header(message.envelope?.subject) || '（无主题）',
                    from: header(message.envelope?.from?.map(v => v.name ? v.name + ' <' + v.address + '>' : v.address).join(', ')),
                    receivedAt: iso(message.internalDate), sentAt: iso(message.envelope?.date), read: message.flags?.has('\\Seen') ?? false, summary, summaryStatus,
                }
                if (JSON.stringify([...items, item]).length > 10000) break
                items.push(item); consumed++
            }
            const hasMore = consumed < uids.length
            const nextCursor = hasMore && consumed ? Buffer.from(JSON.stringify({
                ...period, account: account.id, validity: session.uidValidity, before: uids[consumed - 1],
            } satisfies Cursor)).toString('base64url') : null
            return {mailbox: 'INBOX', summaryKind: 'body_excerpt', ...period, items, hasMore, nextCursor}
        }, signal)
    }
    async read(owner: string, input: MailReadInput, signal?: AbortSignal): Promise<MailBody> {
        const match = typeof input.id === 'string' && /^mail\.([a-z0-9_-]{16})\.(\d{1,10})\.(\d{1,10})$/i.exec(input.id)
        const offset = input.offset ?? 0, limit = input.limit ?? 6000
        if (!match || !isUid(Number(match[3])) || !Number.isInteger(offset) || offset < 0 || offset > 100000 ||
            !Number.isInteger(limit) || limit < 1 || limit > 6000) return invalid('邮件 ID 或正文分页参数无效，请使用列出邮件返回的 ID；limit 不超过 6000。')
        return this.configured(owner, async (session, account) => {
            if (match[1] !== account.id || match[2] !== session.uidValidity) return invalid('这条邮件引用已失效，请重新列出邮件。')
            const message = await session.message(Number(match[3]))
            if (!message) throw new MailError('not_found', '邮件已被移走或删除，请重新列出邮件。')
            const content = await session.text(message, 262144), text = content.text.slice(0, 100000)
            if (offset > text.length) return invalid('正文偏移超出范围，请从 offset=0 重新读取。')
            const bodyTruncated = content.truncated || content.text.length > text.length
            const result: MailBody = {
                id: input.id, subject: header(message.envelope?.subject) || '（无主题）',
                from: header(message.envelope?.from?.map(v => v.name ? v.name + ' <' + v.address + '>' : v.address).join(', ')),
                to: header(message.envelope?.to?.map(v => v.address).join(', '), 500),
                receivedAt: iso(message.internalDate), sentAt: iso(message.envelope?.date),
                body: text.slice(offset, offset + limit), availableChars: text.length, offset, hasMore: false, nextOffset: null, bodyTruncated,
                note: !text ? '没有可读取的文本正文，邮件可能仅包含图片或附件。未下载附件。' : bodyTruncated ? '邮件过长，仅提供部分正文；未下载附件。' : '未下载附件。',
            }
            while (JSON.stringify(result).length > 11000 && result.body.length > 1) result.body = result.body.slice(0, Math.floor(result.body.length * 0.8))
            result.hasMore = offset + result.body.length < text.length; result.nextOffset = result.hasMore ? offset + result.body.length : null
            return result
        }, signal)
    }
}
