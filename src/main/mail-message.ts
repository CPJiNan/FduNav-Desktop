import type {FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject} from 'imapflow'
import sanitizeHtml from 'sanitize-html'
import {load} from 'cheerio'
import type {MailAttachment, MailItem, MailMessage} from '../shared/mail'
import type {StoredMailAccount} from './mail-accounts'
import {cleanMailText, mailHtmlToText} from './mail-imap'
import {MailError} from './mail-errors'

export const mailHeader = (value: unknown, limit = 1000) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit)
export const mailAddressList = (addresses?: MessageAddressObject[]) => (addresses ?? []).map(item => item.address).filter((value): value is string => !!value && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))
export function mailReference(accountId: string, folder: string, validity: string, uid: number) {
    return `m2.${accountId}.${Buffer.from(folder).toString('base64url')}.${validity}.${uid}`
}
export function parseMailReference(id: unknown) {
    if (typeof id !== 'string' || id.length > 3000) throw new MailError('invalid_args', '邮件引用无效，请重新选择邮件。')
    const match = /^m2\.([a-zA-Z0-9_-]{16})\.([a-zA-Z0-9_-]{1,2048})\.(\d{1,10})\.(\d{1,10})$/.exec(id)
    const legacy = /^mail\.([a-zA-Z0-9_-]{16})\.(\d{1,10})\.(\d{1,10})$/.exec(id)
    const folder = match ? Buffer.from(match[2], 'base64url').toString('utf8') : 'INBOX'
    const accountId = match?.[1] ?? legacy?.[1], validity = match?.[3] ?? legacy?.[2], uid = Number(match?.[4] ?? legacy?.[3])
    if (!accountId || !validity || !Number.isInteger(uid) || uid < 1 || uid > 4294967295 || !folder || folder.length > 1000 || /[\x00-\x1f\x7f]/.test(folder)) throw new MailError('invalid_args', '邮件引用无效，请重新选择邮件。')
    return {accountId, folder, validity, uid}
}
export function structureParts(node?: MessageStructureObject): MessageStructureObject[] {
    const result: MessageStructureObject[] = []
    const visit = (part: MessageStructureObject, depth: number) => {
        if (depth > 16 || result.length >= 256) return
        result.push(part)
        for (const child of part.childNodes ?? []) visit(child, depth + 1)
    }
    if (node) visit(node, 0)
    return result
}
const attachedPart = (part: MessageStructureObject) => part.disposition === 'attachment' || !!part.dispositionParameters?.filename || !!part.parameters?.name || part.type === 'message/rfc822'
export function messageAttachments(message: FetchMessageObject): MailAttachment[] {
    const result: MailAttachment[] = []; let visited = 0
    const visit = (part: MessageStructureObject, depth: number) => {
        if (depth > 16 || visited++ >= 256) return
        if (part.part && (attachedPart(part) || (!part.childNodes?.length && !/^text\/(?:plain|html)$/.test(part.type)))) {
            const name = mailHeader(part.dispositionParameters?.filename || part.parameters?.name || '附件', 240).replace(/[\/\\]/g, '_')
            result.push({part: part.part, name: !name || /^\.+$/.test(name) ? '附件' : name, type: part.type, size: part.encoding?.toLowerCase() === 'base64' ? Math.ceil((part.size ?? 0) * 3 / 4) : part.size ?? 0})
            return
        }
        for (const child of part.childNodes ?? []) visit(child, depth + 1)
    }
    if (message.bodyStructure) visit(message.bodyStructure, 0)
    return result
}
function bodyParts(node?: MessageStructureObject): MessageStructureObject[] {
    const result: MessageStructureObject[] = []; let visited = 0
    const visit = (part: MessageStructureObject, depth: number) => {
        if (depth > 16 || visited++ >= 256 || attachedPart(part)) return
        if (part.childNodes?.length) {for (const child of part.childNodes) visit(child, depth + 1)}
        else if (/^text\/(?:plain|html)$/.test(part.type)) result.push(part)
    }
    if (node) visit(node, 0)
    return result
}
export function presentMailItem(account: StoredMailAccount, folder: string, validity: string, message: FetchMessageObject): MailItem {
    const envelope = message.envelope
    const date = message.internalDate || envelope?.date
    const receivedAt = date && Number.isFinite(new Date(date).getTime()) ? new Date(date).toISOString() : null
    return {id: mailReference(account.id, folder, validity, message.uid), accountId: account.id, accountAddress: account.address, folder,
        subject: mailHeader(envelope?.subject, 500) || '（无主题）',
        from: mailHeader(envelope?.from?.map(item => item.name ? `${item.name} <${item.address}>` : item.address).join(', ')),
        fromAddress: mailAddressList(envelope?.from)[0] ?? '', to: mailAddressList(envelope?.to).join(', '), receivedAt,
        read: message.flags?.has('\\Seen') ?? false, starred: message.flags?.has('\\Flagged') ?? false, hasAttachments: messageAttachments(message).length > 0}
}
export async function downloadMailPart(client: ImapFlow, uid: number, part: string, maxBytes: number, signal: AbortSignal) {
    signal.throwIfAborted()
    const response = await client.download(uid, part, {uid: true, maxBytes: maxBytes + 1})
    if (!response.content) throw new MailError('not_found', '邮件内容已不存在，请刷新列表。')
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of response.content) {
        signal.throwIfAborted()
        const buffer = Buffer.from(chunk)
        if (bytes < maxBytes) chunks.push(buffer.subarray(0, maxBytes - bytes))
        bytes += buffer.length
    }
    return {data: Buffer.concat(chunks), truncated: bytes > maxBytes}
}
export function sanitizeMailHtml(html: string) {
    const $ = load(html)
    $('head,script,style,noscript,iframe,object,embed,form,svg,video,audio,link,meta,base').remove()
    let remoteImagesBlocked = false
    $('img').each((_i, image) => {
        const node = $(image), src = node.attr('src') ?? ''
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)) {
            remoteImagesBlocked ||= /^https?:/i.test(src)
            node.replaceWith($('<span>').text(node.attr('alt') ? `[${node.attr('alt')}]` : ''))
        }
    })
    const clean = sanitizeHtml($.root().html() ?? '', {
        allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
        allowedAttributes: {a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan', 'style'], th: ['colspan', 'rowspan', 'style'], '*': ['style', 'dir']},
        allowedSchemes: ['https', 'http', 'data'], allowedSchemesByTag: {a: ['https', 'http'], img: ['data']}, allowProtocolRelative: false,
        allowedStyles: {'*': {'text-align': [/^(?:left|right|center|justify)$/], 'font-weight': [/^(?:normal|bold|[1-9]00)$/],
            'font-style': [/^(?:normal|italic)$/], 'text-decoration': [/^(?:none|underline|line-through)$/],
            'white-space': [/^(?:normal|pre|pre-wrap)$/], 'color': [/^#[0-9a-f]{3,8}$/i]}},
        enforceHtmlBoundary: false,
    })
    return {html: clean, remoteImagesBlocked}
}
export async function presentMailMessage(client: ImapFlow, account: StoredMailAccount, folder: string, validity: string,
                                         message: FetchMessageObject, signal: AbortSignal): Promise<MailMessage> {
    const parts = bodyParts(message.bodyStructure)
    const plain: string[] = [], html: string[] = []; let truncated = parts.length > 8, budget = 1048576
    for (const part of parts.slice(0, 8)) {
        if (budget <= 0) {truncated = true; break}
        const result = await downloadMailPart(client, message.uid, part.part ?? '1', budget, signal)
        budget -= result.data.length; truncated ||= result.truncated
        ;(part.type === 'text/html' ? html : plain).push(result.data.toString('utf8'))
    }
    let originalHtml = html.join('\n')
    const inline = structureParts(message.bodyStructure).filter(part => part.id && part.part && /^image\/(?:png|jpeg|gif|webp)$/i.test(part.type) && (part.size ?? Infinity) < 1048576)
    for (const part of inline.slice(0, 4)) {
        const cid = part.id!.replace(/^<|>$/g, '')
        if (!originalHtml.includes('cid:' + cid)) continue
        const result = await downloadMailPart(client, message.uid, part.part!, 1048576, signal)
        if (!result.truncated) originalHtml = originalHtml.split('cid:' + cid).join('data:' + part.type + ';base64,' + result.data.toString('base64'))
    }
    const sanitized = sanitizeMailHtml(originalHtml), envelope = message.envelope
    const headerText = message.headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? ''
    const references = ((/^references:\s*(.+)$/im.exec(headerText)?.[1] ?? '').match(/<[^\s<>]+@[^\s<>]+>/g) ?? []).filter(value => value.length < 1000).slice(-99)
    const messageId = envelope?.messageId && envelope.messageId.length < 1000 && /^<[^\s<>]+@[^\s<>]+>$/.test(envelope.messageId) ? envelope.messageId : ''
    return {...presentMailItem(account, folder, validity, message), body: cleanMailText(plain.join('\n\n') || mailHtmlToText(originalHtml)),
        html: sanitized.html, truncated, attachments: messageAttachments(message), replyTo: mailAddressList(envelope?.replyTo?.length ? envelope.replyTo : envelope?.from),
        recipients: mailAddressList(envelope?.to), cc: mailAddressList(envelope?.cc), messageId, references,
        remoteImagesBlocked: sanitized.remoteImagesBlocked}
}
