import {useEffect, useRef, useState, type ChangeEvent, type FormEvent} from 'react'
import type {MailAccount, MailDraft, MailUpload, MailSendResult} from '../../shared/mail'
import {validateMailDraft, mailUploadBytes} from '../../shared/mail'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'

export function MailComposer({initial, accounts, onClose, onSent, onDraftChange, onViewSent}: {
    initial: MailDraft; accounts: MailAccount[]; onClose: () => void; onSent: (result: MailSendResult) => void
    onDraftChange: () => void; onViewSent: () => void
}) {
    const [draft, setDraft] = useState(initial), [version, setVersion] = useState(0), [status, setStatus] = useState(initial.sendState ? '发送状态待确认' : initial.updatedAt ? '草稿已保存' : '')
    const [error, setError] = useState(''), [sending, setSending] = useState(false), [closing, setClosing] = useState(false)
    const [unknown, setUnknown] = useState(initial.sendState === 'unknown'), [ccVisible, setCcVisible] = useState(!!initial.cc || !!initial.bcc)
    const [confirmEmpty, setConfirmEmpty] = useState(false), [discarding, setDiscarding] = useState(false), [adding, setAdding] = useState(false), [resolving, setResolving] = useState(false)
    const dialog = useRef<HTMLDialogElement>(null), toField = useRef<HTMLInputElement>(null), bodyField = useRef<HTMLTextAreaElement>(null)
    const current = useRef({draft, version}), mounted = useRef(true), queue = useRef<Promise<void>>(Promise.resolve())
    const savedVersion = useRef(initial.updatedAt ? 0 : -1), requestId = useRef(initial.sendRequestId ?? crypto.randomUUID().replace(/-/g, ''))
    current.current = {draft, version}
    const sender = accounts.find(account => account.id === draft.accountId)
    useEffect(() => {
        mounted.current = true
        const element = dialog.current!, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal(); (initial.to ? bodyField.current : toField.current)?.focus()
        return () => {mounted.current = false; void persist().catch(() => {}); element.close(); trigger?.focus({preventScroll: true})}
    }, [])
    function change(value: Partial<MailDraft>) {
        if (unknown || sending || closing) return
        setDraft(before => ({...before, ...value})); setVersion(before => before + 1); setError(''); setStatus('尚未保存')
        requestId.current = crypto.randomUUID().replace(/-/g, '')
    }
    function hasContent(value: MailDraft) {return !!(value.to || value.cc || value.bcc || value.subject || value.body.trim() || value.attachments.length)}
    async function persist() {
        const snapshot = current.current
        if (!window.mail || savedVersion.current === snapshot.version || (!hasContent(snapshot.draft) && savedVersion.current < 0)) return
        let failure: Error | undefined
        queue.current = queue.current.catch(() => {}).then(async () => {
            if (savedVersion.current >= snapshot.version) return
            if (mounted.current) setStatus('正在保存草稿…')
            try {
                const result = await window.mail!.saveDraft(snapshot.draft)
                if (!result.ok) throw new Error(result.error)
                savedVersion.current = snapshot.version; onDraftChange()
                if (mounted.current && current.current.version === snapshot.version) setStatus('草稿已保存')
            } catch (reason) {
                failure = reason instanceof Error ? reason : new Error('草稿保存失败，请重试。')
                if (mounted.current) {setStatus('草稿未保存'); setError(failure.message)}
            }
        })
        await queue.current
        if (failure) throw failure
    }
    useEffect(() => {
        if (closing || sending || unknown || (!hasContent(draft) && savedVersion.current < 0)) return
        const timer = setTimeout(() => {void persist().catch(() => {})}, 1000)
        return () => clearTimeout(timer)
    }, [version, closing, sending, unknown])
    async function close() {
        if (sending || closing || adding) return
        setClosing(true)
        try {await persist(); await queue.current; onClose()}
        catch {} finally {if (mounted.current) setClosing(false)}
    }
    async function discard() {
        if (!window.mail) return
        setClosing(true); setDiscarding(false)
        try {
            await queue.current.catch(() => {})
            const result = await window.mail.deleteDraft(draft.id)
            if (!result.ok) throw new Error(result.error)
            onDraftChange(); onClose()
        } catch (reason) {setError(reason instanceof Error ? reason.message : '未能删除草稿。'); setClosing(false)}
    }
    async function release() {
        if (!window.mail || sending || closing) return
        setClosing(true); setResolving(false); setError('')
        try {
            const result = await window.mail.releaseDraft(draft.id)
            if (!result.ok) throw new Error(result.error)
            setDraft(result.data); current.current.draft = result.data; setUnknown(false)
            requestId.current = crypto.randomUUID().replace(/-/g, ''); setStatus('草稿已保存'); onDraftChange()
        } catch (reason) {setError(reason instanceof Error ? reason.message : '无法恢复编辑，请重试。')}
        finally {if (mounted.current) setClosing(false)}
    }
    async function attach(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []); event.target.value = ''
        if (!files.length) return
        if (draft.attachments.length + files.length > 20 || draft.attachments.reduce((sum, item) => sum + mailUploadBytes(item.data), 0) + files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {setError('每封邮件最多 20 个附件，总大小不超过 20 MB。'); return}
        setAdding(true)
        try {
            const uploads = await Promise.all(files.map(file => new Promise<MailUpload>((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve({name: file.name.replace(/[\x00-\x1f\/\\]/g, '_').slice(0, 255), type: file.type || 'application/octet-stream', data: String(reader.result).split(',')[1] ?? ''})
                reader.onerror = () => reject(new Error('无法读取附件，请重新选择。')); reader.readAsDataURL(file)
            })))
            if (mounted.current) change({attachments: [...current.current.draft.attachments, ...uploads]})
        } catch (reason) {setError(reason instanceof Error ? reason.message : '添加附件失败。')} finally {setAdding(false)}
    }
    async function syncSendState() {
        const result = await window.mail?.draft(current.current.draft.id)
        if (!mounted.current || !result?.ok || !result.data.sendState) return false
        setDraft(result.data); current.current.draft = result.data; setUnknown(true); setStatus('发送状态待确认')
        requestId.current = result.data.sendRequestId!; onDraftChange(); return true
    }
    async function send(confirmed = false) {
        if (!window.mail || sending || closing || adding || unknown) return
        if (!sender?.smtp) {setError('这个账号尚未配置发信服务器，请在邮箱设置中补充 SMTP。'); return}
        const checked = validateMailDraft(draft)
        if (!checked.ok) {setError(checked.error); return}
        if (!draft.to.trim()) {setError('请填写收件人。'); toField.current?.focus(); return}
        if (!draft.subject.trim() && !confirmed) {setConfirmEmpty(true); return}
        setSending(true); setConfirmEmpty(false); setError('')
        try {
            await persist(); await queue.current
            const result = await window.mail.send({draft: current.current.draft, requestId: requestId.current})
            if (!mounted.current) return
            if (!result.ok) {await syncSendState(); setError(result.error); return}
            if (result.data.status === 'unknown') {
                const retained: MailDraft = {...current.current.draft, sendState: 'unknown', sendRequestId: requestId.current}
                setDraft(retained); current.current.draft = retained; setUnknown(true); setError(result.data.message); setStatus('发送状态待确认')

            }
            else {onDraftChange(); onSent(result.data); onClose()}
        } catch (reason) {if (mounted.current) {await syncSendState().catch(() => false); setError(reason instanceof Error ? reason.message : '发送失败，草稿已保留。')}}
        finally {if (mounted.current) setSending(false)}
    }
    const unavailable = sending || closing || unknown
    return <dialog ref={dialog} className="calendar-dialog mail-compose-dialog" aria-labelledby="mail-compose-title"
        onCancel={event => {event.preventDefault(); void close()}}>
        <header className="mail-compose-heading"><div><h3 id="mail-compose-title">写邮件</h3><span role="status">{status}</span></div>
            <button type="button" className="icon-button" title="保存草稿并关闭" aria-label="保存草稿并关闭" disabled={sending || closing || adding} onClick={() => void close()}><Icon name="close"/></button></header>
        <form noValidate onKeyDown={event => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
        }} onSubmit={(event: FormEvent) => {event.preventDefault(); void send()}}>
            <fieldset disabled={unavailable} className="mail-compose-fields">
                <div className="mail-compose-line"><label htmlFor="mail-from">发件人</label><select id="mail-from" value={draft.accountId} onChange={event => change({accountId: event.target.value})}>
                    {!sender && <option value={draft.accountId}>原发件账号已移除，请重新选择</option>}{accounts.map(account => <option key={account.id} value={account.id}>{account.label} &lt;{account.address}&gt;{account.smtp ? '' : '（仅收信）'}</option>)}</select></div>
                <div className="mail-compose-line"><label htmlFor="mail-to">收件人</label><input ref={toField} id="mail-to" value={draft.to} autoComplete="off" placeholder="邮箱地址，多个地址用逗号分隔" onChange={event => change({to: event.target.value})}/>
                    <button type="button" className="mail-text-button" aria-expanded={ccVisible} onClick={() => setCcVisible(!ccVisible)}>抄送 / 密送</button></div>
                {ccVisible && <><div className="mail-compose-line"><label htmlFor="mail-cc">抄送</label><input id="mail-cc" value={draft.cc} placeholder="可选" onChange={event => change({cc: event.target.value})}/></div>
                    <div className="mail-compose-line"><label htmlFor="mail-bcc">密送</label><input id="mail-bcc" value={draft.bcc} placeholder="可选，其他收件人不可见" onChange={event => change({bcc: event.target.value})}/></div></>}
                <div className="mail-compose-line"><label htmlFor="mail-subject">主题</label><input id="mail-subject" value={draft.subject} maxLength={998} placeholder="邮件主题" onChange={event => change({subject: event.target.value})}/></div>
                <label className="sr-only" htmlFor="mail-compose-body">正文</label><textarea ref={bodyField} id="mail-compose-body" value={draft.body} placeholder="写点什么…" maxLength={1000000} onChange={event => change({body: event.target.value})}/>
                {draft.attachments.length > 0 && <ul className="mail-compose-attachments">{draft.attachments.map((attachment, index) => <li key={index}><Icon name="attachment"/><span>{attachment.name}</span>
                    <button type="button" className="icon-button" aria-label={'移除附件 ' + attachment.name} title="移除附件" onClick={() => change({attachments: draft.attachments.filter((_item, i) => i !== index)})}><Icon name="close"/></button></li>)}</ul>}
            </fieldset>
            {error && <p className="mail-compose-error account-error" role="alert">{error}</p>}
            {unknown && !error && <p className="mail-compose-error" role="status">上次发送结果尚未确认。请先查看已发送邮件，避免重复发送。</p>}
            <footer className="mail-compose-footer"><div><button type="submit" className="primary-button" disabled={unavailable || adding || !sender?.smtp}><Icon name="send"/>{sending ? '正在发送…' : unknown ? '状态待确认' : '发送'}</button>
                <label className={'mail-attach-button secondary-button' + (unavailable || adding ? ' is-disabled' : '')}><Icon name="attachment"/>{adding ? '正在添加…' : '附件'}<input type="file" multiple disabled={unavailable || adding} onChange={event => void attach(event)}/></label></div>
                {unknown ? <div className="mail-compose-recovery"><button type="button" className="mail-text-button" disabled={closing} onClick={() => setResolving(true)}>已确认未发送，继续编辑</button><button type="button" className="mail-text-button" onClick={() => {onClose(); onViewSent()}}>查看已发送</button></div> : <button type="button" className="icon-button" title="删除草稿" aria-label="删除草稿" disabled={unavailable || adding} onClick={() => setDiscarding(true)}><Icon name="trash"/></button>}</footer>
            {!sender?.smtp && <p className="mail-field-hint mail-compose-config-note">发件账号未配置 SMTP，可先保存草稿，再到邮箱设置补充发信信息。</p>}
        </form>
        {confirmEmpty && <ConfirmDialog title="未填写主题，仍要发送？" message={'将从 ' + sender?.address + ' 发送给 ' + draft.to + '。'} confirmLabel="发送" onCancel={() => setConfirmEmpty(false)} onConfirm={() => void send(true)}/>}
        {resolving && <ConfirmDialog title="确认这封邮件没有发出？" message="请先在邮箱中核对已发送邮件，必要时向收件人确认。恢复编辑后再次发送可能造成重复投递。" confirmLabel="确认未发送，恢复编辑" onCancel={() => setResolving(false)} onConfirm={() => void release()}/>}
        {discarding && <ConfirmDialog title="删除这封草稿？" message="草稿和已添加的附件将从本机删除。" confirmLabel="删除草稿" danger onCancel={() => setDiscarding(false)} onConfirm={() => void discard()}/>}
    </dialog>
}
