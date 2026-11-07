import {type ChatActionRequest, chatActionTitles as titles, chatActionStatusLabels as statuses} from '../../shared/chat'
import type {CalendarEventInput} from '../../shared/calendar'
import type {TodoInput} from '../../shared/todos'
import {calendarReminderOptions} from '../../shared/calendar-reminders'
import {Icon} from './Icon'


function Preview({value}: { value: CalendarEventInput | TodoInput }) {
    const todo = 'dueDate' in value
    const reminder = calendarReminderOptions.find(item => item.value === value.reminderMinutes)?.label ?? '无'
    return <div className="chat-action-preview">
        <strong>{value.title}</strong>
        <dl>
            {todo ? <>
                <dt>截止时间</dt>
                <dd>{value.dueDate ? `${value.dueDate} ${value.dueTime}` : '无截止日期'}</dd>
            </> : <>
                <dt>开始</dt>
                <dd>{value.startDate} {value.allDay ? '全天' : value.startTime}</dd>
                <dt>结束</dt>
                <dd>{value.endDate} {value.allDay ? '全天' : value.endTime}</dd>
                <dt>地点</dt>
                <dd>{value.location || '无'}</dd>
            </>}
            <dt>提醒</dt>
            <dd>{todo && !value.dueDate ? '无' : reminder}</dd>
            <dt>备注</dt>
            <dd>{value.notes || '无'}</dd>
        </dl>
    </div>
}

export function ChatActionRequestCard({request, disabled, onDecide, onUndo, onManageMemory}: {
    request: ChatActionRequest; disabled: boolean; onDecide: (allow: boolean) => void; onUndo: () => void; onManageMemory: () => void
}) {
    const {action} = request
    return <section className="chat-summary-request" aria-label={`${titles[action.kind]}请求`}>
        <header><strong><Icon name={action.kind === 'create_todo' ? 'todo' : 'calendar'}/>{titles[action.kind]}</strong>
            <span role="status">{statuses[request.status]}</span></header>
        {action.kind === 'remember' || action.kind === 'forget' ? <div className="chat-action-preview">
            <strong>{action.memory.text}</strong><p>依据：{action.memory.evidence}</p>
            <p>{action.kind === 'remember' ? '允许后保存在本机；记忆启用时可随对话发送给模型服务。' : '允许后从记忆库删除。'}</p>
            {request.status === 'completed' && action.kind === 'remember' && <button type="button" className="secondary-button" onClick={onManageMemory}>查看或删除记忆</button>}
        </div> : <Preview value={action.kind === 'create_todo' ? action.todo : action.after}/>}
        {request.status === 'pending' && <div className="chat-summary-actions">
            <button type="button" className="primary-button" disabled={disabled} onClick={() => onDecide(true)}>允许
            </button>
            <button type="button" className="secondary-button" disabled={disabled}
                    onClick={() => onDecide(false)}>拒绝
            </button>
        </div>}
        {request.status === 'completed' && request.checkpoint && <div className="chat-summary-actions">
            <button type="button" className="secondary-button" disabled={disabled} onClick={onUndo}>撤销{titles[action.kind]}</button>
        </div>}
        {request.error && <p className="chat-error" role="alert">{request.error}</p>}
    </section>
}
