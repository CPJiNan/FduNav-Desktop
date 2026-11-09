import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'
import {Readable} from 'node:stream'
import type {FetchMessageObject, ImapFlow, ImapFlowOptions} from 'imapflow'
import {MailError, MailService} from '../src/main/mail-service.ts'
import {createMailTransport, mailHtmlToText, mailTextParts, type MailTransport} from '../src/main/mail-imap.ts'
import {mailPeriod, validateMailInput, type MailInput} from '../src/shared/mail.ts'
import {chatTools, createChatToolRunner} from '../src/main/chat-tools.ts'
import {toolSuccess} from '../src/shared/agent.ts'
import {AppDatabase} from '../src/main/database.ts'
import {isExternalMailLink, isWebmailNavigation} from '../src/main/mail-web-policy.ts'

const input: MailInput = {address: 'student@example.com', username: 'student@example.com', host: 'imap.example.com',
    port: 993, security: 'tls', password: 'fixture-only-credential', enabled: true}
const message = (uid: number, body = '中文邮件正文') => ({seq: uid, uid, body, flags: new Set<string>(), internalDate: new Date(),
    envelope: {subject: '邮件 ' + uid, from: [{name: '教务处', address: 'office@example.com'}], to: [{address: input.address}], date: new Date()},
} as FetchMessageObject & {body: string})
function fixture() {
    const rows = new Map<string, Uint8Array>(), key = randomBytes(32)
    let owner: string | null = 'student', available = true, validity = '77', connectError: unknown, bodyError = false
    let messages = [message(5), message(4), message(3), message(2), message(1)], opened = 0, closed = 0
    let beforeSearch: ((signal: AbortSignal) => Promise<void>) | undefined
    let beforeEncrypt: (() => Promise<void>) | undefined
    const periods: unknown[] = []
    const db = {getMailConfiguration: (id: string) => rows.get(id) ?? null,
        saveMailConfiguration: (id: string, value: Uint8Array) => {rows.set(id, value)},
        clearMailConfiguration: (id: string) => {rows.delete(id)}}
    const secrets = {available: async () => available,
        encrypt: async (text: string) => {
            await beforeEncrypt?.()
            const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
            return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()])
        }, decrypt: async (raw: Uint8Array) => {
            const value = Buffer.from(raw), decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
            decipher.setAuthTag(value.subarray(-16))
            return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString()
        }}
    const transport: MailTransport = async (connection, signal) => {
        signal.throwIfAborted(); opened++
        assert.equal(connection.password, input.password)
        if (connectError) throw connectError
        return {uidValidity: validity, close: () => {closed++},
            search: async period => {periods.push(period); await beforeSearch?.(signal); return messages.map(item => item.uid)},
            message: async uid => messages.find(item => item.uid === uid) ?? null,
            text: async item => {if (bodyError) throw new Error('body unavailable'); return {text: (item as ReturnType<typeof message>).body, truncated: false}}}
    }
    const service = new MailService(db, secrets, transport, () => owner)
    return {service, rows, periods, setOwner: (v: string | null) => {owner = v}, setAvailable: (v: boolean) => {available = v},
        setValidity: (v: string) => {validity = v}, setMessages: (v: typeof messages) => {messages = v},
        setError: (v: unknown) => {connectError = v}, setBodyError: () => {bodyError = true},
        setSearch: (v: typeof beforeSearch) => {beforeSearch = v}, setEncrypt: (v: typeof beforeEncrypt) => {beforeEncrypt = v},
        counts: () => ({opened, closed})}
}

test('connection validation rejects unsafe hosts, plaintext, malformed accounts and ports', () => {
    assert.equal(validateMailInput(input).ok, true)
    for (const host of ['https://host.example', 'host:993', 'a/b', 'host\r\nLOGIN bad', '-host']) assert.equal(validateMailInput({...input, host}).ok, false)
    for (const patch of [{security: 'none'}, {port: 0}, {port: 3.5}, {password: 'a\nb'}, {address: 'bad'}, {enabled: 'true'}]) assert.equal(validateMailInput({...input, ...patch}).ok, false)
})
test('date defaults are 30 calendar days in Shanghai, and invalid ranges fail', () => {
    const now = new Date('2026-11-09T00:00:00Z')
    assert.deepEqual(mailPeriod({}, now), {from: '2026-10-11', to: '2026-11-09'})
    assert.deepEqual(mailPeriod({days: 1}, now), {from: '2026-11-09', to: '2026-11-09'})
    for (const value of [{from: '2026-02-30', to: '2026-03-01'}, {from: '2026-01-01', to: '2026-01-02', days: 7}, {days: 366}]) assert.throws(() => mailPeriod(value))
})
test('entire saved configuration is encrypted and isolated by campus account', async () => {
    const f = fixture(), saved = await f.service.save({...input})
    assert.equal(saved.configured, true)
    assert.equal(JSON.stringify(saved).includes(input.password), false)
    assert.equal(Buffer.from(f.rows.get('student')!).includes(input.password), false)
    assert.equal(Buffer.from(f.rows.get('student')!).includes(input.address), false)
    const result = await f.service.list('student', {})
    assert.equal(result.items[0].summary, '中文邮件正文')
    assert.equal(result.summaryKind, 'body_excerpt')
    assert.equal(JSON.stringify(result).includes(input.password), false)
    f.setOwner('other'); assert.equal((await f.service.get()).configured, false)
    await assert.rejects(f.service.list('student', {}), /当前校园账号/)
})
test('test does not persist and failed replacement preserves old settings without leaking server errors', async () => {
    const f = fixture(); await f.service.test({...input}); assert.equal(f.rows.size, 0)
    await f.service.save({...input}); const original = f.rows.get('student')
    f.setError(Object.assign(new Error(input.password), {authenticationFailed: true}))
    await assert.rejects(f.service.save({...input, host: 'new.example.com'}), error => error instanceof MailError && /登录失败/.test(error.message) && !error.message.includes(input.password))
    assert.equal(f.rows.get('student'), original)
})
test('saved secrets cannot be silently reused after endpoint or identity changes', async () => {
    const f = fixture(); await f.service.save({...input}); await f.service.test({...input, password: ''})
    for (const patch of [{host: 'other.example.com'}, {port: 143}, {security: 'starttls'}, {username: 'other'}, {address: 'other@example.com'}]) {
        await assert.rejects(f.service.test({...input, password: '', ...patch}), /重新输入密码/)
    }
    assert.equal(f.counts().opened, 2)
})
test('cancelling setup during encryption never commits a replacement connection', {timeout: 3000}, async () => {
    const f = fixture(); await f.service.save({...input})
    const original = f.rows.get('student')
    let started!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => {started = resolve}), held = new Promise<void>(resolve => {release = resolve})
    f.setEncrypt(async () => {started(); await held})
    const saving = f.service.save({...input, host: 'new.example.com'})
    await ready; await f.service.cancelSetup(); release()
    await assert.rejects(saving, /已停止/)
    assert.equal(f.rows.get('student'), original)
    assert.equal((await f.service.get()).host, input.host)
    assert.equal(f.counts().opened, f.counts().closed)
})
test('unavailable OS storage blocks saving before credential transmission', async () => {
    const f = fixture(); f.setAvailable(false)
    await assert.rejects(f.service.save({...input}), /系统安全存储/)
    assert.equal(f.counts().opened, 0); assert.equal(f.rows.size, 0)
})
test('fresh credentials can replace an unreadable old OS-encrypted configuration', async () => {
    const f = fixture(); f.rows.set('student', Buffer.from('unreadable'))
    await assert.rejects(f.service.test({...input, password: ''}), /无法解密/)
    await f.service.save({...input}); assert.equal((await f.service.get()).configured, true)
})
test('cursor pagination survives new arrivals and rejects stale mailbox identity', async () => {
    const f = fixture(); await f.service.save({...input})
    const first = await f.service.list('student', {from: '2026-10-01', to: '2026-11-09', limit: 2})
    assert.deepEqual(first.items.map(item => item.subject), ['邮件 5', '邮件 4'])
    f.setMessages([message(6), message(5), message(4), message(3), message(2), message(1)])
    const next = await f.service.list('student', {cursor: first.nextCursor!, limit: 2})
    assert.deepEqual(next.items.map(item => item.subject), ['邮件 3', '邮件 2']); assert.deepEqual(f.periods[0], f.periods[1])
    await assert.rejects(f.service.list('student', {cursor: first.nextCursor!, days: 7}), /不要更改日期/)
    f.setValidity('88')
    await assert.rejects(f.service.list('student', {cursor: first.nextCursor!}), /收件箱已变化/)
    await assert.rejects(f.service.read('student', {id: first.items[0].id}), /引用已失效/)
})
test('long escaped bodies preserve useful tool responses and correct next offsets', async () => {
    const f = fixture(); f.setMessages([message(1, '"\\'.repeat(10000))]); await f.service.save({...input})
    const listed = await f.service.list('student', {}), body = await f.service.read('student', {id: listed.items[0].id})
    assert.equal(body.hasMore, true); assert.equal(body.nextOffset, body.body.length)
    assert.equal(toolSuccess(body, {calls: 10, rounds: 5}).truncated, false)
    const next = await f.service.read('student', {id: body.id, offset: body.nextOffset!})
    assert.equal(next.offset, body.nextOffset)
    await assert.rejects(f.service.read('student', {id: body.id, offset: 99999}), /偏移超出范围/)
})
test('empty or failed excerpts are explicit, never a fabricated summary', async () => {
    const f = fixture(); f.setMessages([message(1, '')]); await f.service.save({...input})
    const listed = await f.service.list('student', {})
    assert.equal(listed.items[0].summaryStatus, 'no_text')
    assert.match((await f.service.read('student', {id: listed.items[0].id})).note, /图片或附件/)
    f.setBodyError(); assert.equal((await f.service.list('student', {})).items[0].summaryStatus, 'unavailable')
})
test('disabling permission and cancelling a task abort outstanding reads and close sessions', async () => {
    const f = fixture(); await f.service.save({...input})
    let started!: () => void
    const ready = new Promise<void>(resolve => {started = resolve})
    f.setSearch(signal => new Promise((_resolve, reject) => {started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true})}))
    const read = f.service.list('student', {}); await ready; await f.service.setEnabled(false)
    await assert.rejects(read, /设置已变化/); assert.deepEqual(f.counts(), {opened: 2, closed: 2})
    await assert.rejects(f.service.list('student', {}), /读取已关闭/)
    await f.service.setEnabled(true)
    const controller = new AbortController(), another = f.service.list('student', {}, controller.signal)
    await new Promise(resolve => setImmediate(resolve)); controller.abort()
    await assert.rejects(another, /已停止/); assert.equal(f.counts().opened, f.counts().closed)
})
test('account change and disconnect cannot return or reuse old-mailbox data', async () => {
    const f = fixture(); await f.service.save({...input})
    const list = await f.service.list('student', {})
    f.setSearch(async () => {f.setOwner('other')})
    await assert.rejects(f.service.list('student', {}), /账号或邮箱设置已变化/)
    f.setOwner('student'); f.rows.set('other', Buffer.from('untouched')); await f.service.disconnect()
    assert.equal(f.rows.has('student'), false); assert.equal(f.rows.has('other'), true)
    await assert.rejects(f.service.read('student', {id: list.items[0].id}), /邮箱未连接/)
})
test('HTML is converted without executable content, remote-image loading or attachment text', () => {
    const text = mailHtmlToText('<head><title>hidden</title></head><body><script>steal()</script><p>会议通知</p><div>周五<br>两点</div><img src="https://tracker.example"><a href="https://school.example">说明</a></body>')
    assert.match(text, /会议通知\n周五\n两点/); assert.match(text, /说明 \(https:\/\/school.example\)/); assert.doesNotMatch(text, /steal|tracker|hidden/)
    assert.deepEqual(mailTextParts({type: 'multipart/mixed', childNodes: [
        {type: 'multipart/alternative', childNodes: [{type: 'text/plain', part: '1.1'}, {type: 'text/html', part: '1.2'}]},
        {type: 'text/plain', part: '2', disposition: 'attachment'}, {type: 'message/rfc822', childNodes: [{type: 'text/plain', part: '3.1'}]},
    ]}).map(part => part.part), ['1.1'])
})
test('adapter requires verified encryption, EXAMINE and bounded body-part downloads', async () => {
    let options!: ImapFlowOptions
    const calls: unknown[] = []
    const fake = {options: {} as ImapFlowOptions, on: () => {}, connect: async () => {}, close: () => {},
        mailboxOpen: async (...args: unknown[]) => {calls.push(args); return {uidValidity: 77n}},
        fetchOne: async (...args: unknown[]) => {calls.push(args); return {...message(1), bodyStructure: {type: 'text/plain', part: '1'}}},
        download: async (...args: unknown[]) => {calls.push(args); return {content: Readable.from([Buffer.from('中文正文')])}}}
    const transport = createMailTransport(value => {options = value; fake.options = value; return fake as unknown as ImapFlow})
    const session = await transport({...input}, new AbortController().signal)
    assert.equal(options.secure, true); assert.equal(options.tls?.rejectUnauthorized, true); assert.equal(options.logger, false)
    assert.deepEqual(calls[0], ['INBOX', {readOnly: true}])
    assert.equal((await session.text((await session.message(1))!, 8192)).text, '中文正文')
    assert.deepEqual(calls[2], [1, '1', {uid: true, maxBytes: 8192}])
    session.close(); assert.equal((options.auth as {pass: string}).pass, '')
    const starttls = await transport({...input, security: 'starttls', port: 143}, new AbortController().signal)
    assert.equal(options.secure, false); assert.equal(options.doSTARTTLS, true); starttls.close()
})
test('only two mail read tools exist, with proper parameters and cancellation propagation', async () => {
    assert.deepEqual(chatTools.map(item => item.function.name).filter(name => /email|mail|smtp|reply/.test(name)), ['list_emails', 'get_email'])
    const signal = new AbortController().signal, calls: unknown[] = []
    const runner = createChatToolRunner({} as never, 'student', {} as never, () => {}, () => {}, () => {}, () => {}, {
        list: async (...args) => {calls.push(args); return {items: []} as never},
        read: async (...args) => {calls.push(args); return {body: '正文'} as never},
    }, signal)
    assert.deepEqual(await runner('list_emails', '{"days":7}'), {items: []}); assert.equal((calls[0] as unknown[])[2], signal)
    assert.deepEqual(await runner('get_email', '{"id":"mail-id"}'), {body: '正文'})
    await assert.rejects(runner('list_emails', '{"password":"secret"}'), /未知字段/)
    await assert.rejects(runner('get_email', '{}'), /缺失/)
    await assert.rejects(runner('send_email', '{}'), /不支持/)
})
test('SQLite migration stores connection BLOBs per owner', () => {
    const db = new AppDatabase(':memory:')
    db.saveMailConfiguration('one', new Uint8Array([1, 2])); db.saveMailConfiguration('two', new Uint8Array([3]))
    assert.deepEqual([...db.getMailConfiguration('one')!], [1, 2]); db.clearMailConfiguration('one')
    assert.equal(db.getMailConfiguration('one'), null); assert.deepEqual([...db.getMailConfiguration('two')!], [3])
})
test('webmail URL policy rejects local schemes, credential URLs, wrong ports and lookalike domains', () => {
    for (const url of ['https://mail.fudan.edu.cn/coremail/', 'https://uis.fudan.edu.cn/', 'about:blank', 'blob:https://mail.fudan.edu.cn/id']) assert.equal(isWebmailNavigation(url), true)
    for (const url of ['http://mail.fudan.edu.cn/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://mail.fudan.edu.cn.evil.com/', 'https://x:y@mail.fudan.edu.cn/', 'https://mail.fudan.edu.cn:1234/']) assert.equal(isWebmailNavigation(url), false)
    assert.equal(isExternalMailLink('https://example.com/notice'), true); assert.equal(isExternalMailLink('mailto:x@example.com'), false)
})
