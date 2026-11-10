import nodemailer, {type Transporter} from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import type {StoredMailAccount} from './mail-accounts'
import type {MailDraft} from '../shared/mail'
import {MailError, safeMailError} from './mail-errors'

export function smtpConnectionOptions(account: StoredMailAccount) {
    if (!account.smtp) throw new MailError('forbidden', '这个邮箱尚未配置发信服务器，请先在设置中补充 SMTP。')
    const input = account.smtp
    const options: SMTPTransport.Options = {
        host: input.host, port: input.port, secure: input.security === 'tls', requireTLS: input.security === 'starttls',
        tls: {rejectUnauthorized: true, minVersion: 'TLSv1.2'}, auth: {user: input.username, pass: input.password},
        name: 'fdunav.local', connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 45000,
        logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    }
    return options
}
type SmtpFactory = (options: SMTPTransport.Options) => Transporter<SMTPTransport.SentMessageInfo>
const smtpFactory: SmtpFactory = options => nodemailer.createTransport(options)
export async function verifyMailSmtp(account: StoredMailAccount, signal: AbortSignal, factory: SmtpFactory = smtpFactory) {
    signal.throwIfAborted()
    const transport = factory(smtpConnectionOptions(account)), abort = () => transport.close()
    signal.addEventListener('abort', abort, {once: true})
    try {await transport.verify(); signal.throwIfAborted()}
    catch (error) {throw safeMailError(error, '验证发信服务器')}
    finally {signal.removeEventListener('abort', abort); transport.close()}
}
export function mailRecipients(value: string): string[] {
    const addresses = value.split(/[,;；，]/).map(item => item.trim()).filter(Boolean)
    if (addresses.length > 100 || addresses.some(address => address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) throw new MailError('invalid_args', '请填写有效的收件邮箱，多个地址用逗号分隔，每封最多 100 个收件人。')
    return [...new Set(addresses)]
}
export async function prepareMailMessage(account: StoredMailAccount, draft: MailDraft, requestId: string) {
    const to = mailRecipients(draft.to), cc = mailRecipients(draft.cc), bcc = mailRecipients(draft.bcc)
    if (!to.length || to.length + cc.length + bcc.length > 100) throw new MailError('invalid_args', '请填写收件人，每封邮件最多 100 个收件人。')
    const domain = account.address.slice(account.address.lastIndexOf('@') + 1)
    const messageId = '<' + requestId + '@' + domain + '>'
    const compiler = nodemailer.createTransport({streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true})
    const info = await compiler.sendMail({
        from: {name: account.label, address: account.address}, to, cc, subject: draft.subject, text: draft.body,
        messageId, date: new Date(), ...(draft.inReplyTo ? {inReplyTo: draft.inReplyTo} : {}),
        ...(draft.references?.length ? {references: draft.references} : {}),
        attachments: draft.attachments.map(attachment => ({filename: attachment.name, content: Buffer.from(attachment.data, 'base64'), contentType: attachment.type || 'application/octet-stream'})),
    })
    const raw = Buffer.isBuffer(info.message) ? info.message : Buffer.from(String(info.message))
    return {raw, messageId, envelope: {from: account.address, to: [...new Set([...to, ...cc, ...bcc])]}}
}
export async function deliverMail(account: StoredMailAccount, message: Awaited<ReturnType<typeof prepareMailMessage>>, signal: AbortSignal, factory: SmtpFactory = smtpFactory) {
    signal.throwIfAborted()
    const transport = factory(smtpConnectionOptions(account))
    try {
        const result = await transport.sendMail({raw: message.raw, envelope: message.envelope})
        if (!result.accepted.length) throw new MailError('transient', '发信服务器未接受任何收件人，邮件未发出。')
        return {accepted: result.accepted.map(String), rejected: result.rejected.map(String)}
    } catch (error) {
        const v = error as {code?: string; responseCode?: number}
        if (error instanceof MailError || /^(?:EAUTH|EENVELOPE|EDNS)$/.test(v.code ?? '') || (Number.isInteger(v.responseCode) && v.responseCode! >= 400 && v.responseCode! <= 599)) throw safeMailError(error, '发送邮件')
        // A connection can be lost after DATA was accepted. Never retry an uncertain send automatically.
        throw new MailError('send_unknown', '发送结果尚未确认，请先检查“已发送”，不要重复发送。')
    } finally {transport.close()}
}
