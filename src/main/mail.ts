import {BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, shell} from 'electron'
import {writeFile} from 'node:fs/promises'
import type {Result} from '../shared/accounts'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import type {MailDraft, MailQuery} from '../shared/mail'
import {secureStorage} from './secure-storage'
import {createMailTransport} from './mail-imap'
import {MailService} from './mail-service'
import {MailAccounts} from './mail-accounts'
import {MailClient} from './mail-client'
import {MailDrafts} from './mail-drafts'
import {verifyMailSmtp} from './mail-smtp'
import {MailError} from './mail-errors'

export function registerMailHandlers(db: AppDatabase, campus: AccountService, trusted: (event: IpcMainInvokeEvent) => boolean) {
    const owner = () => {
        const account = campus.getState();
        return account.status === 'signed-in' ? account.username : null
    }
    const transport = createMailTransport()
    const accounts = new MailAccounts(db, secureStorage, async (account, signal) => {
        const session = await transport(account, signal)
        session.close()
        if (account.smtp) await verifyMailSmtp(account, signal)
    }, owner)
    const drafts = new MailDrafts(db, secureStorage, accounts), client = new MailClient(accounts, drafts)
    const agent = new MailService(accounts, client, transport)
    const object = (input: unknown): Record<string, unknown> => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MailError('invalid_args', '请求格式无效。')
        return input as Record<string, unknown>
    }

    function handle<T>(channel: string, action: (input: unknown, event: IpcMainInvokeEvent) => Promise<T> | T) {
        ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                accounts.owner();
                return {ok: true, data: await action(input, event)}
            } catch (error) {
                return {ok: false, error: error instanceof MailError ? error.message : '邮箱操作失败，请重试。'}
            } finally {
                if (input && typeof input === 'object') {
                    if (typeof input.password === 'string') input.password = ''
                    if (input.smtp && typeof input.smtp === 'object' && typeof input.smtp.password === 'string') input.smtp.password = ''
                }
            }
        })
    }

    handle('mail:accounts', () => accounts.list())
    handle('mail:save-account', input => accounts.save(input))
    handle('mail:test-account', input => accounts.test(input))
    handle('mail:cancel-setup', () => accounts.cancelSetup())
    handle('mail:set-agent-access', input => {
        const value = object(input);
        return accounts.setAgentAccess(value.id as string, value.enabled as boolean)
    })
    handle('mail:remove-account', input => accounts.remove(input as string))
    handle('mail:folders', input => client.folders(input as string[] | undefined))
    handle('mail:messages', input => client.messages(input as MailQuery))
    handle('mail:message', input => {
        const value = object(input);
        return client.message(value.id as string, value.markRead as boolean | undefined)
    })
    handle('mail:set-flags', input => client.flags(object(input) as { id: string; read?: boolean; starred?: boolean }))
    handle('mail:trash', input => client.trash(input as string))
    handle('mail:download-attachment', async (input, event) => {
        const value = object(input), username = accounts.owner(),
            attachment = await client.attachment(value.id as string, value.part as string)
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options = {
            defaultPath: attachment.name,
            properties: ['showOverwriteConfirmation'] as ('showOverwriteConfirmation')[]
        }
        try {
            const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
            if (result.canceled || !result.filePath) return {saved: false}
            accounts.owner(username)
            await writeFile(result.filePath, attachment.data, {mode: 0o600})
            return {saved: true}
        } finally {
            attachment.data.fill(0)
        }
    })
    handle('mail:read-attachment', async input => {
        const value = object(input), attachment = await client.attachment(value.id as string, value.part as string)
        try {
            if (value.forForward !== undefined && typeof value.forForward !== 'boolean') throw new MailError('invalid_args', '附件参数无效。')
            if (attachment.data.length > (value.forForward ? 20 : 8) * 1024 * 1024) throw new MailError('invalid_args', '附件超过 8 MB，请下载后查看。')
            return {data: attachment.data.toString('base64'), name: attachment.name, type: attachment.type}
        } finally {
            attachment.data.fill(0)
        }
    })
    handle('mail:drafts', () => drafts.list())
    handle('mail:draft', input => drafts.get(input as string))
    handle('mail:save-draft', input => drafts.save(input))
    handle('mail:release-draft', input => client.releaseDraft(input as string))
    handle('mail:delete-draft', input => drafts.remove(input as string))
    handle('mail:send', input => client.send(object(input) as unknown as { draft: MailDraft; requestId: string }))
    handle('mail:open-link', async input => {
        if (typeof input !== 'string' || input.length > 4096) throw new MailError('invalid_args', '链接无效。')
        let url: URL
        try {
            url = new URL(input)
        } catch {
            throw new MailError('invalid_args', '链接无效。')
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new MailError('forbidden', '不支持打开这种链接。')
        await shell.openExternal(url.href);
        return null
    })
    return agent
}
