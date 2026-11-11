import {type FormEvent, type ReactNode, useEffect, useRef, useState} from 'react'
import type {CommunityTransportIssue, DantaStatus} from '../../shared/danta'
import {Icon} from './Icon'
import './styles/community.css'

type Phase = '' | 'connect' | 'check' | 'login' | 'logout' | 'agent'
/** 单步的视觉语义：idle 未开始、busy 进行中、done 完成、warn 需要用户处理、error 失败。 */
type Tone = 'idle' | 'busy' | 'done' | 'warn' | 'error'
type Outcome = {ok: true; data: DantaStatus} | {ok: false; error: string}

const schoolLabels: Record<DantaStatus['school'], string> = {
    unknown: '尚未检测', checking: '检测中', ready: '已连接', 'login-required': '需要登录', unavailable: '不可用',
}
const accountLabels: Record<DantaStatus['account'], string> = {
    'signed-out': '未连接', connected: '已连接', expired: '已失效',
}

/** 直连失败的原因翻成人话：用户需要知道该关网关、换网络，还是等一会儿再试。 */
const issueHints: Record<CommunityTransportIssue, string> = {
    gateway: '直连请求被安全网关拦截（类似 iOA 的“目标站点异常”），需要在网关客户端里放行或断开该通路',
    tls: 'TLS 握手被中途打断，通常由代理或安全软件接管连接导致',
    timeout: '连接超时，旦挞或中间网关一直没有响应',
    network: '无法解析或无法建立连接，请检查网络设置',
}

/** 流动省略号：比静态“…”更能说明“还在等”，纯 CSS 播放，尊重减少动效偏好。 */
function Dots() {
    return <span className="community-dots" aria-hidden="true"><i/><i/><i/></span>
}

function Spin() {
    return <span className="community-spin" aria-hidden="true"/>
}

function State({tone, children}: {tone: Tone; children: ReactNode}) {
    return <span className={`community-state is-${tone}`}>{children}</span>
}

function Step({index, title, desc, tone, state, foot}: {
    index: number
    title: string
    desc: ReactNode
    tone: Tone
    state: ReactNode
    foot?: ReactNode
}) {
    return <li className={`community-step is-${tone}`}>
        {tone === 'busy' && <span className="community-step-sweep" aria-hidden="true"/>}
        <span className="community-step-rail" aria-hidden="true">
            {tone === 'busy' ? <Spin/>
                : tone === 'done' ? <Icon name="check"/>
                    : tone === 'error' ? '!'
                        : tone === 'warn' ? '!'
                            : index}
        </span>
        <div className="community-step-body">
            <div className="community-step-head">
                <span className="community-step-title">{title}</span>
                <State tone={tone}>{state}</State>
            </div>
            <p className="community-step-desc">{desc}</p>
            {foot}
        </div>
    </li>
}

/**
 * 学校 WebVPN 与旦挞社区账号是两套独立认证：学校网络只负责通路，社区账号才决定能否读树洞和课评。
 * 连接是异步的（打开窗口 → 用户登录 → 自动探测），所以状态必须自己轮询，不能只在点击后取一次。
 */
export function CommunityPanel() {
    const [status, setStatus] = useState<DantaStatus | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [phase, setPhase] = useState<Phase>('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [waited, setWaited] = useState(0)
    const alive = useRef(true)
    const api = window.danta

    useEffect(() => {
        alive.current = true
        if (!api) {
            setLoaded(true)
            return
        }
        void api.status().then(result => {
            if (!alive.current) return
            if (result.ok) setStatus(result.data)
            else setError(result.error)
        }).catch(() => {
            if (alive.current) setError('无法读取校园社区状态。')
        }).finally(() => {
            if (alive.current) setLoaded(true)
        })
        return () => {
            alive.current = false
        }
    }, [api])

    // 首次打开面板时自动探测一次：能直连旦挞就跳过学校网络这一步，不必让用户先点一次按钮。
    const autoProbed = useRef(false)
    useEffect(() => {
        if (!api || !loaded || !status || autoProbed.current) return
        if (status.school !== 'unknown' && status.school !== 'unavailable') return
        autoProbed.current = true
        void run('check', () => api.checkSchool())
    }, [api, loaded, status])

    // 登录窗口开着时主进程状态会自行变化（用户登录成功 → 自动探测通过 → 窗口关闭），
    // 渲染层只能靠轮询跟上；waitingLogin 由主进程给出，窗口一关就停止。
    const waiting = status?.waitingLogin === true
    useEffect(() => {
        if (!api || !waiting) return
        setWaited(0)
        const refresh = setInterval(() => {
            void api.status().then(result => {
                if (alive.current && result.ok) setStatus(result.data)
            }).catch(() => {
            })
        }, 1200)
        const clock = setInterval(() => setWaited(value => value + 1), 1000)
        return () => {
            clearInterval(refresh)
            clearInterval(clock)
        }
    }, [api, waiting])

    async function run(next: Phase, action: () => Promise<Outcome>) {
        if (phase) return
        setPhase(next)
        setError('')
        try {
            const result = await action()
            if (!alive.current) return
            if (result.ok) setStatus(result.data)
            else setError(result.error)
        } catch {
            if (alive.current) setError('无法连接社区服务，请重启应用后重试。')
        } finally {
            if (alive.current) {
                setPhase('')
                void api?.status().then(result => {
                    if (alive.current && result.ok) setStatus(result.data)
                }).catch(() => {
                })
            }
        }
    }

    function login(event: FormEvent) {
        event.preventDefault()
        if (!api || phase) return
        const input = {email: email.trim(), password}
        setPassword('')
        void run('login', () => api.login(input).finally(() => {
            input.password = ''
        }))
    }

    const busy = phase !== ''
    const school = status?.school ?? 'unknown'
    const account = status?.account ?? 'signed-out'
    const schoolReady = school === 'ready'
    const connected = account === 'connected'
    const ready = schoolReady && connected
    const schoolBusy = phase === 'connect' || phase === 'check' || school === 'checking'
    const transport = status?.transport ?? 'unknown'
    const direct = transport === 'direct'

    const schoolTone: Tone = schoolBusy ? 'busy'
        : school === 'ready' ? 'done'
            : school === 'unavailable' ? 'error'
                : school === 'login-required' ? 'warn' : 'idle'
    const accountTone: Tone = phase === 'login' || phase === 'logout' ? 'busy'
        : connected ? 'done'
            : account === 'expired' ? 'warn' : 'idle'

    const summaryTone: Tone = busy || waiting || school === 'checking' ? 'busy' : ready ? 'done' : 'idle'
    const summaryLabel = phase === 'connect' ? '正在打开登录窗口'
        : waiting ? '等待窗口登录'
            : phase === 'check' || school === 'checking' ? '正在探测网络通路'
                : phase === 'login' ? '正在验证社区账号'
                    : phase === 'logout' ? '正在断开连接'
                        : ready ? '已就绪'
                            : schoolReady ? '等待社区登录' : '未连接'

    // 直连失败的原因单独一行：它决定了用户下一步该关网关还是换网络，不该混进状态描述里被跳过。
    const issue = status?.transportIssue ?? null
    const issueNote = issue && !direct
        ? <p className="community-step-hint">直连失败原因：{issueHints[issue]}。</p>
        : undefined

    // 步骤卡已经说明了常规状态，这里只在“需要用户动手”时才复述服务端原话，避免同一句话出现两次。
    // 步骤卡里已经写了“都不通”和具体原因，这里只在不可用且没有原因可补充时才复述服务端原话。
    const showMessage = school === 'login-required' || account === 'expired' || (school === 'unavailable' && !issueNote)

    const schoolDesc = waiting ? '登录窗口已打开，在窗口里完成认证后会自动检测。'
        : phase === 'check' || school === 'checking'
            ? <>正在探测能否直连旦挞社区<Dots/></>
            : school === 'ready' ? (direct
                ? '当前网络可以直接访问旦挞社区，已经跳过学校 WebVPN 登录。'
                : '直连不通，已改走 WebVPN，社区请求可以转发。')
                : school === 'login-required' ? '直连不通，且 WebVPN 会话已失效，需要重新登录学校网络。'
                    : school === 'unavailable' ? '直连和 WebVPN 都不通，请检查网络或代理设置后重试。'
                        : '会自动探测：能直连旦挞就不用登录学校网络，不通时再走 WebVPN。'

    const accountDesc = phase === 'login' ? <>正在向旦挞校验账号密码<Dots/></>
        : phase === 'logout' ? <>正在清除本地保存的登录凭据<Dots/></>
            : connected ? '账号已连接，可以读取树洞与课评。'
                : account === 'expired' ? '登录凭据已失效，需要重新输入密码。'
                    : '用旦挞账号登录后，才能读取树洞与课评。'

    const schoolState = schoolBusy
        ? <><Spin/>{waiting ? '等待登录' : '探测中'}<Dots/></>
        : school === 'ready' ? (direct ? '直连可用' : 'WebVPN')
            : schoolLabels[school]
    const accountState = phase === 'login' ? <><Spin/>验证中<Dots/></>
        : phase === 'logout' ? <>断开中<Dots/></>
            : accountLabels[account]

    return <div className="community-panel">
        <div className="community-head">
            <div className="community-head-text">
                <h2>校园社区（树洞 / 课评）</h2>
                <p className="community-note">
                    社区数据来自旦挞（FDUHole / Danke），只读。打开面板会自动探测：能直连就不用登录学校网络，直连不通才走 WebVPN。
                </p>
            </div>
            <span className={`community-summary is-${summaryTone}`} role="status" aria-live="polite">
                {summaryTone === 'busy' ? <Spin/> : ready ? <Icon name="check"/> : null}
                {summaryLabel}
            </span>
        </div>
        {!api && <p className="community-error">请在桌面应用中连接社区账号。</p>}
        {!status && !loaded && <div className="community-skeleton" aria-hidden="true"><i/><i/><i/></div>}
        {status && <ol className="community-steps">
            <Step index={1} title="网络通路" desc={schoolDesc} tone={schoolTone} state={schoolState}
                  foot={issueNote}/>
            <Step index={2} title="社区账号" desc={accountDesc} tone={accountTone} state={accountState}
                  foot={connected ? <p className="community-step-meta">
                      {status.email && <span>{status.email}</span>}
                      {status.lastLogin && <span>上次登录 {new Date(status.lastLogin).toLocaleString('zh-CN')}</span>}
                  </p> : undefined}/>
        </ol>}
        {waiting && <div className="community-wait" role="status">
            <span className="community-wait-orb" aria-hidden="true"/>
            <div className="community-wait-text">
                <strong>在学校登录窗口里完成认证<Dots/></strong>
                <p>登录成功后窗口会自动关闭，这里立即更新；已等待 <b>{waited}</b> 秒。关掉窗口则视为取消。</p>
            </div>
        </div>}
        {status?.message && showMessage && <p className="community-message">{status.message}</p>}
        {error && <p className="community-error" role="alert">{error}</p>}
        <div className="community-actions">
            <button type="button" className="secondary-button community-action" data-busy={phase === 'connect'}
                    disabled={busy || !api}
                    onClick={() => api && void run('connect', () => api.connectSchool())}>
                {phase === 'connect' ? <Spin/> : <Icon name="external"/>}
                <span>{waiting ? '回到登录窗口'
                    : schoolReady ? (direct ? '改用学校 WebVPN' : '重新打开学校登录窗口')
                        : '连接学校网络'}</span>
            </button>
            <button type="button" className="secondary-button community-action" data-busy={phase === 'check'}
                    disabled={busy || !api}
                    onClick={() => api && void run('check', () => api.checkSchool())}>
                {phase === 'check' ? <Spin/> : <Icon name="refresh"/>}
                <span>{school === 'ready' ? '重新检测通路' : '检测网络'}</span>
            </button>
            {connected && <button type="button" className="secondary-button community-action community-action-danger" data-busy={phase === 'logout'}
                                  disabled={busy || !api}
                                  onClick={() => api && void run('logout', () => api.logout())}>
                {phase === 'logout' ? <Spin/> : null}
                <span>断开社区账号</span>
            </button>}
        </div>
        {schoolReady && !connected && <form className="community-form" onSubmit={login} aria-busy={phase === 'login'}>
            <p className="community-form-title">{direct
                ? '当前网络可以直连旦挞社区，现在输入社区账号。'
                : '网络通路已就绪，现在输入旦挞社区账号。'}</p>
            <label htmlFor="community-email">社区邮箱</label>
            <input id="community-email" name="email" type="email" autoComplete="username" value={email}
                   onChange={event => setEmail(event.target.value)} placeholder="旦挞注册邮箱" required
                   maxLength={320} disabled={busy}/>
            <label htmlFor="community-password">社区密码</label>
            <input id="community-password" name="password" type="password" autoComplete="current-password"
                   value={password} onChange={event => setPassword(event.target.value)} placeholder="社区账号密码"
                   required maxLength={1024} disabled={busy}/>
            <button type="submit" className="primary-button community-action"
                    disabled={busy || !email.trim() || !password}>
                {phase === 'login' ? <><Spin/>正在验证<Dots/></> : '连接社区账号'}
            </button>
        </form>}
        {status && connected && <label className="community-toggle">
            <input type="checkbox" checked={status.agentEnabled} disabled={busy || !api}
                   onChange={event => api && void run('agent', () => api.setAgentEnabled(event.target.checked))}/>
            <span><strong>允许聊天助手读取树洞与课评</strong>
                <small>开启后，助手可以调用四个只读工具检索帖子、帖子楼层、课程与课评；不包含发帖、回复、投票和写课评。</small></span>
            {phase === 'agent' && <Spin/>}
        </label>}
    </div>
}
