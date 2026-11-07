import {type ChatActionRequest, chatActionStatusLabels as statuses, chatActionTitles as titles} from '../../shared/chat'
import type {CalendarEventInput} from '../../shared/calendar'
import type {TodoInput} from '../../shared/todos'
import {calendarReminderOptions} from '../../shared/calendar-reminders'
import {Icon} from './Icon'


function factRows(value: CalendarEventInput | TodoInput) {
    const todo = 'dueDate' in value
    const reminder = calendarReminderOptions.find(item => item.value === value.reminderMinutes)?.label ?? '无'
    return <dl className="chat-action-facts">
        {todo ? <>
            <dt>截止</dt>
            <dd>{value.dueDate ? `${value.dueDate} ${value.dueTime}` : '无截止日期'}</dd>
        </> : <>
            <dt>时间</dt>
            <dd>{value.startDate} {value.allDay ? '全天' : `${value.startTime} — ${value.endTime}`}</dd>
            <dt>地点</dt>
            <dd>{value.location || '无'}</dd>
        </>}
        <dt>提醒</dt>
        <dd>{todo && !value.dueDate ? '无' : reminder}</dd>
        {value.notes && <>
            <dt>备注</dt>
            <dd>{value.notes}</dd>
        </>}
    </dl>
}

function Preview({value}: { value: CalendarEventInput | TodoInput }) {
    return <><p className="chat-action-title">{value.title}</p>{factRows(value)}</>
}

export function ChatActionRequestCard({request, disabled, onDecide, onUndo, onManageMemory}: {
    request: ChatActionRequest;
    disabled: boolean;
    onDecide: (allow: boolean) => void;
    onUndo: () => void;
    onManageMemory: () => void
}) {
    const {action} = request
    const payload = action.kind === 'create_todo' ? action.todo
        : action.kind === 'update_todo' ? action.after
            : action.kind === 'create_event' || action.kind === 'update_event' ? action.after
                : action.kind === 'delete_todo' || action.kind === 'delete_event' ? action.before : null
    const title = payload?.title ?? ''
    const heading = action.kind === 'remember' && action.targetId ? '更新已有记忆' : titles[action.kind]
    const opensMemory = action.kind === 'remember' && request.status === 'completed'
    return <section className={`chat-summary-request${opensMemory ? ' is-clickable' : ''}`}
                    aria-label={`请求${heading}`}
                    role={opensMemory ? 'link' : undefined}
                    tabIndex={opensMemory ? 0 : undefined}
                    onClick={opensMemory ? onManageMemory : undefined}
                    onKeyDown={opensMemory ? event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onManageMemory()
                        }
                    } : undefined}>
        <header><strong><Icon
            name={action.kind === 'create_todo' ? 'todo' : action.kind === 'remember' ? 'sparkles' : 'calendar'}/>{heading}
            {title && <span className="chat-action-title">{title}</span>}</strong>
            <span role="status">{statuses[request.status]}</span></header>
        {action.kind === 'delete_todo' || action.kind === 'delete_event' ? <dl className="chat-action-facts">
            <dt>将删除</dt>
            <dd>{action.before.title}</dd>
            <dt>说明</dt>
            <dd>允许后删除，撤销可恢复。</dd>
        </dl> : action.kind === 'remember' || action.kind === 'forget' ? <dl className="chat-action-facts">
            {action.kind === 'remember' && action.targetId ? <>
                <dt>原内容</dt>
                <dd className="memory-diff-old">− {action.previousText ?? '（原记忆）'}</dd>
                <dt>新内容</dt>
                <dd className="memory-diff-new">＋ {action.memory.text}</dd>
            </> : <>
                <dt>内容</dt>
                <dd>{action.memory.text}</dd>
            </>}
            <dt>依据</dt>
            <dd>{action.memory.evidence}</dd>
        </dl> : <Preview value={payload as CalendarEventInput | TodoInput}/>}
        {request.status === 'pending' && <div className="chat-summary-actions">
            <button type="button" className="secondary-button chat-ghost-button" disabled={disabled}
                    onClick={() => onDecide(false)}>拒绝
            </button>
            <button type="button" className="primary-button" disabled={disabled} onClick={() => onDecide(true)}>允许
            </button>
        </div>}
        {request.status === 'completed' && request.checkpoint && <div className="chat-summary-actions">
            <button type="button" className="secondary-button" disabled={disabled}
                    onClick={onUndo}>撤销{titles[action.kind]}</button>
        </div>}
        {request.error && <p className="chat-error" role="alert">{request.error}</p>}
    </section>
}
