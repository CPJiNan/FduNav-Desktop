import {
    type MailBody,
    type MailListInput,
    type MailListResult,
    mailPeriod,
    type MailPeriod,
    type MailReadInput,
    type MailSummary
} from '../shared/mail'
import {MailAccounts, mapMailLimit} from './mail-accounts'
import type {MailClient} from './mail-client'
import {createMailTransport, type MailTransport} from './mail-imap'
import {mailHeader, parseMailReference} from './mail-message'
import {MailError, safeMailError} from './mail-errors'

export {MailError} from './mail-errors'

export class MailService {
    constructor(private accounts: MailAccounts, private client: MailClient, private transport: MailTransport = createMailTransport()) {
    }

    async list(owner: string, input: MailListInput = {}, signal?: AbortSignal): Promise<MailListResult> {
        this.accounts.owner(owner)
        const revision = this.accounts.revision(owner)
        const limit = input.limit ?? 5
        if (!Number.isInteger(limit) || limit < 1 || limit > 10 || (input.account !== undefined && (typeof input.account !== 'string' || input.account.length > 254))) throw new MailError('invalid_args', 'limit 须为 1–10，account 请填写完整邮箱地址或账号 ID。')
        const accounts = (await this.accounts.list()).filter(account => account.enabled)
        let period: MailPeriod, pageCursor: string | undefined
        let account = input.account
        try {
            if (input.cursor) {
                if (input.days !== undefined || input.from !== undefined || input.to !== undefined || input.account !== undefined || input.cursor.length > 65536) throw new Error()
                const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
                period = mailPeriod({from: cursor.from, to: cursor.to});
                pageCursor = cursor.page;
                account = cursor.account
                if (typeof pageCursor !== 'string' || (account !== undefined && typeof account !== 'string')) throw new Error()
            } else period = mailPeriod(input)
        } catch {
            throw new MailError('invalid_args', '日期或分页参数无效。继续分页时只填写 cursor 和可选 limit。')
        }
        const selected = account ? accounts.filter(value => value.id === account || value.address.toLowerCase() === account!.toLowerCase()) : accounts
        if (!selected.length) throw new MailError('forbidden', account ? '这个邮箱不存在或未允许助手读取。' : '尚未授权任何邮箱，请在邮箱设置中开启助手读取。')
        const page = await this.client.messages({
            accountIds: selected.map(value => value.id),
            scope: 'inbox',
            limit,
            cursor: pageCursor
        }, {agent: true, period, external: signal})
        if (page.errors.length === selected.length && !page.items.length) throw new MailError('transient', '部分邮箱读取失败：' + page.errors.map(error => error.address + '：' + error.message).join('；').slice(0, 1200))
        const results = await mapMailLimit(page.items, 3, async item => {
            const ref = parseMailReference(item.id)
            const summary: MailSummary = {
                id: item.id,
                account: item.accountAddress,
                subject: mailHeader(item.subject, 160),
                from: mailHeader(item.from, 160),
                receivedAt: item.receivedAt,
                sentAt: null,
                read: item.read,
                summary: '',
                summaryStatus: 'unavailable'
            }
            await this.accounts.withAccount(owner, ref.accountId, true, async (configuration, active) => {
                const session = await this.transport(configuration, active)
                try {
                    if (session.uidValidity !== ref.validity) throw new MailError('not_found', '收件箱已变化，请重新列出邮件。')
                    const message = await session.message(ref.uid)
                    if (!message) return
                    summary.sentAt = message.envelope?.date ? new Date(message.envelope.date).toISOString() : null
                    try {
                        summary.summary = (await session.text(message, 32768)).text.replace(/\s+/g, ' ').slice(0, 160)
                        summary.summaryStatus = summary.summary ? 'available' : 'no_text'
                    } catch {
                        active.throwIfAborted()
                    }
                } finally {
                    session.close()
                }
            }, signal)
            return summary
        })
        const items = results.map((result, index) => result.status === 'fulfilled' ? result.value : ({
            id: page.items[index].id,
            account: page.items[index].accountAddress,
            subject: mailHeader(page.items[index].subject, 160),
            from: mailHeader(page.items[index].from, 160),
            receivedAt: page.items[index].receivedAt,
            sentAt: null,
            read: page.items[index].read,
            summary: '',
            summaryStatus: 'unavailable',
        } satisfies MailSummary))
        signal?.throwIfAborted();
        this.accounts.assert(owner, revision)
        const result: MailListResult = {
            mailbox: 'INBOX',
            summaryKind: 'body_excerpt', ...period,
            items,
            ...(page.errors.length ? {
                warnings: page.errors.map(error => ({
                    account: error.address,
                    message: error.message
                }))
            } : {}),
            hasMore: page.hasMore,
            nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({
                ...period,
                page: page.nextCursor, ...(account ? {account} : {})
            })).toString('base64url') : null
        }
        while (JSON.stringify(result).length > 10000 && items.some(item => item.summary.length > 20)) {
            for (const item of items) item.summary = item.summary.slice(0, Math.floor(item.summary.length * 0.7))
        }
        return result
    }

    async read(owner: string, input: MailReadInput, signal?: AbortSignal): Promise<MailBody> {
        this.accounts.owner(owner)
        const ref = parseMailReference(input.id), offset = input.offset ?? 0, limit = input.limit ?? 6000
        if (ref.folder.toUpperCase() !== 'INBOX' || !Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 6000) throw new MailError('invalid_args', '请使用列表中的邮件 ID，正文 limit 不超过 6000。')
        return this.accounts.withAccount(owner, ref.accountId, true, async (account, active) => {
            const session = await this.transport(account, active)
            try {
                if (session.uidValidity !== ref.validity) throw new MailError('not_found', '这条邮件引用已失效，请重新列出邮件。')
                const message = await session.message(ref.uid)
                if (!message) throw new MailError('not_found', '邮件已被移走或删除，请重新列出邮件。')
                const content = await session.text(message, 262144), text = content.text.slice(0, 100000)
                if (offset > text.length) throw new MailError('invalid_args', '正文偏移超出范围，请从 offset=0 重新读取。')
                const result: MailBody = {
                    id: input.id,
                    account: account.address,
                    subject: mailHeader(message.envelope?.subject, 200) || '（无主题）',
                    from: mailHeader(message.envelope?.from?.map(value => value.address).join(', '), 500),
                    to: mailHeader(message.envelope?.to?.map(value => value.address).join(', '), 500),
                    receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : null,
                    sentAt: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null,
                    body: text.slice(offset, offset + limit),
                    availableChars: text.length,
                    offset,
                    hasMore: false,
                    nextOffset: null,
                    bodyTruncated: content.truncated || content.text.length > text.length,
                    note: '未下载附件。'
                }
                if (result.bodyTruncated) result.note = '邮件过长，仅提供部分正文；未下载附件。'
                else if (!text) result.note = '没有可读取的文本正文，邮件可能仅包含图片或附件。'
                while (JSON.stringify(result).length > 11000 && result.body.length > 1) result.body = result.body.slice(0, Math.floor(result.body.length * 0.8))
                result.hasMore = offset + result.body.length < text.length
                result.nextOffset = result.hasMore ? offset + result.body.length : null
                return result
            } catch (error) {
                throw safeMailError(error)
            } finally {
                session.close()
            }
        }, signal)
    }
}
