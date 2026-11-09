import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:tls'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {ImapFlow} from 'imapflow'
import {createMailTransport} from '../src/main/mail-imap.ts'

// Real ImapFlow + verified TLS against a disposable IMAP fixture. No real user data or password.
test('real IMAP wire smoke decodes Chinese MIME and never changes flags', {timeout: 20000}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'fdunav-imap-test-'))
    t.after(() => rmSync(directory, {recursive: true, force: true}))
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost'], {stdio: 'ignore'})
    } catch {t.skip('OpenSSL is required for the disposable TLS certificate'); return}
    const key = readFileSync(join(directory, 'key.pem')), cert = readFileSync(join(directory, 'cert.pem'))
    const commands: string[] = [], sockets = new Set<import('node:tls').TLSSocket>()
    const encoded = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd5, 0xfd, 0xce, 0xc4]).toString('base64')
    const mime = Buffer.from('Content-Type: text/plain; charset=gb18030\r\nContent-Transfer-Encoding: base64\r\n\r\n')
    const subject = '=?UTF-8?B?' + Buffer.from('中文主题').toString('base64') + '?='
    const envelope = '("Mon, 9 Nov 2026 10:00:00 +0800" "' + subject + '" (("Office" NIL "office" "example.com")) NIL NIL ((NIL NIL "student" "example.com")) NIL NIL NIL "<fixture@example.com>")'
    const structure = '("TEXT" "PLAIN" ("CHARSET" "GB18030") NIL NIL "BASE64" ' + encoded.length + ' 1 NIL NIL NIL NIL)'
    const server = createServer({key, cert}, socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR ID] Fixture ready\r\n')
        let pending = '', authTag = ''
        socket.on('data', chunk => {
            pending += chunk.toString()
            while (pending.includes('\r\n')) {
                const end = pending.indexOf('\r\n'), line = pending.slice(0, end)
                pending = pending.slice(end + 2)
                if (authTag) {socket.write(authTag + ' OK authenticated\r\n'); authTag = ''; continue}
                const match = /^(\S+)\s+(.*)$/.exec(line)
                if (!match) continue
                const [, tag, command] = match, upper = command.toUpperCase()
                commands.push(upper.startsWith('AUTHENTICATE') ? 'AUTHENTICATE' : upper)
                const ok = () => socket.write(tag + ' OK completed\r\n')
                if (upper.startsWith('CAPABILITY')) {socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR ID\r\n'); ok()}
                else if (upper.startsWith('AUTHENTICATE')) {
                    if (command.trim().split(/\s+/).length > 2) ok()
                    else {authTag = tag; socket.write('+ \r\n')}
                } else if (upper.startsWith('LOGIN')) ok()
                else if (upper.startsWith('ID ')) {socket.write('* ID NIL\r\n'); ok()}
                else if (upper.startsWith('LIST') || upper.startsWith('LSUB')) {socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n'); ok()}
                else if (upper.startsWith('EXAMINE')) {
                    socket.write('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 77] valid\r\n* OK [UIDNEXT 6] next\r\n')
                    socket.write(tag + ' OK [READ-ONLY] examined\r\n')
                } else if (upper.startsWith('UID SEARCH')) {socket.write('* SEARCH 5\r\n'); ok()}
                else if (upper.startsWith('UID FETCH')) {
                    socket.write('* 1 FETCH (UID 5 FLAGS () INTERNALDATE "09-Nov-2026 10:00:00 +0800" RFC822.SIZE 400 ENVELOPE ' + envelope + ' BODYSTRUCTURE ' + structure)
                    for (const part of command.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)) {
                        const name = part[1].toUpperCase(), start = Number(part[2] ?? 0), length = Number(part[3] ?? 65536)
                        const content = name.includes('HEADER') || name.includes('MIME') ? mime : Buffer.from(encoded)
                        const sliced = content.subarray(start, start + length)
                        socket.write(' BODY[' + name + ']' + (part[2] ? '<' + start + '>' : '') + ' {' + sliced.length + '}\r\n')
                        socket.write(sliced)
                    }
                    socket.write(')\r\n'); ok()
                } else if (upper.startsWith('LOGOUT')) {socket.write('* BYE\r\n'); ok(); socket.end()}
                else if (upper.startsWith('NOOP')) ok()
                else socket.write(tag + ' BAD unsupported fixture command\r\n')
            }
        })
    })
    t.after(() => {for (const socket of sockets) socket.destroy(); server.close()})
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as {port: number}).port
    const transport = createMailTransport(options => new ImapFlow({...options, tls: {...options.tls, ca: cert}}))
    const session = await transport({address: 'student@example.com', username: 'student', password: 'fixture',
        host: 'localhost', port, security: 'tls', enabled: true}, AbortSignal.timeout(15000))
    try {
        assert.equal(session.uidValidity, '77')
        assert.deepEqual(await session.search({from: '2026-10-11', to: '2026-11-09'}), [5])
        const message = await session.message(5)
        assert.equal(message?.envelope?.subject, '中文主题')
        assert.equal((await session.text(message!, 32768)).text, '中文正文')
        assert.equal((await session.message(5))?.flags?.has('\\Seen'), false)
        assert.ok(commands.some(command => command.startsWith('EXAMINE')))
        assert.ok(commands.some(command => command.includes('BODY.PEEK[')))
        assert.equal(commands.some(command => /^(SELECT|STORE|UID STORE|APPEND|EXPUNGE|MOVE|UID MOVE)\b/.test(command)), false)
    } finally {session.close()}
})
