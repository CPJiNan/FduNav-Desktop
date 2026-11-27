import {type KeyboardEvent, type ReactNode, useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'
import {WindowTitlebar} from './WindowTitlebar'
import {AccountPanel} from './AccountPanel'
import {NoticesPage} from './NoticesPage'
import {CalendarPage} from './CalendarPage'
import {TodosPage} from './TodosPage'
import {MessagePreferencesPanel} from './MessagePreferencesPanel'
import {SourcesPanel} from './SourcesPanel'
import {LlmPanel} from './LlmPanel'
import {ResearchPanel} from './ResearchPanel'
import {GeneralPanel} from './GeneralPanel'
import {MailPanel} from './MailPanel'
import {MailboxPage} from './MailboxPage'
import {NotificationSettingsPanel} from './NotificationSettingsPanel'
import {SummaryQueuePanel} from './SummaryQueuePanel'
import {AboutPanel} from './AboutPanel'
import {DashboardPage} from './DashboardPage'
import {ChatPage} from './ChatPage'
import {PluginFrame} from './plugins/PluginFrame'
import {PluginPanel} from './plugins/PluginPanel'
import type {PluginRuntime} from './plugins/runtime'
import type {Notice} from '../../shared/notices'
import type {CalendarView} from '../../shared/calendar'
import type {AccountState} from '../../shared/accounts'
import type {MailItem} from '../../shared/mail'
import {type MessagePreferences, validateRequiredMessagePreferences} from '../../shared/message-preferences'
import {
    type BuiltinPage,
    pluginBuiltinPages,
    pluginBuiltinSettings,
    type PluginRoute,
    type PluginView,
    type PluginViewState
} from '../../shared/plugins'
import './styles/app.css'

const tabs = [
    {id: 'general', label: '通用', icon: 'settings'},
    {id: 'notifications', label: '通知', icon: 'notices'},
    {id: 'account', label: '账号', icon: 'user'},
    {id: 'messages', label: '消息偏好', icon: 'tag'},
    {id: 'sources', label: '消息来源', icon: 'folder'},
    {id: 'llm', label: 'LLM', icon: 'processor'},
    {id: 'research', label: '旦挞', icon: 'cup'},
    {id: 'mail', label: '邮箱', icon: 'mail'},
    {id: 'plugins', label: '插件', icon: 'puzzle'},
    {id: 'about', label: '关于', icon: 'info'},
] as const
type Tab = typeof tabs[number]['id']
const noticesNavigation = {label: '通知', icon: 'notices'} as const
const calendarNavigation = {label: '日历', icon: 'calendar'} as const

export default function App({runtime, openPlugins = false, pluginStartupError}: {
    runtime: PluginRuntime; openPlugins?: boolean; pluginStartupError?: string
}) {
    const [settings, setSettings] = useState(openPlugins)
    const [page, setPage] = useState<BuiltinPage | `plugin.${string}`>('dashboard')
    const [noticeToOpen, setNoticeToOpen] = useState<Notice | null>(null)
    const [mailToOpen, setMailToOpen] = useState<MailItem | null>(null)
    const [calendarInitialView, setCalendarInitialView] = useState<CalendarView>('week')
    const [tab, setTab] = useState<Tab>(openPlugins ? 'plugins' : 'general')
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
    const pluginPage = runtime.pages.get(page)
    const showSettings = settings || (needsSetup && !pluginPage)
    const canShowPage = accountLoaded && (!window.accounts || account?.status === 'signed-in')
    const setup: PluginViewState['setup'] = needsLogin ? 'login' : needsPreferences ? 'preferences' : undefined
    const showNoticesPage = !showSettings && page === 'notices'
    const showCalendarPage = !showSettings && page === 'calendar'
    const showTodosPage = !showSettings && page === 'todos'
    const showDashboardPage = !showSettings && page === 'dashboard'
    const showChatPage = !showSettings && page === 'chat'
    const showMailPage = !showSettings && page === 'mail'
    const settingsButton = useRef<HTMLButtonElement>(null)
    const settingsWasOpen = useRef(false)

    useEffect(() => {
        let active = true
        void window.accounts?.getState().then(result => {
            if (active && result.ok) setAccount(result.data)
        }).catch(() => {
            if (active) {
                setSettings(true);
                setTab(current => current === 'plugins' ? current : 'account')
            }
        }).finally(() => {
            if (active) setAccountLoaded(true)
        })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        if (needsLogin) setTab(current => current === 'plugins' ? current : 'account')
        else if (needsPreferences) setTab(current => current === 'plugins' ? current : 'messages')
    }, [needsLogin, needsPreferences, account?.username])

    useEffect(() => runtime.onServiceChange(change => {
        if (change.type === 'account') {
            if (account?.username !== change.value.username || account?.status !== change.value.status) setPreferences(null)
            setAccount(change.value)
        } else {
            setPreferences(change.value)
            if (needsPreferences && validateRequiredMessagePreferences(change.value).ok) setSettings(false)
        }
    }), [runtime, account?.username, account?.status, needsPreferences])

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
            if (event.defaultPrevented || document.querySelector('dialog:modal')) return
            if (event.key === 'Escape' && (!needsSetup || pluginPage)) setSettings(false)
        }

        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [needsSetup, pluginPage])

    function openPage(next: BuiltinPage | `plugin.${string}`, calendarView: CalendarView = 'week') {
        if (next === 'calendar') setCalendarInitialView(calendarView)
        setPage(next)
        if (runtime.pages.has(next)) setSettings(false)
        else if (needsLogin) {
            setTab('account')
            setSettings(true)
        } else if (needsPreferences) setTab('messages')
        else setSettings(false)
    }

    function tabAllowed(id: Tab) {
        if (id === 'plugins' || id === 'about' || id === 'account') return true
        return !needsLogin && (!needsPreferences || id === 'messages')
    }

    function navigatePlugin(route: PluginRoute, pluginId: string) {
        if (route.startsWith('page.')) {
            const id = route.slice(5) as BuiltinPage
            if (pluginBuiltinPages.includes(id)) return openPage(id)
        } else if (route.startsWith('settings.')) {
            const id = route.slice(9) as Tab
            if ((id === 'plugins' || pluginBuiltinSettings.includes(id)) && tabAllowed(id)) {
                setTab(id)
                setSettings(true)
                return
            }
        } else if (route.startsWith('plugin.')) {
            const next = `plugin.${pluginId}/${route.slice(7)}` as const
            if (runtime.pages.has(next)) return openPage(next)
        }
        throw new Error('当前无法打开该页面。')
    }

    function view(id: PluginView, content: ReactNode, state: PluginViewState = {}, active = true) {
        const spec = runtime.views.get(id)
        if (!spec || !active) return content
        return <PluginFrame key={id} runtime={runtime} spec={spec} state={{setup, ...state}}
                            onNavigate={navigatePlugin} fallback={content} keepFallback={id === 'settings.messages'}/>
    }

    function tabKey(event: KeyboardEvent<HTMLButtonElement>, id: Tab) {
        const available = tabs.filter(item => tabAllowed(item.id))
        const index = available.findIndex(item => item.id === id)
        const offsets: Record<string, number> = {
            ArrowDown: 1,
            ArrowUp: -1,
            Home: -index,
            End: available.length - 1 - index
        }
        if (!(event.key in offsets)) return
        event.preventDefault()
        const next = available[(index + offsets[event.key] + available.length) % available.length].id
        setTab(next);
        document.getElementById(`settings-tab-${next}`)?.focus()
    }

    return <>{view('titlebar', <WindowTitlebar/>)}
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
                <button type="button" className={`icon-button rail-button ${showMailPage ? 'is-active' : ''}`}
                        aria-label="邮箱" title="邮箱"
                        aria-current={showMailPage ? 'page' : undefined} onClick={() => openPage('mail')}><Icon
                    name="mail"/></button>
                <button type="button" className={`icon-button rail-button ${showCalendarPage ? 'is-active' : ''}`}
                        aria-label={calendarNavigation.label}
                        title={calendarNavigation.label} aria-current={showCalendarPage ? 'page' : undefined}
                        onClick={() => openPage('calendar')}><Icon name={calendarNavigation.icon}/></button>
                <button type="button" className={`icon-button rail-button ${showTodosPage ? 'is-active' : ''}`}
                        aria-label="待办" title="待办" aria-current={showTodosPage ? 'page' : undefined}
                        onClick={() => openPage('todos')}><Icon name="todo"/></button>
                {runtime.pages.size > 0 && <div className="plugin-page-links">
                    {[...runtime.pages].map(([id, item]) => <button type="button" key={id}
                                                                    className={`icon-button rail-button ${!showSettings && page === id ? 'is-active' : ''}`}
                                                                    title={item.title} aria-label={item.title}
                                                                    aria-current={!showSettings && page === id ? 'page' : undefined}
                                                                    onClick={() => openPage(id as `plugin.${string}`)}>
                        <Icon name="panel"/></button>)}
                </div>}
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
                                    {tabs.map(item => <button type="button" key={item.id}
                                                              id={`settings-tab-${item.id}`}
                                                              role="tab" aria-selected={tab === item.id}
                                                              aria-controls={`settings-panel-${item.id}`}
                                                              tabIndex={tab === item.id ? 0 : -1}
                                                              disabled={!tabAllowed(item.id)}
                                                              onKeyDown={event => tabKey(event, item.id)}
                                                              onClick={() => setTab(item.id)}
                                                              className={`settings-tab ${tab === item.id ? 'is-active' : ''}`}>
                                        <Icon name={item.icon}/>
                                        <span>{item.label}</span></button>)}
                                </div>
                                <section className="settings-panel" role="tabpanel" id={`settings-panel-${tab}`}
                                         aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
                                    {tab === 'general' && showSettings && view('settings.general', <GeneralPanel/>)}
                                    {tab === 'notifications' && showSettings && view('settings.notifications',
                                        <NotificationSettingsPanel/>)}
                                    {tab === 'account' && view('settings.account', <AccountPanel account={account}
                                                                                                 onChange={setAccount}/>, {}, showSettings)}
                                    {tab === 'about' && view('settings.about', <AboutPanel/>, {}, showSettings)}
                                    {tab === 'plugins' && showSettings &&
                                        <PluginPanel startupError={pluginStartupError}/>}
                                    {view('settings.mail', <MailPanel key={account?.username}
                                                                      active={showSettings && tab === 'mail'}
                                                                      campusUsername={account?.username ?? undefined}/>, {}, showSettings && tab === 'mail')}
                                    <div className="plugin-settings-content"
                                         hidden={tab !== 'messages'}>{view('settings.messages', <MessagePreferencesPanel
                                        key={account?.status === 'signed-in' ? account.username : 'signed-out'}
                                        requiredProfile={account?.status === 'signed-in'}
                                        onChange={setPreferences} onSaved={value => {
                                        if (needsPreferences && validateRequiredMessagePreferences(value).ok) setSettings(false)
                                    }}/>, {}, showSettings && tab === 'messages')}</div>
                                    <div className="plugin-settings-content"
                                         hidden={tab !== 'sources'}>{view('settings.sources', <SourcesPanel
                                        active={showSettings && tab === 'sources'}/>, {}, showSettings && tab === 'sources')}</div>
                                    <div className="plugin-settings-content"
                                         hidden={tab !== 'llm'}>{view('settings.llm', <LlmPanel key={account?.username}
                                                                                                active={settings && tab === 'llm'}/>, {}, showSettings && tab === 'llm')}</div>
                                    <div className="plugin-settings-content"
                                         hidden={tab !== 'research'}>{view('settings.research', <ResearchPanel
                                        key={account?.username ?? 'signed-out'}
                                        active={showSettings && tab === 'research'}/>, {}, showSettings && tab === 'research')}</div>
                                </section>
                            </div>
                        </div>
                        {showDashboardPage && canShowPage && view('page.dashboard',
                            <DashboardPage key={`${account?.username}-${preferences?.educationLevel}`}
                                           onNavigate={openPage}
                                           onOpenNotice={notice => {
                                               setNoticeToOpen(notice);
                                               openPage('notices')
                                           }}
                                           onOpenMail={item => {
                                               setMailToOpen(item);
                                               openPage('mail')
                                           }}/>)}
                        {showNoticesPage && canShowPage && view('page.notices',
                            <NoticesPage key={account?.username} noticeToOpen={noticeToOpen}
                                         onNoticeOpened={() => setNoticeToOpen(null)}
                                         onLogin={() => {
                                             setTab('account');
                                             setSettings(true)
                                         }}/>, {notice: noticeToOpen})}
                        {showChatPage && canShowPage && view('page.chat',
                            <ChatPage key={account?.username} username={account?.username ?? ''}
                                      onOpenNotice={notice => {
                                          setNoticeToOpen(notice);
                                          openPage('notices')
                                      }}
                                      onSettings={() => {
                                          setTab('llm');
                                          setSettings(true)
                                      }}/>)}
                        {showCalendarPage && canShowPage && view('page.calendar',
                            <CalendarPage key={`${account?.username}-${preferences?.educationLevel}`}
                                          initialView={calendarInitialView}/>, {calendarView: calendarInitialView})}
                        {showTodosPage && canShowPage && view('page.todos', <TodosPage key={account?.username}/>)}
                        {showMailPage && canShowPage && view('page.mail',
                            <MailboxPage key={account?.username} initialMail={mailToOpen}
                                         onInitialMailOpened={() => setMailToOpen(null)}
                                         onSettings={() => {
                                             setTab('mail');
                                             setSettings(true)
                                         }}/>, {mail: mailToOpen})}
                        {!showSettings && pluginPage && <PluginFrame key={page} runtime={runtime} spec={pluginPage}
                                                                     onNavigate={navigatePlugin} state={{setup}}/>}
                    </main>
                </div>
            </div>
        </div>
    </>
}
