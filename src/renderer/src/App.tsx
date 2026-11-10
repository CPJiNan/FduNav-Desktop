import {type KeyboardEvent, useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'
import {WindowTitlebar} from './WindowTitlebar'
import {AccountPanel} from './AccountPanel'
import {NoticesPage} from './NoticesPage'
import {CalendarPage} from './CalendarPage'
import {TodosPage} from './TodosPage'
import {MessagePreferencesPanel} from './MessagePreferencesPanel'
import {SourcesPanel} from './SourcesPanel'
import {LlmPanel} from './LlmPanel'
import {GeneralPanel} from './GeneralPanel'
import {NotificationSettingsPanel} from './NotificationSettingsPanel'
import {SummaryQueuePanel} from './SummaryQueuePanel'
import {AboutPanel} from './AboutPanel'
import {CommunityPanel} from './CommunityPanel'
import {DashboardPage} from './DashboardPage'
import {ChatPage} from './ChatPage'
import {DantaPage} from './DantaPage'
import {CoursesPage} from './CoursesPage'
import type {Notice} from '../../shared/notices'
import type {CalendarView} from '../../shared/calendar'
import type {AccountState} from '../../shared/accounts'
import {type MessagePreferences, validateRequiredMessagePreferences} from '../../shared/message-preferences'
import './styles/app.css'

const tabs = [
    {id: 'general', label: '通用', icon: 'settings'},
    {id: 'notifications', label: '通知', icon: 'notices'},
    {id: 'account', label: '账号', icon: 'user'},
    {id: 'community', label: '社区', icon: 'compass'},
    {id: 'messages', label: '消息偏好', icon: 'tag'},
    {id: 'sources', label: '消息来源', icon: 'folder'},
    {id: 'llm', label: 'LLM', icon: 'processor'},
    {id: 'about', label: '关于', icon: 'info'},
] as const
type Tab = typeof tabs[number]['id']
const noticesNavigation = {label: '通知', icon: 'notices'} as const
const calendarNavigation = {label: '日历', icon: 'calendar'} as const
const dantaNavigation = {label: '树洞', icon: 'compass'} as const
const coursesNavigation = {label: '课评', icon: 'book'} as const
type Page = 'dashboard' | 'notices' | 'chat' | 'calendar' | 'todos' | 'danta' | 'courses'

export default function App() {
    const [settings, setSettings] = useState(false)
    const [page, setPage] = useState<Page>('dashboard')
    const [noticeToOpen, setNoticeToOpen] = useState<Notice | null>(null)
    const [calendarInitialView, setCalendarInitialView] = useState<CalendarView>('week')
    const [tab, setTab] = useState<Tab>('general')
    const [account, setAccount] = useState<AccountState | null>(null)
    const [unreadState, setUnreadState] = useState<{ username: string | null; unread: boolean }>({
        username: null,
        unread: false
    })
    const hasUnread = account?.status === 'signed-in' && unreadState.username === account.username && unreadState.unread
    const [accountLoaded, setAccountLoaded] = useState(!window.accounts)
    const [preferences, setPreferences] = useState<MessagePreferences | null>(null)
    const needsLogin = !!window.accounts && accountLoaded && account?.status !== 'signed-in'
    const needsPreferences = account?.status === 'signed-in' && !validateRequiredMessagePreferences(preferences).ok
    const needsSetup = needsLogin || needsPreferences
    const showSettings = settings || needsSetup
    const showNoticesPage = !showSettings && page === 'notices'
    const showCalendarPage = !showSettings && page === 'calendar'
    const showTodosPage = !showSettings && page === 'todos'
    const showDashboardPage = !showSettings && page === 'dashboard'
    const showChatPage = !showSettings && page === 'chat'
    const showDantaPage = !showSettings && page === 'danta'
    const showCoursesPage = !showSettings && page === 'courses'
    const settingsButton = useRef<HTMLButtonElement>(null)
    const settingsWasOpen = useRef(false)

    useEffect(() => {
        let active = true
        void window.accounts?.getState().then(result => {
            if (active && result.ok) setAccount(result.data)
        }).catch(() => {
            if (active) {
                setSettings(true);
                setTab('account')
            }
        }).finally(() => {
            if (active) setAccountLoaded(true)
        })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        if (needsLogin) setTab('account')
        else if (needsPreferences) setTab('messages')
    }, [needsLogin, needsPreferences, account?.username])

    useEffect(() => {
        const api = window.notices
        if (!api || account?.status !== 'signed-in') return
        let active = true
        let changed = false
        const unsubscribe = api.onUnreadChanged(state => {
            changed = true
            if (active) setUnreadState(state)
        })
        void api.unreadState().then(result => {
            if (active && !changed && result.ok) setUnreadState(result.data)
        }).catch(() => {
        })
        return () => {
            active = false
            unsubscribe()
        }
    }, [account?.status, account?.username])

    useEffect(() => {
        if (showSettings) document.getElementById(`settings-tab-${tab}`)?.focus()
        else if (settingsWasOpen.current) settingsButton.current?.focus()
        settingsWasOpen.current = showSettings
    }, [showSettings, tab])

    useEffect(() => {
        function onKey(event: globalThis.KeyboardEvent) {
            if (event.key === 'Escape' && !needsSetup) setSettings(false)
        }

        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [needsSetup])

    function openPage(next: Page, calendarView: CalendarView = 'week') {
        if (next === 'calendar') setCalendarInitialView(calendarView)
        setPage(next)
        if (needsLogin) {
            setTab('account')
            setSettings(true)
        } else if (needsPreferences) setTab('messages')
        else setSettings(false)
    }

    function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        if (needsSetup) return
        const offsets: Record<string, number> = {ArrowDown: 1, ArrowUp: -1, Home: -index, End: tabs.length - 1 - index}
        if (!(event.key in offsets)) return
        event.preventDefault()
        const next = tabs[(index + offsets[event.key] + tabs.length) % tabs.length].id
        setTab(next);
        document.getElementById(`settings-tab-${next}`)?.focus()
    }

    return <><WindowTitlebar/>
        <div className="app-shell">
            <nav className="app-rail" aria-label="应用导航">
                <button type="button" className={`icon-button rail-button ${showDashboardPage ? 'is-active' : ''}`}
                        aria-label="仪表盘" title="仪表盘" aria-current={showDashboardPage ? 'page' : undefined}
                        onClick={() => openPage('dashboard')}><Icon name="dashboard"/></button>
                <button type="button" className={`icon-button rail-button ${showNoticesPage ? 'is-active' : ''}`}
                        aria-label={hasUnread ? '通知，有未读消息' : noticesNavigation.label}
                        title={hasUnread ? '通知（有未读消息）' : noticesNavigation.label}
                        aria-current={showNoticesPage ? 'page' : undefined}
                        onClick={() => openPage('notices')}>
                    <span className="rail-notice-icon"><Icon name={noticesNavigation.icon}/>
                        {hasUnread && <span className="rail-unread-dot" aria-hidden="true"/>}
                    </span>
                </button>
                <button type="button" className={`icon-button rail-button ${showChatPage ? 'is-active' : ''}`}
                        aria-label="聊天" title="聊天" aria-current={showChatPage ? 'page' : undefined}
                        onClick={() => openPage('chat')}><Icon name="chat"/></button>
                <button type="button" className={`icon-button rail-button ${showDantaPage ? 'is-active' : ''}`}
                        aria-label={dantaNavigation.label} title={dantaNavigation.label}
                        aria-current={showDantaPage ? 'page' : undefined}
                        onClick={() => openPage('danta')}><Icon name={dantaNavigation.icon}/></button>
                <button type="button" className={`icon-button rail-button ${showCoursesPage ? 'is-active' : ''}`}
                        aria-label={coursesNavigation.label} title={coursesNavigation.label}
                        aria-current={showCoursesPage ? 'page' : undefined}
                        onClick={() => openPage('courses')}><Icon name={coursesNavigation.icon}/></button>
                <button type="button" className={`icon-button rail-button ${showCalendarPage ? 'is-active' : ''}`}
                        aria-label={calendarNavigation.label}
                        title={calendarNavigation.label} aria-current={showCalendarPage ? 'page' : undefined}
                        onClick={() => openPage('calendar')}><Icon name={calendarNavigation.icon}/></button>
                <button type="button" className={`icon-button rail-button ${showTodosPage ? 'is-active' : ''}`}
                        aria-label="待办" title="待办" aria-current={showTodosPage ? 'page' : undefined}
                        onClick={() => openPage('todos')}><Icon name="todo"/></button>
                <div className="rail-bottom">
                    <SummaryQueuePanel username={account?.username} onOpenNotice={async ref => {
                        const result = await window.notices?.getNotice(ref)
                        if (!result) throw new Error('通知服务不可用。')
                        if (!result.ok) throw new Error(result.error)
                        setNoticeToOpen(result.data)
                        setPage('notices')
                        setSettings(false)
                    }}/>
                    <button type="button" ref={settingsButton}
                            className={`icon-button rail-button ${showSettings ? 'is-active' : ''}`}
                            aria-label="设置" title="设置" aria-current={showSettings ? 'page' : undefined}
                            onClick={() => setSettings(true)}><Icon name="settings"/></button>
                </div>
            </nav>

            <div className="workspace-shell">
                <div className="main-shell">
                    <main className="main-content">
                        <div className="settings-page" hidden={!showSettings}>
                            <div className="settings-layout">
                                <div className="settings-tabs" role="tablist" aria-label="设置分类"
                                     aria-orientation="vertical">
                                    {tabs.map((item, index) => <button type="button" key={item.id}
                                                                       id={`settings-tab-${item.id}`}
                                                                       role="tab" aria-selected={tab === item.id}
                                                                       aria-controls={`settings-panel-${item.id}`}
                                                                       tabIndex={tab === item.id ? 0 : -1}
                                                                       disabled={needsLogin ? item.id !== 'account' && item.id !== 'about'
                                                                           : needsPreferences && item.id !== 'messages' && item.id !== 'account' && item.id !== 'about'}
                                                                       onKeyDown={event => tabKey(event, index)}
                                                                       onClick={() => setTab(item.id)}
                                                                       className={`settings-tab ${tab === item.id ? 'is-active' : ''}`}>
                                        <Icon name={item.icon}/><span>{item.label}</span></button>)}
                                </div>
                                <section className="settings-panel" role="tabpanel" id={`settings-panel-${tab}`}
                                         aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
                                    {tab === 'general' && showSettings && <GeneralPanel/>}
                                    {tab === 'notifications' && showSettings && <NotificationSettingsPanel/>}
                                    {tab === 'account' && <AccountPanel account={account} onChange={setAccount}/>}
                                    {tab === 'community' && <CommunityPanel/>}
                                    {tab === 'about' && <AboutPanel/>}
                                    <div hidden={tab !== 'messages'}><MessagePreferencesPanel
                                        key={account?.status === 'signed-in' ? account.username : 'signed-out'}
                                        requiredProfile={account?.status === 'signed-in'}
                                        onChange={setPreferences} onSaved={value => {
                                        if (needsPreferences && validateRequiredMessagePreferences(value).ok) setSettings(false)
                                    }}/></div>
                                    <div hidden={tab !== 'sources'}><SourcesPanel
                                        active={showSettings && tab === 'sources'}/></div>
                                    <div hidden={tab !== 'llm'}><LlmPanel key={account?.username} active={settings && tab === 'llm'}/></div>
                                </section>
                            </div>
                        </div>
                        {showDashboardPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <DashboardPage key={`${account?.username}-${preferences?.educationLevel}`}
                                           onNavigate={openPage}
                                           onOpenNotice={notice => {
                                               setNoticeToOpen(notice);
                                               openPage('notices')
                                           }}/>}
                        {showNoticesPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <NoticesPage key={account?.username} noticeToOpen={noticeToOpen}
                                         onNoticeOpened={() => setNoticeToOpen(null)}
                                         onLogin={() => {
                                             setTab('account');
                                             setSettings(true)
                                         }}/>}
                        {showChatPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <ChatPage key={account?.username} username={account?.username ?? ''}
                                      onOpenNotice={notice => {
                                          setNoticeToOpen(notice);
                                          openPage('notices')
                                      }}
                                      onSettings={() => {
                                          setTab('llm');
                                          setSettings(true)
                                      }}/>}
                        {showCalendarPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <CalendarPage key={`${account?.username}-${preferences?.educationLevel}`}
                                          initialView={calendarInitialView}/>}
                        {showTodosPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <TodosPage key={account?.username}/>}
                        {showDantaPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <DantaPage onSettings={() => {
                                setTab('community');
                                setSettings(true)
                            }}/>}
                        {showCoursesPage && accountLoaded && (!window.accounts || account?.status === 'signed-in') &&
                            <CoursesPage onSettings={() => {
                                setTab('community');
                                setSettings(true)
                            }}/>}
                    </main>
                </div>
            </div>
        </div>
    </>
}
