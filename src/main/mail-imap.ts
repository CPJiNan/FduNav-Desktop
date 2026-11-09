import {ImapFlow, type ImapFlowOptions, type FetchMessageObject, type MessageStructureObject} from 'imapflow'
import {load} from 'cheerio'
import type {MailInput, MailPeriod} from '../shared/mail.ts'

export interface MailText {text: string; truncated: boolean}
export interface MailSession {
    uidValidity: string
    search(period: MailPeriod): Promise<number[]>
    message(uid: number): Promise<FetchMessageObject | null>
    text(message: FetchMessageObject, maxBytes: number): Promise<MailText>
    close(): void
}
export type MailTransport = (input: MailInput, signal: AbortSignal) => Promise<MailSession>
export const cleanMailText = (value: string) => value.replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
export function mailHtmlToText(html: string) {
    const $ = load(html)
    $('head,script,style,noscript,iframe,object,embed,form,svg').remove()
    $('br').replaceWith('\n'); $('p,div,li,tr,h1,h2,h3,h4,blockquote').append('\n')
    $('a[href]').each((_i, node) => {
        const link = $(node), href = link.attr('href') ?? ''
        if (/^https?:\/\//i.test(href) && href !== link.text().trim()) link.append(' (' + href + ')')
    })
    return cleanMailText($.root().text())
}
export function mailTextParts(node?: MessageStructureObject, depth = 0): MessageStructureObject[] {
    if (!node || depth > 16 || node.disposition === 'attachment' || node.dispositionParameters?.filename || node.parameters?.name || node.type === 'message/rfc822') return []
    if (node.childNodes?.length) {
        const children = node.childNodes.slice(0, 256).map(child => mailTextParts(child, depth + 1))
        if (node.type === 'multipart/alternative') return children.find(parts => parts.some(part => part.type === 'text/plain')) ?? children.find(parts => parts.length) ?? []
        return children.flat()
    }
    return node.type === 'text/plain' || node.type === 'text/html' ? [node] : []
}
// All Agent operations use EXAMINE and BODY.PEEK. There are no mutation or SMTP methods here.
export function createMailTransport(factory: (options: ImapFlowOptions) => ImapFlow = options => new ImapFlow(options)): MailTransport {
    return async (input, signal) => {
        signal.throwIfAborted()
        const client = factory({
            host: input.host, port: input.port, secure: input.security === 'tls',
            ...(input.security === 'starttls' ? {doSTARTTLS: true} : {}), auth: {user: input.username, pass: input.password},
            tls: {rejectUnauthorized: true, minVersion: 'TLSv1.2'}, logger: false, emitLogs: false, logRaw: false,
            disableAutoIdle: true, disableCompression: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
            maxLineLength: 2097152, maxLiteralSize: 2097152, maxResponseSize: 4194304,
            clientInfo: {name: 'FduNav', version: '1.0.0', vendor: 'FduNav'},
        })
        client.on('error', () => {})
        const abort = () => client.close()
        signal.addEventListener('abort', abort, {once: true})
        const close = () => {
            signal.removeEventListener('abort', abort); client.close()
            if (client.options.auth) client.options.auth.pass = ''
        }
        try {
            await client.connect(); signal.throwIfAborted()
            const mailbox = await client.mailboxOpen('INBOX', {readOnly: true}); signal.throwIfAborted()
            return {
                uidValidity: mailbox.uidValidity.toString(), close,
                search: async period => (await client.search({since: period.from,
                    before: new Date(Date.parse(period.to) + 86400000).toISOString().slice(0, 10), deleted: false}, {uid: true})) || [],
                message: async uid => (await client.fetchOne(uid, {uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true}, {uid: true})) || null,
                text: async (message, maxBytes) => {
                    const parts = mailTextParts(message.bodyStructure), output: string[] = []
                    let remaining = maxBytes, truncated = parts.length > 8
                    for (const part of parts.slice(0, 8)) {
                        if (remaining <= 0) {truncated = true; break}
                        signal.throwIfAborted()
                        const response = await client.download(message.uid, part.part ?? '1', {uid: true, maxBytes: remaining})
                        if (!response.content) throw new Error('mail_body_missing')
                        const chunks: Buffer[] = []
                        let bytes = 0
                        for await (const chunk of response.content) {
                            signal.throwIfAborted()
                            const buffer = Buffer.from(chunk)
                            if (bytes < remaining) chunks.push(buffer.subarray(0, remaining - bytes))
                            bytes += buffer.length
                        }
                        const kept = Math.min(bytes, remaining), body = Buffer.concat(chunks, kept).toString('utf8')
                        if (bytes >= remaining || (part.size ?? 0) > remaining) truncated = true
                        remaining -= kept; output.push(part.type === 'text/html' ? mailHtmlToText(body) : cleanMailText(body))
                    }
                    return {text: cleanMailText(output.join('\n\n')), truncated}
                },
            }
        } catch (error) {close(); throw error}
    }
}
