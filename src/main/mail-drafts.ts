import {createHash} from 'node:crypto'
import type {AppDatabase} from './database'
import type {SecretStorage} from './llm-settings'
import type {MailAccounts} from './mail-accounts'
import {validateMailDraft, type MailDraft, type MailDraftSummary, type MailSendResult} from '../shared/mail'
import {MailError} from './mail-errors'

export interface MailSendReceipt {
    fingerprint: string; state: 'pending' | 'sent' | 'unknown' | 'failed'; result?: MailSendResult
}
export class MailDrafts {
    private saving = new Set<string>()
    constructor(private db: AppDatabase, private secrets: SecretStorage, private accounts: MailAccounts) {}
    private validId(id: unknown): asserts id is string {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(id)) throw new MailError('invalid_args', '草稿引用无效。')
    }
    private summary(draft: MailDraft): MailDraftSummary {
        return {id: draft.id, accountId: draft.accountId, to: draft.to, subject: draft.subject, preview: draft.body.slice(0, 160), updatedAt: draft.updatedAt, ...(draft.sendState ? {sendState: draft.sendState} : {})}
    }
    async get(id: string): Promise<MailDraft> {
        this.validId(id)
        const owner = this.accounts.owner(), revision = this.accounts.revision(owner)
        await this.accounts.available()
        const encrypted = this.db.getMailDraft(owner, id)
        if (!encrypted) throw new MailError('not_found', '草稿已不存在。')
        try {
            const raw = JSON.parse(await this.secrets.decrypt(encrypted)), checked = validateMailDraft(raw)
            this.accounts.assert(owner, revision)
            if (!checked.ok || raw.id !== id || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) throw new Error()
            return {...checked.data, updatedAt: raw.updatedAt}
        } catch (error) {
            if (error instanceof MailError) throw error
            throw new MailError('forbidden', '无法解密这封草稿，原内容未被修改。')
        }
    }
    async list(): Promise<MailDraftSummary[]> {
        const owner = this.accounts.owner(), summaries: MailDraftSummary[] = []
        for (const id of this.db.listMailDraftIds(owner)) {
            const draft = await this.get(id); summaries.push(this.summary(draft))
        }
        this.accounts.owner(owner); return summaries
    }
    async save(raw: unknown, internal = false): Promise<MailDraftSummary> {
        const checked = validateMailDraft(raw)
        if (!checked.ok) throw new MailError('invalid_args', checked.error)
        const draft = checked.data, owner = this.accounts.owner(), revision = this.accounts.revision(owner), key = owner + ':' + draft.id
        if (this.saving.has(key)) throw new MailError('transient', '正在保存这封草稿，请稍候。')
        this.saving.add(key)
        try {
            await this.accounts.available()
            const existing = this.db.getMailDraft(owner, draft.id) ? await this.get(draft.id) : null
            if (!internal && existing?.sendState && (draft.sendRequestId !== existing.sendRequestId || draft.sendState !== existing.sendState || this.fingerprint(existing) !== this.fingerprint(draft))) throw new MailError('forbidden', '这封草稿的发送结果尚未确认，请先核对已发送邮件。')
            const accounts = await this.accounts.list()
            if (!accounts.some(account => account.id === draft.accountId)) throw new MailError('forbidden', '发件邮箱已移除，请选择另一个邮箱后保存。')
            if (!this.db.getMailDraft(owner, draft.id) && this.db.listMailDraftIds(owner).length >= 200) throw new MailError('invalid_args', '本地草稿已达 200 封，请先清理不需要的草稿。')
            const encrypted = await this.secrets.encrypt(JSON.stringify(draft))
            this.accounts.assert(owner, revision)
            this.db.saveMailDraft(owner, draft.id, encrypted, draft.updatedAt)
            return this.summary(draft)
        } finally {this.saving.delete(key)}
    }
    remove(id: string): null {this.validId(id); this.db.deleteMailDraft(this.accounts.owner(), id); return null}
    fingerprint(draft: MailDraft) {
        const {id: _id, updatedAt: _updatedAt, sendRequestId: _request, sendState: _state, ...content} = draft
        return createHash('sha256').update(JSON.stringify(content)).digest('hex')
    }
    async receipt(owner: string, id: string): Promise<MailSendReceipt | null> {
        this.validId(id); this.accounts.owner(owner); await this.accounts.available()
        const raw = this.db.getMailSend(owner, id)
        if (!raw) return null
        try {
            const receipt = JSON.parse(await this.secrets.decrypt(raw)) as MailSendReceipt
            this.accounts.owner(owner)
            if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !['pending', 'sent', 'unknown', 'failed'].includes(receipt.state) ||
                (receipt.result && (!['sent', 'unknown'].includes(receipt.result.status) || typeof receipt.result.message !== 'string' || receipt.result.message.length > 4096 || (receipt.result.messageId !== null && typeof receipt.result.messageId !== 'string'))) ||
                (receipt.state === 'sent' && receipt.result?.status !== 'sent')) throw new Error()
            return receipt
        }
        catch {throw new MailError('forbidden', '无法读取发送状态，请先检查“已发送”，避免重复发送。')}
    }
    async saveReceipt(owner: string, id: string, receipt: MailSendReceipt) {
        this.validId(id); await this.accounts.available()
        // Preserve the receipt under its original owner even if the user switches accounts during SMTP delivery.
        const encrypted = await this.secrets.encrypt(JSON.stringify(receipt))
        this.db.saveMailSend(owner, id, encrypted)
    }
}
