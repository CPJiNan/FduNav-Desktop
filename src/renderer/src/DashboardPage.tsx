import {type ReactNode, useEffect, useState} from 'react'
import type {Result} from '../../shared/accounts'
import type {Notice, NoticeList} from '../../shared/notices'
import type {Todo} from '../../shared/todos'
import type {Timetable} from '../../shared/timetable'
import {type CalendarEvent, calendarOccurrences, type CalendarView, localToday, timeLabel} from '../../shared/calendar'
import {Icon} from './Icon'
import {CampusCardWidget} from './CampusCardWidget'
import {LibraryWidget} from './LibraryWidget'
import {WeatherWidget} from './WeatherWidget'
import './styles/dashboard.css'

const widgetNames = {
    agenda: '今日安排',
    todos: '待办事项',
    card: '校园卡余额',
    library: '图书馆人数',
    weather: '天气',
    news: '通知速览'
} as const
type WidgetId = keyof typeof widgetNames
const defaultLayout: WidgetId[] = ['agenda', 'todos', 'news', 'card', 'library', 'weather']
const layoutStorageKey = 'fdunav.dashboard.layout'
const layoutRevisionKey = 'fdunav.dashboard.layout-revision'
const layoutRevision = 2
const layoutUpgrades: { revision: number; widgets: WidgetId[] }[] = [{revision: 2, widgets: ['weather']}]

function readRevision() {
    try {
        return Number(localStorage.getItem(layoutRevisionKey)) || 1
    } catch {
        return layoutRevision
    }
}

function markRevision() {
    try {
        localStorage.setItem(layoutRevisionKey, String(layoutRevision))
    } catch {
    }
}

function readLayout(): WidgetId[] {
    let saved: unknown
    try {
        saved = JSON.parse(localStorage.getItem(layoutStorageKey) ?? 'null')
    } catch {
        saved = null
    }
    if (!Array.isArray(saved) || !saved.every(id => defaultLayout.includes(id)) || new Set(saved).size !== saved.length) {
        markRevision()
        return [...defaultLayout]
    }
    const layout: WidgetId[] = saved
    const revision = readRevision()
    if (revision >= layoutRevision) return layout
    const added = layoutUpgrades.filter(upgrade => upgrade.revision > revision)
        .flatMap(upgrade => upgrade.widgets)
        .filter(id => !layout.includes(id))
    if (!added.length) {
        markRevision()
        return layout
    }
    const next = [...layout, ...added]
    try {
        localStorage.setItem(layoutStorageKey, JSON.stringify(next))
    } catch {
    }
    markRevision()
    return next
}

type Resource<T> = { data: T; error: string }
const read = async <T, >(request: Promise<Result<T>> | undefined, empty: T): Promise<Resource<T>> => {
    if (!request) return {data: empty, error: '请在桌面应用中查看'}
    try {
        const result = await request
        return result.ok ? {data: result.data, error: ''} : {data: empty, error: result.error}
    } catch {
        return {data: empty, error: '加载失败，请刷新重试'}
    }
}

export function DashboardPage({onNavigate, onOpenNotice}: {
    onNavigate: (page: 'notices' | 'calendar' | 'todos', calendarView?: CalendarView) => void;
    onOpenNotice: (notice: Notice) => void
}) {
    const [now, setNow] = useState(() => new Date())
    const [refresh, setRefresh] = useState(0)
    const [widgetRefresh, setWidgetRefresh] = useState(0)
    const [loading, setLoading] = useState(true)
    const [layout, setLayout] = useState<WidgetId[]>(readLayout)
    const [editing, setEditing] = useState(false)
    const [adding, setAdding] = useState(false)
    const [dragging, setDragging] = useState<WidgetId | null>(null)
    const [dropTarget, setDropTarget] = useState<WidgetId | null>(null)
    const [layoutError, setLayoutError] = useState('')
    const [notices, setNotices] = useState<Resource<NoticeList>>({
        data: {items: [], sources: [], updatedAt: null},
        error: ''
    })
    const [todos, setTodos] = useState<Resource<Todo[]>>({data: [], error: ''})
    const [events, setEvents] = useState<Resource<CalendarEvent[]>>({data: [], error: ''})
    const [timetable, setTimetable] = useState<Resource<Timetable | null>>({data: null, error: ''})

    function saveLayout(next: WidgetId[]) {
        setLayout(next)
        try {
            localStorage.setItem(layoutStorageKey, JSON.stringify(next))
            localStorage.setItem(layoutRevisionKey, String(layoutRevision))
            setLayoutError('')
        } catch {
            setLayoutError('布局保存失败，重新打开页面后可能恢复原布局。')
        }
    }

    function moveWidget(id: WidgetId, target: WidgetId) {
        const from = layout.indexOf(id)
        const to = layout.indexOf(target)
        if (from < 0 || to < 0 || from === to) return
        const next = [...layout]
        next.splice(from, 1)
        next.splice(to, 0, id)
        saveLayout(next)
    }

    useEffect(() => {
        let active = true
        setLoading(true)
        void Promise.all([
            read(window.notices?.list(), {items: [], sources: [], updatedAt: null} as NoticeList),
            read(window.todos?.list(), [] as Todo[]),
            read(window.calendar?.list(), [] as CalendarEvent[]),
            read(window.timetable?.cached(), null as Timetable | null)
        ]).then(([noticeResult, todoResult, eventResult, timetableResult]) => {
            if (!active) return
            setNotices(noticeResult);
            setTodos(todoResult);
            setEvents(eventResult);
            setTimetable(timetableResult)
            setLoading(false)
        })
        return () => {
            active = false
        }
    }, [refresh])

    useEffect(() => {
        const reload = () => {
            setNow(new Date());
            setRefresh(value => value + 1)
        }
        const timer = window.setInterval(() => setNow(new Date()), 30_000)
        const unsubscribe = window.notices?.onChanged(reload)
        const unread = window.notices?.onUnreadChanged(reload)
        window.addEventListener('focus', reload)
        return () => {
            clearInterval(timer);
            unsubscribe?.();
            unread?.();
            window.removeEventListener('focus', reload)
        }
    }, [])

    const today = localToday()
    const minute = now.getHours() * 60 + now.getMinutes()
    const agenda = calendarOccurrences(timetable.data, events.data, today, today)
    const visibleAgenda = agenda.filter(item => !item.allDay && item.startMinute > minute).slice(0, 3)
    const pending = todos.data.filter(item => !item.completed).sort((a, b) =>
        (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.dueTime.localeCompare(b.dueTime))
    const overdue = pending.filter(item => item.dueDate && `${item.dueDate}T${item.dueTime}` < `${today}T${timeLabel(minute)}`).length
    const completed = todos.data.length - pending.length
    const isRelevant = (notice: Notice) => notice.relevance === 'related' || notice.relevance === 'maybe'
    const latest = [...notices.data.items].sort((a, b) =>
        Number(isRelevant(b)) - Number(isRelevant(a)) || b.published.localeCompare(a.published)
    ).slice(0, 3)
    const scheduleError = events.error || timetable.error
    const count = (value: number, error: string) => loading || error ? '—' : value

    const content: Record<WidgetId, ReactNode> = {
        library: <LibraryWidget refreshVersion={widgetRefresh}/>,
        card: <CampusCardWidget refreshVersion={widgetRefresh}/>,
        weather: <WeatherWidget refreshVersion={widgetRefresh}/>,
        agenda: <>
            <div className="dashboard-widget-heading"><h2><Icon name="calendar"/>今日安排</h2>
                <button type="button" onClick={() => onNavigate('calendar', 'agenda')}>全部<Icon name="chevron"/>
                </button>
            </div>
            {loading && <p className="dashboard-widget-caption">正在加载…</p>}
            {scheduleError && <p className="dashboard-error">{scheduleError}</p>}
            {!loading && !scheduleError && !visibleAgenda.length && <p className="dashboard-empty">暂无安排</p>}
            <ul className="dashboard-agenda-list">{visibleAgenda.map(item => <li key={item.key}>
                <button type="button" onClick={() => onNavigate('calendar')}>
                    <time>{timeLabel(item.startMinute)}</time>
                    <div><strong>{item.title}</strong><small>{item.location || (item.course ? '课程' : '日程')}</small>
                    </div>
                </button>
            </li>)}</ul>
        </>,
        todos: <>
            <div className="dashboard-widget-heading"><h2><Icon name="todo"/>待办事项</h2>
                <button type="button" onClick={() => onNavigate('todos')}>全部<Icon name="chevron"/></button>
            </div>
            <div className="dashboard-todo-count">
                <strong>{count(pending.length, todos.error)}</strong><span>项待完成</span>
                {!loading && overdue > 0 && <small>{overdue} 项已逾期</small>}</div>
            <progress aria-label="待办完成进度" max={todos.data.length || 1} value={completed}/>
            {todos.error && <p className="dashboard-error">{todos.error}</p>}
            {!loading && !todos.error && !pending.length &&
                <p className="dashboard-empty">{completed ? '待办已全部完成' : '暂无待办'}</p>}
            <ul className="dashboard-todo-list">{pending.slice(0, 3).map(todo => <li key={todo.id}>
                <button type="button" onClick={() => onNavigate('todos')}><span
                    className="dashboard-todo-circle"/><strong>{todo.title}</strong>
                    {todo.dueDate && <small>{todo.dueDate === today ? '今天' : todo.dueDate.slice(5)}</small>}</button>
            </li>)}</ul>
        </>,
        news: <>
            <div className="dashboard-widget-heading"><h2><Icon name="notices"/>通知速览</h2>
                <button type="button" onClick={() => onNavigate('notices')}>全部<Icon name="chevron"/></button>
            </div>
            {loading && <p className="dashboard-widget-caption">正在读取通知…</p>}
            {notices.error && <p className="dashboard-error">{notices.error}</p>}
            {!loading && !notices.error && !latest.length &&
                <p className="dashboard-empty">暂无通知</p>}
            <ul>{latest.map(notice => <li key={`${notice.sourceId}:${notice.url}`}>
                <button type="button" onClick={() => onOpenNotice(notice)}>
                    <span className="dashboard-news-meta">{notice.sourceName}
                        <time>{notice.published}</time></span>
                    <strong>{notice.title}{!notice.read &&
                        <span className="dashboard-news-dot" role="img" aria-label="未读"/>}</strong>
                </button>
            </li>)}</ul>
        </>
    }

    return <section className="dashboard-page" aria-label="仪表盘">
        <header className="dashboard-header">
            {editing && <button type="button" className="dashboard-edit-button" aria-expanded={adding}
                                aria-controls="dashboard-widget-picker" onClick={() => setAdding(value => !value)}>
                <Icon name="plus"/>添加小组件
            </button>}
            <button type="button" className={editing ? 'dashboard-edit-button' : 'icon-button'}
                    title={editing ? '完成编辑' : '编辑小组件'} aria-label={editing ? '完成编辑' : '编辑小组件'}
                    aria-pressed={editing} onClick={() => {
                setEditing(value => !value);
                setAdding(false);
                setDragging(null);
                setDropTarget(null)
            }}>{editing ? '完成' : <Icon name="pencil"/>}</button>
            <button type="button" className="icon-button" title="刷新仪表盘" aria-label="刷新仪表盘" disabled={loading}
                    onClick={() => {
                        setRefresh(value => value + 1);
                        setWidgetRefresh(value => value + 1)
                    }}><Icon name="refresh"/></button>
        </header>
        {layoutError && <p className="dashboard-layout-error" role="alert">{layoutError}</p>}
        {editing && adding &&
            <section id="dashboard-widget-picker" className="dashboard-widget-picker" aria-label="添加小组件">
                {defaultLayout.map(id => <button key={id} type="button" className="dashboard-edit-button"
                                                 disabled={layout.includes(id)}
                                                 onClick={() => saveLayout([...layout, id])}>
                    <Icon name={layout.includes(id) ? 'check' : 'plus'}/>{widgetNames[id]}
                </button>)}
            </section>}
        {!layout.length &&
            <p className="dashboard-layout-empty">暂无小组件，点击{editing ? '“添加小组件”' : '“编辑”'}添加</p>}
        <div className={`dashboard-grid${editing ? ' is-editing' : ''}`}>
            {layout.map((id, index) => <section key={id} aria-label={widgetNames[id]}
                                                className={`dashboard-widget dashboard-${id}${dragging === id ? ' is-dragging' : ''}${dropTarget === id ? ' is-drop-target' : ''}`}
                                                onDragOver={event => {
                                                    if (!editing || !dragging || dragging === id) return
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect = 'move';
                                                    setDropTarget(id)
                                                }}
                                                onDragLeave={event => {
                                                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
                                                }}
                                                onDrop={event => {
                                                    event.preventDefault()
                                                    if (editing && dragging) moveWidget(dragging, id)
                                                    setDragging(null);
                                                    setDropTarget(null)
                                                }}>
                {editing && <div className="dashboard-widget-editor">
                    <button type="button" className="icon-button" title={`删除${widgetNames[id]}`}
                            aria-label={`删除${widgetNames[id]}`}
                            onClick={() => saveLayout(layout.filter(value => value !== id))}><Icon name="close"/>
                    </button>
                    <button type="button" className="icon-button dashboard-drag-handle" draggable
                            title={`拖动排序${widgetNames[id]}`}
                            aria-label={`拖动排序${widgetNames[id]}，可使用方向键移动`}
                            onDragStart={event => {
                                event.dataTransfer.effectAllowed = 'move'
                                event.dataTransfer.setData('text/plain', id)
                                event.dataTransfer.setDragImage(event.currentTarget.closest('section')!, 30, 20)
                                setDragging(id)
                            }}
                            onDragEnd={() => {
                                setDragging(null);
                                setDropTarget(null)
                            }}
                            onKeyDown={event => {
                                const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0
                                if (!step) return
                                event.preventDefault()
                                const target = layout[index + step]
                                if (target) moveWidget(id, target)
                            }}><Icon name="grip"/></button>
                </div>}
                <div inert={editing} aria-busy={loading}>{content[id]}</div>
            </section>)}
        </div>
    </section>
}
