import {createHash} from 'node:crypto'
import {ImapFlow, type FetchMessageObject, type SearchObject} from 'imapflow'
import {MailAccounts, mapMailLimit, type StoredMailAccount} from './mail-accounts'
import {mailConnectionOptions} from './mail-imap'
import {MailError, safeMailError} from './mail-errors'
import {downloadMailPart, messageAttachments, parseMailReference, presentMailItem, presentMailMessage} from './mail-message'
import type {MailAccount, MailFolder, MailItem, MailMessage, MailPage, MailPeriod, MailQuery, MailScope, MailDraft, MailSendResult} from '../shared/mail'
import {validateMailDraft} from '../shared/mail'
import {MailDrafts} from './mail-drafts'
import {deliverMail, prepareMailMessage} from './mail-smtp'

type Position = {before: number; validity: string}
type PageCursor = {v: 1; signature: string; positions: Record<string, Position>}
type Stream = {key: string; validity: string; items: {uid: number; item: MailItem}[]; hasMore: boolean}
const streamKey = (id: string, folder: string) => id + ':' + Buffer.from(folder).toString('base64url')
const folderMatches = (folder: MailFolder, use: string, fallback: RegExp) => folder.specialUse === use || fallback.test(folder.path)

export class MailClient {
    private folderCache = new Map<string, {until: number; folders: MailFolder[]}>()
    private sending = new Set<string>()
    constructor(readonly accounts: MailAccounts, readonly drafts: MailDrafts,
                private factory: (options: ReturnType<typeof mailConnectionOptions>) => ImapFlow = options => new ImapFlow(options),
                private deliver: typeof deliverMail = deliverMail) {}
    private async imap<T>(owner: string, id: string, agent: boolean,
                          work: (client: ImapFlow, account: StoredMailAccount, signal: AbortSignal) => Promise<T>, external?: AbortSignal) {
        return this.accounts.withAccount(owner, id, agent, async (account, signal) => {
            const client = this.factory(mailConnectionOptions(account)), abort = () => client.close()
            client.on('error', () => {}); signal.addEventListener('abort', abort, {once: true})
            try {signal.throwIfAborted(); await client.connect(); signal.throwIfAborted(); return await work(client, account, signal)}
            finally {signal.removeEventListener('abort', abort); client.close(); if (client.options.auth) client.options.auth.pass = ''}
        }, external)
    }
    private async selected(ids?: string[], agent = false): Promise<MailAccount[]> {
        if (ids !== undefined && (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16}$/.test(id)))) throw new MailError('invalid_args', '邮箱筛选条件无效。')
        const all = await this.accounts.list(), allowed = all.filter(account => !agent || account.enabled)
        if (ids?.some(id => !allowed.some(account => account.id === id))) throw new MailError('forbidden', '所选邮箱不存在或未授权读取。')
        return ids?.length ? allowed.filter(account => ids.includes(account.id)) : allowed
    }
    private async listFolders(client: ImapFlow, account: StoredMailAccount): Promise<MailFolder[]> {
        const rows = await client.list({statusQuery: {messages: true, unseen: true}})
        return rows.filter(folder => !folder.flags?.has('\\Noselect') && folder.path && folder.path.length <= 1000 && !/[\x00-\x1f\x7f]/.test(folder.path))
            .map(folder => ({accountId: account.id, path: folder.path, name: folder.name || folder.path,
                specialUse: folder.specialUse ?? null, messages: folder.status?.messages ?? null, unread: folder.status?.unseen ?? null}))
    }
    async folders(ids?: string[]): Promise<{folders: MailFolder[]; errors: MailPage['errors']}> {
        const owner = this.accounts.owner(), revision = this.accounts.revision(owner), selected = await this.selected(ids), folders: MailFolder[] = [], errors: MailPage['errors'] = []
        const result = await mapMailLimit(selected, 3, async account => {
            const key = owner + ':' + account.id + ':' + this.accounts.revision(owner), cached = this.folderCache.get(key)
            if (cached && cached.until > Date.now()) return cached.folders
            const value = await this.imap(owner, account.id, false, (client, stored) => this.listFolders(client, stored))
            this.folderCache.set(key, {folders: value, until: Date.now() + 30000}); return value
        })
        result.forEach((value, index) => {
            if (value.status === 'fulfilled') folders.push(...value.value)
            else errors.push({accountId: selected[index].id, address: selected[index].address, message: safeMailError(value.reason).message})
        })
        this.accounts.assert(owner, revision); return {folders, errors}
    }
    private chooseFolders(folders: MailFolder[], scope: MailScope, folder?: string): MailFolder[] {
        if (folder) {
            const selected = folders.find(value => value.path === folder)
            if (!selected) throw new MailError('not_found', '文件夹已不存在，请刷新文件夹列表。')
            return [selected]
        }
        if (scope === 'inbox') return folders.filter(value => value.path.toUpperCase() === 'INBOX' || value.specialUse === '\\Inbox').slice(0, 1)
        if (scope === 'sent') return folders.filter(value => folderMatches(value, '\\Sent', /^(?:sent(?: messages| items)?|已发送|发件箱)$/i)).slice(0, 1)
        if (scope === 'trash') return folders.filter(value => folderMatches(value, '\\Trash', /^(?:trash|deleted(?: messages| items)?|已删除|废纸篓)$/i)).slice(0, 1)
        const all = folders.find(value => value.specialUse === '\\All')
        return all ? [all] : folders.filter(value => !['\\Trash', '\\Junk'].includes(value.specialUse ?? '') && !/^(?:trash|junk|spam|已删除|垃圾邮件|垃圾箱)$/i.test(value.path))
    }
    async messages(raw: MailQuery = {}, options: {agent?: boolean; period?: MailPeriod; external?: AbortSignal} = {}): Promise<MailPage> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MailError('invalid_args', '邮件查询条件无效。')
        if (raw.query !== undefined && typeof raw.query !== 'string') throw new MailError('invalid_args', '搜索条件须为文本。')
        const scope = raw.scope ?? 'inbox', query = raw.query?.trim() ?? '', limit = raw.limit ?? 30
        if (!['inbox', 'all', 'starred', 'sent', 'trash'].includes(scope) || typeof query !== 'string' || query.length > 200 || /[\x00-\x1f\x7f]/.test(query) ||
            !Number.isInteger(limit) || limit < 1 || limit > 50 || (raw.unreadOnly !== undefined && typeof raw.unreadOnly !== 'boolean') ||
            (raw.folder !== undefined && (typeof raw.folder !== 'string' || !raw.folder || raw.folder.length > 1000 || /[\x00-\x1f\x7f]/.test(raw.folder)))) throw new MailError('invalid_args', '邮件查询条件无效。')
        const owner = this.accounts.owner(), revision = this.accounts.revision(owner), selected = await this.selected(raw.accountIds, options.agent)
        if (raw.folder && selected.length !== 1) throw new MailError('invalid_args', '查看单个文件夹时，请先选择一个邮箱。')
        const signature = createHash('sha256').update(JSON.stringify({ids: selected.map(account => account.id).sort(), scope, query, folder: raw.folder ?? '', unread: !!raw.unreadOnly, period: options.period ?? null, revision})).digest('hex')
        let cursor: PageCursor = {v: 1, signature, positions: {}}
        if (raw.cursor !== undefined) {
            try {
                if (typeof raw.cursor !== 'string' || raw.cursor.length > 262144 || !/^[a-zA-Z0-9_-]+$/.test(raw.cursor)) throw new Error()
                const parsed = JSON.parse(Buffer.from(raw.cursor, 'base64url').toString()) as PageCursor
                if (parsed.v !== 1 || parsed.signature !== signature || !parsed.positions || typeof parsed.positions !== 'object' || Array.isArray(parsed.positions)) throw new Error()
                for (const value of Object.values(parsed.positions)) if (!value || !Number.isInteger(value.before) || value.before < 1 || value.before > 4294967296 || !/^\d{1,10}$/.test(value.validity)) throw new Error()
                cursor = parsed
            } catch {throw new MailError('invalid_args', '邮件列表已变化，请刷新后重新查看。')}
        }
        const streams: Stream[] = [], errors: MailPage['errors'] = []
        const results = await mapMailLimit(selected, 3, async account => this.imap(owner, account.id, !!options.agent, async (client, stored, signal) => {
            const result: Stream[] = []
            const folders = this.chooseFolders(await this.listFolders(client, stored), scope, raw.folder)
            if (folders.length > 100) throw new MailError('invalid_args', '文件夹较多，请选择单个文件夹查看。')
            for (const folder of folders) {
                signal.throwIfAborted()
                const box = await client.mailboxOpen(folder.path, {readOnly: true}), validity = box.uidValidity.toString(), key = streamKey(account.id, folder.path)
                const position = cursor.positions[key]
                if (position && position.validity !== validity) throw new MailError('invalid_args', '收件箱已变化，请刷新邮件列表。')
                const search: SearchObject = {deleted: false}
                if (query) search.or = [{subject: query}, {from: query}, {to: query}, {body: query}]
                if (raw.unreadOnly) search.seen = false
                if (scope === 'starred') search.flagged = true
                if (options.period) {search.since = options.period.from; search.before = new Date(Date.parse(options.period.to) + 86400000).toISOString().slice(0, 10)}
                const found = await client.search(search, {uid: true})
                const uids = (found || []).filter(uid => !position || uid < position.before).sort((a, b) => b - a)
                if (!uids.length) continue
                const candidateIds = uids.slice(0, limit + 1)
                const messages = await client.fetchAll(candidateIds.join(','), {uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true}, {uid: true})
                const byId = new Map(messages.map(message => [message.uid, message]))
                const items = candidateIds.flatMap(uid => {const message = byId.get(uid); return message ? [{uid, item: presentMailItem(stored, folder.path, validity, message)}] : []})
                result.push({key, validity, items, hasMore: uids.length > candidateIds.length})
            }
            return result
        }, options.external))
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') streams.push(...result.value)
            else errors.push({accountId: selected[index].id, address: selected[index].address, message: safeMailError(result.reason).message})
        })
        const items: MailItem[] = [], positions = {...cursor.positions}
        // Retain UIDVALIDITY even for a stream whose first item was not selected on this page.
        for (const stream of streams) if (!positions[stream.key] && stream.items.length) positions[stream.key] = {before: stream.items[0].uid + 1, validity: stream.validity}
        // Merge the head of each UID-ordered stream. Advancing only consumed prefixes avoids gaps on backdated messages.
        while (items.length < limit) {
            const next = streams.filter(stream => stream.items.length).sort((a, b) => (b.items[0].item.receivedAt ?? '').localeCompare(a.items[0].item.receivedAt ?? '') || a.key.localeCompare(b.key))[0]
            if (!next) break
            const selectedItem = next.items.shift()!; items.push(selectedItem.item)
            positions[next.key] = {before: selectedItem.uid, validity: next.validity}
        }
        const hasMore = streams.some(stream => stream.items.length || stream.hasMore)
        this.accounts.assert(owner, revision)
        return {items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({v: 1, signature, positions} satisfies PageCursor)).toString('base64url') : null, errors}
    }
    private async selectMessage(client: ImapFlow, id: string, readOnly: boolean) {
        const reference = parseMailReference(id), box = await client.mailboxOpen(reference.folder, {readOnly})
        if (box.uidValidity.toString() !== reference.validity) throw new MailError('not_found', '邮件引用已失效，请刷新列表。')
        const message = await client.fetchOne(reference.uid, {uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: ['references']}, {uid: true})
        if (!message) throw new MailError('not_found', '邮件已被移走或删除，请刷新列表。')
        return {reference, message}
    }
    async message(id: string, markRead = false): Promise<MailMessage> {
        const reference = parseMailReference(id), owner = this.accounts.owner()
        if (typeof markRead !== 'boolean') throw new MailError('invalid_args', '邮件读取参数无效。')
        return this.imap(owner, reference.accountId, false, async (client, account, signal) => {
            const {message} = await this.selectMessage(client, id, !markRead)
            const result = await presentMailMessage(client, account, reference.folder, reference.validity, message, signal)
            if (markRead && !result.read) {if (!await client.messageFlagsAdd(reference.uid, ['\\Seen'], {uid: true})) throw new MailError('transient', '已读标记未能保存，请重试。'); result.read = true; this.folderCache.clear()}
            return result
        })
    }
    async flags(input: {id: string; read?: boolean; starred?: boolean}): Promise<null> {
        if (!input || (input.read !== undefined && typeof input.read !== 'boolean') || (input.starred !== undefined && typeof input.starred !== 'boolean') || (input.read === undefined && input.starred === undefined)) throw new MailError('invalid_args', '邮件标记参数无效。')
        const reference = parseMailReference(input.id), owner = this.accounts.owner()
        await this.imap(owner, reference.accountId, false, async client => {
            await this.selectMessage(client, input.id, false)
            for (const [flag, value] of [['\\Seen', input.read], ['\\Flagged', input.starred]] as const) {
                if (value === undefined) continue
                const ok = value ? await client.messageFlagsAdd(reference.uid, [flag], {uid: true}) : await client.messageFlagsRemove(reference.uid, [flag], {uid: true})
                if (!ok) throw new MailError('transient', '服务器未能更新标记，请刷新后重试。')
            }
        })
        this.folderCache.clear(); return null
    }
    async trash(id: string): Promise<null> {
        const reference = parseMailReference(id), owner = this.accounts.owner()
        await this.imap(owner, reference.accountId, false, async (client, account) => {
            const folders = await this.listFolders(client, account), trash = this.chooseFolders(folders, 'trash')[0]
            if (!trash) throw new MailError('forbidden', '邮箱没有可识别的垃圾箱，请先在网页版建立或指定垃圾箱。')
            if (trash.path === reference.folder) throw new MailError('forbidden', '这封邮件已在垃圾箱中。FduNav 不提供永久删除。')
            await this.selectMessage(client, id, false)
            // Do not fall back to COPY + broad EXPUNGE; it could purge unrelated deleted messages.
            if (!client.capabilities.has('MOVE') && !client.capabilities.has('IMAP4rev2')) throw new MailError('forbidden', '这个服务器不支持安全移动邮件，请在官方邮箱中处理。')
            if (!await client.messageMove(reference.uid, trash.path, {uid: true})) throw new MailError('transient', '邮件未能移入垃圾箱，请刷新后重试。')
        })
        this.folderCache.clear(); return null
    }
    async attachment(id: string, part: string): Promise<{data: Buffer; name: string; type: string}> {
        if (typeof part !== 'string' || !/^\d+(?:\.\d+)*$/.test(part) || part.length > 60) throw new MailError('invalid_args', '附件引用无效。')
        const reference = parseMailReference(id), owner = this.accounts.owner()
        return this.imap(owner, reference.accountId, false, async (client, _account, signal) => {
            const {message} = await this.selectMessage(client, id, true), attachment = messageAttachments(message).find(value => value.part === part)
            if (!attachment) throw new MailError('not_found', '附件已不存在。')
            if (attachment.size > 25 * 1024 * 1024) throw new MailError('invalid_args', '附件超过 25 MB，请使用官方邮箱下载。')
            const result = await downloadMailPart(client, reference.uid, part, 25 * 1024 * 1024, signal)
            if (result.truncated) throw new MailError('invalid_args', '附件超过下载上限，未保存不完整文件。')
            return {data: result.data, name: attachment.name, type: attachment.type}
        })
    }
    async releaseDraft(id: string): Promise<MailDraft> {
        const owner = this.accounts.owner(), draft = await this.drafts.get(id)
        if (draft.sendRequestId && this.sending.has(owner + ':' + draft.sendRequestId)) throw new MailError('transient', '邮件仍在发送，请等待结果。')
        if (draft.sendRequestId) {
            const receipt = await this.drafts.receipt(owner, draft.sendRequestId)
            if (receipt?.state === 'sent') throw new MailError('forbidden', '发信服务器已接受这封邮件，请查看已发送邮件。')
        }
        delete draft.sendState; delete draft.sendRequestId
        await this.drafts.save(draft, true)
        return draft
    }
    async send(raw: {draft: MailDraft; requestId: string}): Promise<MailSendResult> {
        if (!raw || typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(raw.requestId)) throw new MailError('invalid_args', '发送请求无效。')
        const checked = validateMailDraft(raw.draft)
        if (!checked.ok) throw new MailError('invalid_args', checked.error)
        const draft = checked.data, owner = this.accounts.owner(), key = owner + ':' + raw.requestId
        if (this.sending.has(key)) throw new MailError('transient', '这封邮件正在发送，请勿重复操作。')
        this.sending.add(key)
        const fingerprint = this.drafts.fingerprint(draft)
        try {
            try {
                const existing = await this.drafts.get(draft.id)
                if (existing.sendState && existing.sendRequestId !== raw.requestId) throw new MailError('forbidden', '这封草稿的发送结果尚未确认，请先核对已发送邮件。')
            } catch (error) {if (!(error instanceof MailError) || error.code !== 'not_found') throw error}
            const receipt = await this.drafts.receipt(owner, raw.requestId)
            if (receipt && receipt.fingerprint !== fingerprint) throw new MailError('invalid_args', '发送内容已变化，请重新打开草稿后发送。')
            if (receipt?.state === 'sent') {
                try {if (this.drafts.fingerprint(await this.drafts.get(draft.id)) === fingerprint) this.drafts.remove(draft.id)}
                catch (error) {if (!(error instanceof MailError) || error.code !== 'not_found') throw error}
                return receipt.result!
            }
            if (receipt && receipt.state !== 'failed') return receipt.result ?? {status: 'unknown', message: '上次发送结果尚未确认，请先检查“已发送”，不要重复发送。', messageId: null}
            return await this.accounts.withAccount(owner, draft.accountId, false, async (account, signal) => {
                if (!account.smtp) throw new MailError('forbidden', '请先为这个账号配置 SMTP 发信服务器。')
                const prepared = await prepareMailMessage(account, draft, raw.requestId)
                // Lock the encrypted draft before SMTP: a process crash must never reopen it as an unsent draft.
                await this.drafts.save({...draft, sendState: 'unknown', sendRequestId: raw.requestId}, true)
                await this.drafts.saveReceipt(owner, raw.requestId, {fingerprint, state: 'pending'})
                let delivered: Awaited<ReturnType<typeof deliverMail>>
                try {delivered = await this.deliver(account, prepared, signal)}
                catch (error) {
                    const known = error instanceof MailError && error.code !== 'send_unknown'
                    const result: MailSendResult = {status: 'unknown', message: known ? error.message : '发送结果尚未确认，请先检查“已发送”，不要重复发送。', messageId: prepared.messageId}
                    await this.drafts.saveReceipt(owner, raw.requestId, {fingerprint, state: known ? 'failed' : 'unknown', result})
                    if (known) {
                        const unlocked = {...draft}; delete unlocked.sendState; delete unlocked.sendRequestId
                        await this.drafts.save(unlocked, true)
                        throw error
                    }
                    return result
                }
                // Persist acceptance before trying to save a sent copy. Failure to archive must not cause a resend.
                const result: MailSendResult = {status: 'sent', message: delivered.rejected.length ? '邮件已发送。以下收件人未被接受：' + delivered.rejected.join(', ').slice(0, 1200) : '邮件已发送。', messageId: prepared.messageId}
                await this.drafts.saveReceipt(owner, raw.requestId, {fingerprint, state: 'sent', result})
                this.accounts.owner(owner); this.drafts.remove(draft.id)
                try {
                    await this.imap(owner, account.id, false, async (client, stored) => {
                        const folders = await this.listFolders(client, stored), sent = this.chooseFolders(folders, 'sent')[0]
                        if (!sent) throw new Error()
                        await client.mailboxOpen(sent.path, {readOnly: true})
                        const copies = await client.search({header: {'Message-ID': prepared.messageId}}, {uid: true})
                        if (!(copies || []).length && !await client.append(sent.path, prepared.raw, ['\\Seen'])) throw new Error()
                    })
                } catch {result.message += ' 已发送副本未能确认，请在官方邮箱核对。'}
                await this.drafts.saveReceipt(owner, raw.requestId, {fingerprint, state: 'sent', result})
                this.folderCache.clear(); return result
            })
        } finally {this.sending.delete(key)}
    }
}
