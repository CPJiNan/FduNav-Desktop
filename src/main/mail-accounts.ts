import {randomBytes} from 'node:crypto'
import type {AppDatabase} from './database'
import type {SecretStorage} from './llm-settings'
import {type MailAccount, type MailAccountInput, type MailInput, validateMailAccount} from '../shared/mail'
import {MailError, safeMailError} from './mail-errors'

export type StoredMailAccount = MailAccountInput & { id: string; lastVerifiedAt: string }
type AccountDocument = { version: 2; accounts: StoredMailAccount[] }
type Repository = Pick<AppDatabase, 'getMailConfiguration' | 'saveMailConfiguration' | 'clearMailConfiguration'>
export type MailAccountVerifier = (account: StoredMailAccount, signal: AbortSignal) => Promise<void>
const clear = (account: MailAccountInput) => {
    account.password = '';
    if (account.smtp) account.smtp.password = ''
}
const sameEndpoint = (a: MailInput, b: MailInput) => a.address === b.address && a.username === b.username && a.host === b.host && a.port === b.port && a.security === b.security

export class MailAccounts {
    private revisions = new Map<string, number>()
    private busy = new Set<string>()
    private pending = new Map<string, Set<AbortController>>()
    private setup = new Map<string, Set<AbortController>>()

    constructor(private db: Repository, private secrets: SecretStorage, private verify: MailAccountVerifier,
                private currentOwner: () => string | null) {
    }

    owner(expected?: string) {
        const owner = this.currentOwner()
        if (!owner || (expected !== undefined && owner !== expected)) throw new MailError('forbidden', '请先登录当前校园账号。')
        return owner
    }

    revision(owner: string) {
        return this.revisions.get(owner) ?? 0
    }

    assert(owner: string, revision: number) {
        this.owner(owner)
        if (this.revision(owner) !== revision) throw new MailError('forbidden', '邮箱设置已变化，请重新操作。')
    }

    async available() {
        try {
            if (await this.secrets.available()) return
        } catch {
        }
        throw new MailError('forbidden', '系统安全存储不可用，无法读取或保存邮箱账号。')
    }

    async list(): Promise<MailAccount[]> {
        const owner = this.owner(), revision = this.revision(owner), accounts = await this.load(owner)
        try {
            this.assert(owner, revision);
            return accounts.map(account => this.present(account))
        } finally {
            accounts.forEach(clear)
        }
    }

    async test(raw: unknown): Promise<{ smtp: boolean }> {
        return this.setupAccount(raw, false) as Promise<{ smtp: boolean }>
    }

    async save(raw: unknown): Promise<MailAccount> {
        return this.setupAccount(raw, true) as Promise<MailAccount>
    }

    cancelSetup() {
        for (const operation of this.setup.get(this.owner()) ?? []) operation.abort();
        return null
    }

    async setAgentAccess(id: string, enabled: boolean): Promise<MailAccount> {
        if (typeof enabled !== 'boolean') throw new MailError('invalid_args', '邮件读取开关无效。')
        return this.exclusive(async (owner, revision) => {
            const accounts = await this.load(owner)
            try {
                const account = accounts.find(item => item.id === id)
                if (!account) throw new MailError('not_found', '邮箱账号不存在。')
                account.enabled = enabled
                await this.persist(owner, revision, accounts);
                return this.present(account)
            } finally {
                accounts.forEach(clear)
            }
        })
    }

    async remove(id: string): Promise<null> {
        return this.exclusive(async (owner, revision) => {
            const accounts = await this.load(owner)
            try {
                if (!accounts.some(account => account.id === id)) throw new MailError('not_found', '邮箱账号不存在。')
                await this.persist(owner, revision, accounts.filter(account => account.id !== id));
                return null
            } finally {
                accounts.forEach(clear)
            }
        })
    }

    async withAccount<T>(expectedOwner: string, id: string, agent: boolean,
                         work: (account: StoredMailAccount, signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
        const owner = this.owner(expectedOwner), revision = this.revision(owner)
        const pending = this.pending.get(owner) ?? new Set<AbortController>()
        if (pending.size >= 8) throw new MailError('transient', '邮箱正在处理其他请求，请稍候重试。')
        const operation = new AbortController();
        pending.add(operation);
        this.pending.set(owner, pending)
        const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(60000), ...(external ? [external] : [])])
        let accounts: StoredMailAccount[] = []
        const watch = setInterval(() => {
            try {
                this.assert(owner, revision)
            } catch {
                operation.abort()
            }
        }, 200)
        try {
            accounts = await this.load(owner);
            signal.throwIfAborted();
            this.assert(owner, revision)
            const account = accounts.find(item => item.id === id)
            if (!account || (agent && !account.enabled)) throw new MailError('forbidden', '该邮箱已移除或未允许助手读取。')
            const result = await work(account, signal)
            signal.throwIfAborted();
            this.assert(owner, revision);
            return result
        } catch (error) {
            if (signal.aborted) throw new MailError('transient', '邮箱请求已取消或超时，请重试。')
            throw safeMailError(error)
        } finally {
            clearInterval(watch);
            accounts.forEach(clear);
            pending.delete(operation)
            if (!pending.size) this.pending.delete(owner)
        }
    }

    private invalidate(owner: string) {
        this.revisions.set(owner, this.revision(owner) + 1)
        for (const operation of this.pending.get(owner) ?? []) operation.abort()
    }

    private async load(owner: string): Promise<StoredMailAccount[]> {
        const value = this.db.getMailConfiguration(owner)
        if (!value) return []
        await this.available()
        try {
            const document = JSON.parse(await this.secrets.decrypt(value))
            // Read existing single-account settings in place; explicit saves upgrade the encrypted document.
            const accounts = document.version === 2 ? document.accounts : [{
                ...document,
                label: document.address,
                smtp: null
            }]
            if (!Array.isArray(accounts) || accounts.length > 20) throw new Error()
            const ids = new Set<string>()
            return accounts.map(raw => {
                const checked = validateMailAccount(raw)
                if (!checked.ok || !checked.data.password || !checked.data.id || ids.has(checked.data.id) ||
                    typeof raw.lastVerifiedAt !== 'string' || !Number.isFinite(Date.parse(raw.lastVerifiedAt))) throw new Error()
                ids.add(checked.data.id)
                return {...checked.data, id: checked.data.id, lastVerifiedAt: raw.lastVerifiedAt}
            })
        } catch {
            throw new MailError('forbidden', '无法解密邮箱设置，请检查系统安全存储。原有账号未被覆盖。')
        }
    }

    private present(account: StoredMailAccount): MailAccount {
        const {password: _password, smtp, ...rest} = account
        return {
            ...rest,
            configured: true,
            smtp: smtp ? (({password: _secret, ...publicSmtp}) => publicSmtp)(smtp) : null
        }
    }

    private async input(raw: unknown, existing: StoredMailAccount[]): Promise<StoredMailAccount> {
        const checked = validateMailAccount(raw)
        if (!checked.ok) throw new MailError('invalid_args', checked.error)
        const input = checked.data, saved = existing.find(account => account.id === input.id)
        if (input.id && !saved) throw new MailError('not_found', '邮箱账号已移除，请重新添加。')
        if (existing.some(account => account.id !== input.id && account.address.toLowerCase() === input.address.toLowerCase())) throw new MailError('invalid_args', '这个邮箱已经添加，请修改已有连接。')
        if (!saved && existing.length >= 20) throw new MailError('invalid_args', '最多可同时连接 20 个邮箱。')
        if (!input.password) {
            if (!saved || !sameEndpoint(input, saved)) throw new MailError('invalid_args', '添加邮箱或更换收信服务器时，请输入密码或授权码。')
            input.password = saved.password
        }
        if (input.smtp) {
            if (input.smtp.useImapCredentials) {
                input.smtp.username = input.username;
                input.smtp.password = input.password
            } else if (!input.smtp.password) {
                if (!saved?.smtp || saved.smtp.useImapCredentials || !sameEndpoint({
                    ...input.smtp,
                    enabled: true
                }, {
                    ...saved.smtp,
                    enabled: true
                })) throw new MailError('invalid_args', '更换发信账号或服务器时，请输入发信密码。')
                input.smtp.password = saved.smtp.password
            }
        }
        return {
            ...input,
            id: saved && sameEndpoint(input, saved) ? saved.id : randomBytes(12).toString('base64url'),
            lastVerifiedAt: saved?.lastVerifiedAt ?? new Date().toISOString()
        }
    }

    private async persist(owner: string, revision: number, accounts: StoredMailAccount[], signal?: AbortSignal) {
        await this.available()
        let encrypted: Uint8Array
        try {
            encrypted = await this.secrets.encrypt(JSON.stringify({version: 2, accounts} satisfies AccountDocument))
        } catch {
            throw new MailError('forbidden', '邮箱账号加密失败，本次修改未保存。')
        }
        this.assert(owner, revision)
        if (signal?.aborted) throw new MailError('forbidden', '操作已取消，设置未保存。')
        this.db.saveMailConfiguration(owner, encrypted);
        this.invalidate(owner)
    }

    private async exclusive<T>(work: (owner: string, revision: number) => Promise<T>): Promise<T> {
        const owner = this.owner()
        if (this.busy.has(owner)) throw new MailError('transient', '正在更新邮箱账号，请稍候。')
        this.busy.add(owner)
        try {
            return await work(owner, this.revision(owner))
        } finally {
            this.busy.delete(owner)
        }
    }

    private async setupAccount(raw: unknown, save: boolean): Promise<MailAccount | { smtp: boolean }> {
        return this.exclusive(async (owner, revision) => {
            const operation = new AbortController(), pending = this.setup.get(owner) ?? new Set<AbortController>()
            pending.add(operation);
            this.setup.set(owner, pending)
            const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(60000)])
            let existing: StoredMailAccount[] = []
            let input: StoredMailAccount | undefined
            const watch = setInterval(() => {
                try {
                    this.assert(owner, revision)
                } catch {
                    operation.abort()
                }
            }, 200)
            try {
                existing = await this.load(owner)
                input = await this.input(raw, existing)
                await this.verify(input, signal);
                signal.throwIfAborted();
                this.assert(owner, revision)
                if (!save) return {smtp: !!input.smtp}
                input.lastVerifiedAt = new Date().toISOString()
                const replacedId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
                const next = existing.filter(account => account.id !== replacedId);
                next.push(input)
                await this.persist(owner, revision, next, signal)
                return this.present(input)
            } catch (error) {
                if (signal.aborted) throw new MailError('transient', operation.signal.aborted ? '连接操作已取消，设置未保存。' : '连接超时，设置未保存。')
                throw safeMailError(error, '验证邮箱连接')
            } finally {
                clearInterval(watch);
                existing.forEach(clear);
                if (input) clear(input)
                pending.delete(operation);
                if (!pending.size) this.setup.delete(owner)
            }
        })
    }
}

export async function mapMailLimit<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(values.length)
    let index = 0
    await Promise.all(Array.from({length: Math.min(limit, values.length)}, async () => {
        while (index < values.length) {
            const i = index++
            try {
                results[i] = {status: 'fulfilled', value: await work(values[i])}
            } catch (reason) {
                results[i] = {status: 'rejected', reason}
            }
        }
    }))
    return results
}
