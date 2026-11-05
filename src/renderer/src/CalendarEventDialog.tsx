import {type FormEvent, useEffect, useRef, useState} from 'react'
import {
    calendarDate,
    type CalendarEvent,
    type CalendarEventInput,
    type CalendarOccurrence,
    timeLabel,
    validateCalendarEvent
} from '../../shared/calendar'
import {dateAfter} from '../../shared/timetable'
import {eventTime} from './CalendarViews'
import {Icon} from './Icon'
import {type CalendarReminderMinutes, calendarReminderOptions} from '../../shared/calendar-reminders'

export function CalendarEventDialog({date, startMinute = 9 * 60, item, create, onClose, onSaved, onRemoved}: {
    date: string; startMinute?: number; item: CalendarOccurrence | null; create: boolean; onClose: () => void;
    onSaved: (event: CalendarEvent) => void; onRemoved: (id: string) => void
}) {
    const dialog = useRef<HTMLDialogElement>(null)
    const reminderEdited = useRef(false)
    const [loadingDefaultReminder, setLoadingDefaultReminder] = useState(create && !!window.notificationSettings)
    const [editing, setEditing] = useState(create)
    const [draft, setDraft] = useState<CalendarEventInput>(() => {
        if (item?.event) return item.event
        const nextDay = dateAfter(date, 1)
        const crossesMidnight = startMinute + 60 >= 1440
        const endDate = crossesMidnight && calendarDate(nextDay) ? nextDay : date
        return {
            title: '',
            startDate: date,
            endDate,
            startTime: timeLabel(startMinute),
            endTime: timeLabel(endDate !== date ? (startMinute + 60) % 1440 : Math.min(startMinute + 60, 1439)),
            allDay: false,
            reminderMinutes: 30,
            location: '',
            notes: '',
        }
    })
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [openingCourseLink, setOpeningCourseLink] = useState<'syllabus' | 'replay' | null>(null)
    const [confirmDelete, setConfirmDelete] = useState(false)
    useEffect(() => {
        dialog.current?.showModal()
    }, [])

    useEffect(() => {
        if (!create || !window.notificationSettings) return
        let active = true
        void window.notificationSettings.get().then(result => {
            if (!active) return
            if (result.ok) {
                if (!reminderEdited.current) setDraft(current => ({
                    ...current,
                    reminderMinutes: result.data.calendarDefaultReminder
                }))
            } else setError(result.error)
        }).catch(() => {
            if (active) setError('无法读取默认提醒时间，请确认提醒时间后保存。')
        }).finally(() => {
            if (active) setLoadingDefaultReminder(false)
        })
        return () => {
            active = false
        }
    }, [create])

    function change<K extends keyof CalendarEventInput>(key: K, value: CalendarEventInput[K]) {
        setDraft(current => ({
            ...current, [key]: value,
            ...(key === 'startDate' && typeof value === 'string' && value > current.endDate ? {endDate: value} : {})
        }))
        setError('')
    }

    async function save(event: FormEvent) {
        event.preventDefault()
        if (busy || loadingDefaultReminder) return
        if (!window.calendar) {
            setError('日程服务未加载，请重启应用后再保存。');
            return
        }
        const validated = validateCalendarEvent(draft)
        if (!validated.ok) {
            setError(validated.error);
            return
        }
        setBusy(true)
        setError('')
        try {
            const result = await window.calendar.save(validated.data)
            if (!result.ok) setError(result.error)
            else {
                onSaved(result.data);
                onClose()
            }
        } catch {
            setError('无法保存日程，请重试。')
        } finally {
            setBusy(false)
        }
    }

    async function openCourseLink(kind: 'syllabus' | 'replay') {
        if (busy || !item?.course) return
        const label = kind === 'syllabus' ? '教学大纲' : '课程回放'
        if (!window.timetable) {
            setError(`${label}服务未加载，请重启应用后重试。`)
            return
        }
        setBusy(true)
        setOpeningCourseLink(kind)
        setError('')
        try {
            const result = await (kind === 'syllabus' ? window.timetable.openSyllabus(item.course.id) : window.timetable.openReplay(item.course.id))
            if (!result.ok) setError(result.error)
        } catch {
            setError(`无法打开${label}，请稍后重试。`)
        } finally {
            setBusy(false)
            setOpeningCourseLink(null)
        }
    }

    async function remove() {
        if (busy || !window.calendar || !item?.event) return
        setBusy(true)
        setError('')
        try {
            const result = await window.calendar.remove(item.event.id)
            if (!result.ok) setError(result.error)
            else {
                onRemoved(item.event.id);
                onClose()
            }
        } catch {
            setError('无法删除日程，请重试。')
        } finally {
            setBusy(false)
        }
    }

    return <dialog className="calendar-dialog" ref={dialog}
                   aria-label={editing ? (create ? '新建日程' : '编辑日程') : '日程详情'}
                   onCancel={event => {
                       if (busy) event.preventDefault()
                   }} onClose={onClose}
                   onClick={event => {
                       if (!busy && event.target === dialog.current) onClose()
                   }}>
        <div className="calendar-dialog-header">
            <strong>{editing ? (create ? '新建日程' : '编辑日程') : item?.title}</strong>
            <button type="button" className="icon-button" aria-label="关闭日程" disabled={busy} onClick={onClose}><Icon
                name="close"/></button>
        </div>
        {editing ? <form className="calendar-event-form" onSubmit={save}>
            <label>名称<input autoFocus value={draft.title} required maxLength={200} disabled={busy}
                              onChange={event => change('title', event.target.value)}/></label>
            <label className="calendar-all-day-field"><span>全天</span><input type="checkbox" checked={draft.allDay}
                                                                              disabled={busy}
                                                                              onChange={event => change('allDay', event.target.checked)}/></label>
            <div className="calendar-form-row"><label>开始日期<input type="date" min="1900-01-01" max="2100-12-31"
                                                                     value={draft.startDate} required disabled={busy}
                                                                     onChange={event => change('startDate', event.target.value)}/></label>
                {!draft.allDay && <label>开始时间<input type="time" value={draft.startTime} required disabled={busy}
                                                        onChange={event => change('startTime', event.target.value)}/></label>}
            </div>
            <div className="calendar-form-row"><label>结束日期<input type="date" min={draft.startDate} max="2100-12-31"
                                                                     value={draft.endDate} required disabled={busy}
                                                                     onChange={event => change('endDate', event.target.value)}/></label>
                {!draft.allDay && <label>结束时间<input type="time" value={draft.endTime} required disabled={busy}
                                                        onChange={event => change('endTime', event.target.value)}/></label>}
            </div>
            <label>提醒时间<select value={draft.reminderMinutes} disabled={busy}
                                   onChange={event => {
                                       reminderEdited.current = true
                                       change('reminderMinutes', Number(event.target.value) as CalendarReminderMinutes)
                                   }}>
                {calendarReminderOptions.map(option => <option key={option.value}
                                                               value={option.value}>{option.label}</option>)}
            </select></label>
            <label>地点<input value={draft.location} maxLength={500} disabled={busy}
                              onChange={event => change('location', event.target.value)}/></label>
            <label>备注<textarea value={draft.notes} maxLength={5000} rows={3} disabled={busy}
                                 onChange={event => change('notes', event.target.value)}/></label>
            {error && <p className="account-error" role="alert">{error}</p>}
            <div className="calendar-dialog-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
                <button type="submit" className="primary-button"
                        disabled={busy || loadingDefaultReminder}>{busy ? '正在保存…' : '保存'}</button>
            </div>
        </form> : <>
            <dl className="calendar-event-details">
                <dt>日期</dt>
                <dd>{item?.event ? `${item.event.startDate}${item.event.endDate !== item.event.startDate ? ` — ${item.event.endDate}` : ''}` : item?.date}</dd>
                <dt>时间</dt>
                <dd>{item?.event ? (item.event.allDay ? '全天' : `${item.event.startTime}–${item.event.endTime}`) : item && eventTime(item)}</dd>
                {item?.event && <>
                    <dt>提醒</dt>
                    <dd>{calendarReminderOptions.find(option => option.value === item.event!.reminderMinutes)?.label || '无'}</dd>
                </>}
                <dt>地点</dt>
                <dd>{item?.location || '未设置'}</dd>
                {item?.course && <>
                    <dt>教师</dt>
                    <dd>{item.course.teachers.join('、') || '未提供'}</dd>
                    <dt>节次</dt>
                    <dd>第 {item.course.startUnit}–{item.course.endUnit} 节</dd>
                    <dt>周次</dt>
                    <dd>{item.course.weeks.filter(week => week > 0).join('、')} 周</dd>
                </>}
                {item?.event?.notes && <>
                    <dt>备注</dt>
                    <dd className="calendar-notes">{item.event.notes}</dd>
                </>}
            </dl>
            {error && <p className="account-error" role="alert">{error}</p>}
            {item?.event && <div className="calendar-dialog-actions">{confirmDelete ? <>
                <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => setConfirmDelete(false)}>取消删除
                </button>
                <button type="button" className="primary-button calendar-delete" disabled={busy}
                        onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button>
            </> : <>
                <button type="button" className="secondary-button" onClick={() => setConfirmDelete(true)}>删除</button>
                <button type="button" className="primary-button" onClick={() => setEditing(true)}>编辑</button>
            </>}</div>}
            {item?.course && <div className="calendar-course-links">
                <button type="button" className="text-button" disabled={busy}
                        aria-busy={openingCourseLink === 'syllabus'} onClick={() => void openCourseLink('syllabus')}>
                    {openingCourseLink === 'syllabus' ? '正在打开…' : '查看教学大纲'}<Icon name="external"/>
                </button>
                <button type="button" className="text-button" disabled={busy}
                        aria-busy={openingCourseLink === 'replay'} onClick={() => void openCourseLink('replay')}>
                    {openingCourseLink === 'replay' ? '正在打开…' : '查看课程回放'}<Icon name="external"/>
                </button>
            </div>}
        </>}
    </dialog>
}
