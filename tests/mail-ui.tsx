/** Disposable IPC fixtures; no real credentials or mailbox data. */
import {StrictMode, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MailPanel} from '../src/renderer/src/MailPanel'
import {emptyMailSettings, fudanStudentMail, type MailSettings} from '../src/shared/mail'
import '../src/renderer/src/styles/base.css'
import '../src/renderer/src/styles/app.css'
import '../src/renderer/src/styles/calendar.css'
import './mail-ui.css'

const params = new URLSearchParams(location.search)
let settings: MailSettings = params.has('connected') ? {...emptyMailSettings(), configured: true, enabled: true,
    address: 'student@' + fudanStudentMail.domain, username: 'student@' + fudanStudentMail.domain, host: fudanStudentMail.host,
    lastVerifiedAt: '2026-11-09T08:00:00Z'} : emptyMailSettings()
const ok = <T,>(data: T) => Promise.resolve({ok: true as const, data: structuredClone(data)})
const fail = (error: string) => Promise.resolve({ok: false as const, error})
let operation: AbortController | null = null
async function waitOperation() {
    operation = new AbortController()
    const signal = operation.signal
    await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, params.has('slow') ? 10000 : 250)
        signal.addEventListener('abort', () => {clearTimeout(timer); resolve()}, {once: true})
    })
    return !signal.aborted
}
window.mail = {
    get: () => params.has('loadError') ? fail('无法读取本机连接设置，请重试。') : ok(settings),
    test: async () => {
        if (!await waitOperation()) return fail('连接测试已停止。设置未保存。')
        return params.has('authError') ? fail('邮箱登录失败。请确认已开启 IMAP，并使用邮箱密码或客户端专用密码。')
            : ok({message: '连接成功，可以读取收件箱。测试不会保存设置或读取邮件正文。'})
    },
    save: async value => {
        if (!await waitOperation()) return fail('连接操作已停止。设置未保存。')
        if (params.has('authError')) return fail('邮箱登录失败。请确认已开启 IMAP，并使用邮箱密码或客户端专用密码。')
        const {password: _password, ...connection} = value
        settings = {...connection, configured: true, lastVerifiedAt: new Date().toISOString()}; return ok(settings)
    },
    cancelSetup: () => {operation?.abort(); return ok(null)},
    setEnabled: enabled => {settings.enabled = enabled; return ok(settings)},
    disconnect: () => {settings = emptyMailSettings(); return ok(settings)},
    openWebmail: () => ok(null),
}
function Preview() {
    const [dark, setDark] = useState(false), [chat, setChat] = useState(false)
    return <div className="mail-fixture"><header className="mail-fixture-header"><strong>FduNav · 邮箱界面预览</strong>
        <span>模拟数据</span><button className="secondary-button" onClick={() => {setDark(!dark); document.documentElement.dataset.theme = dark ? 'light' : 'dark'}}>切换主题</button></header>
        <div className="mail-fixture-layout"><aside><span>设置</span><span>通用</span><span>账号</span><span>LLM</span><strong>邮箱</strong></aside>
            <main><MailPanel active campusUsername="student" onOpenChat={() => setChat(true)}/>
                {chat && <p role="status">已前往对话（预览）</p>}</main></div></div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Preview/></StrictMode>)
