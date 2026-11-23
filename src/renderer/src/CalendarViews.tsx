import {useEffect, useRef} from 'react'
import {
    asDate,
    calendarDate,
    type CalendarOccurrence,
    calendarWeekdays,
    layoutCalendarDay,
    lunarDate,
    monthDates,
    timeLabel,
    weekStartDate
} from '../../shared/calendar'
import {dateAfter} from '../../shared/timetable'
import {calendarEventColor, courseColor} from './timetable-colors'
import {Icon} from './Icon'

export const occurrenceColor = (item: CalendarOccurrence) => item.course ? courseColor(item.course) : calendarEventColor(item.event?.id ?? item.key)
export const eventTime = (item: CalendarOccurrence) => item.allDay ? '全天' : `${timeLabel(item.startMinute)}–${timeLabel(item.endMinute)}`
const dateLabel = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`
const timeSlots = Array.from({length: 24}, (_, hour) => ({minute: hour * 60, label: timeLabel(hour * 60)}))
const groupByDate = (items: CalendarOccurrence[]) => {
    const groups = new Map<string, CalendarOccurrence[]>()
    for (const item of items) groups.set(item.date, [...(groups.get(item.date) ?? []), item])
    return groups
}

interface ViewProps {
    date: string
    today: string
    items: CalendarOccurrence[]
    onDate: (date: string) => void
    onOpen: (item: CalendarOccurrence) => void
}

interface PeriodNavigationProps {
    onNavigate: (amount: number) => void
}

function CalendarPeriodButton({date, direction, onNavigate}: PeriodNavigationProps & {
    date: string; direction: -1 | 1
}) {
    const label = direction < 0 ? '上一周' : '下一周'
    return <button type="button" className={`calendar-period-button ${direction < 0 ? 'is-previous' : ''}`}
                   aria-label={label} title={label}
                   disabled={date === (direction < 0 ? '1900-01-01' : '2100-12-31')}
                   onClick={() => onNavigate(direction)}><Icon name="chevron"/></button>
}

export function CalendarYear({date, today, items, onMonth}: Omit<ViewProps, 'onDate' | 'onOpen'> & {
    onMonth: (date: string) => void
}) {
    const activeDates = new Set(items.map(item => item.date))
    return <div className="calendar-year">{Array.from({length: 12}, (_, month) => {
        const start = `${date.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-01`
        return <button type="button"
                       className={`calendar-mini-month ${start.slice(0, 7) === today.slice(0, 7) ? 'is-current-month' : ''}`}
                       key={start} aria-label={`${date.slice(0, 4)}年${month + 1}月`} onClick={() => onMonth(start)}>
            <strong>{month + 1}月</strong>
            <span className="calendar-mini-grid">{calendarWeekdays.map(day => <span className="calendar-mini-weekday"
                                                                                    key={day}>{day}</span>)}
                {monthDates(start).map(day => <span key={day} aria-hidden={day.slice(0, 7) !== start.slice(0, 7)}
                                                    className={`calendar-mini-day ${day.slice(0, 7) !== start.slice(0, 7) ? 'is-hidden' : ''} ${day === today ? 'is-today' : ''} ${day === date ? 'is-selected' : ''} ${activeDates.has(day) ? 'has-events' : ''}`}>
                    {Number(day.slice(8))}
                </span>)}
            </span>
        </button>
    })}</div>
}

export function CalendarMonth({date, today, items, onDate, onOpen}: ViewProps) {
    const groups = groupByDate(items.filter(item => item.event))
    return <div className="calendar-month">
        <div className="calendar-month-weekdays">{calendarWeekdays.map(day => <div className="calendar-weekday-cell"
                                                                                   key={day}>
            <span>{day}</span>
        </div>)}</div>
        <div className="calendar-month-grid">{monthDates(date).map(day => {
            const events = groups.get(day) ?? []
            return <div className={`calendar-month-cell ${day.slice(0, 7) !== date.slice(0, 7) ? 'is-outside' : ''}`}
                        key={day}>
                <button type="button"
                        className={`calendar-date-button ${day === today ? 'is-today' : ''} ${day === date ? 'is-selected' : ''}`}
                        aria-label={dateLabel(day)} aria-current={day === today ? 'date' : undefined}
                        onClick={() => onDate(day)}>
                    <span>{Number(day.slice(8))}</span><small>{lunarDate(day)}</small>
                </button>
                <div className="calendar-month-events">{events.slice(0, 3).map(item => <button type="button"
                                                                                               key={item.key}
                                                                                               className="calendar-event calendar-month-event"
                                                                                               style={{backgroundColor: occurrenceColor(item)}}
                                                                                               aria-label={`${eventTime(item)} ${item.title}`}
                                                                                               onClick={() => onOpen(item)}>
                    <span>{item.title}</span>
                </button>)}
                    {events.length > 3 && <button type="button" className="calendar-more"
                                                  onClick={() => onDate(day)}>+{events.length - 3} 项</button>}
                </div>
            </div>
        })}</div>
    </div>
}

export function CalendarDateStrip({
                                      date,
                                      today,
                                      onDate,
                                      onNavigate
                                  }: Pick<ViewProps, 'date' | 'today' | 'onDate'> & Partial<PeriodNavigationProps>) {
    const first = weekStartDate(date)
    const dates = calendarWeekdays.map((_, index) => dateAfter(first, index))
    return <div className="calendar-date-strip"><span aria-hidden="true"/>{dates.map((dayDate, index) => {
        const day = calendarWeekdays[asDate(dayDate).getUTCDay()]
        return <div className="calendar-weekday-cell" key={day}>
            <button type="button"
                    className={`calendar-date-button ${dayDate === today ? 'is-today' : ''} ${dayDate === date ? 'is-selected' : ''}`}
                    aria-label={dateLabel(dayDate)} aria-pressed={dayDate === date} onClick={() => onDate(dayDate)}>
                <small>{day}</small><span>{Number(dayDate.slice(8))}</span><small>{lunarDate(dayDate)}</small>
            </button>
            {onNavigate && index === 0 &&
                <CalendarPeriodButton date={date} direction={-1} onNavigate={onNavigate}/>}
            {onNavigate && index === 6 &&
                <CalendarPeriodButton date={date} direction={1} onNavigate={onNavigate}/>}</div>
    })}</div>
}

export function CalendarTimeline({
                                     date,
                                     today,
                                     items,
                                     onDate,
                                     onOpen,
                                     onCreate,
                                     mode,
                                     onNavigate
                                 }: ViewProps & PeriodNavigationProps & {
    mode: 'week' | 'day'; onCreate: (date: string, startMinute: number) => void
}) {
    const scroll = useRef<HTMLDivElement>(null)
    const start = mode === 'week' ? weekStartDate(date) : date
    const dates = Array.from({length: mode === 'week' ? 7 : 1}, (_, index) => dateAfter(start, index))
    const allDay = dates.some(day => items.some(item => item.date === day && item.allDay))
    useEffect(() => {
        if (scroll.current) scroll.current.scrollTop = 7 * 64
    }, [start, mode])
    return <div className={`calendar-timeline calendar-timeline-${mode}`}>
        <div className="calendar-time-scroll" ref={scroll} role="region" tabIndex={0}
             aria-label={mode === 'week' ? '每周课表' : '当天时间轴'}>
            <div className="calendar-time-content">
                <div className="calendar-time-heading">
                    <CalendarDateStrip date={date} today={today} onDate={onDate} onNavigate={onNavigate}/>
                    {allDay && <div className="calendar-time-columns calendar-all-day"><span>全天</span>
                        {dates.map(day => <div
                            key={day}>{items.filter(item => item.date === day && item.allDay).map(item =>
                            <button type="button" key={item.key} className="calendar-event calendar-all-day-event"
                                    style={{backgroundColor: occurrenceColor(item)}}
                                    onClick={() => onOpen(item)}><span>{item.title}</span></button>)}</div>)}
                    </div>}
                </div>
                <div className="calendar-time-columns calendar-hour-grid">
                    <div className="calendar-hours">{Array.from({length: 24}, (_, hour) => <div key={hour}>
                        <span>{String(hour).padStart(2, '0')}:00</span></div>)}</div>
                    {dates.map(day => {
                        const timedItems = items.filter(item => item.date === day && !item.allDay)
                        return <div className="calendar-time-day-column" key={day}>
                            {timeSlots.map(slot => <button type="button"
                                                           className="calendar-hour-line calendar-create-slot"
                                                           key={slot.label}
                                                           disabled={!calendarDate(day)}
                                                           aria-label={`${dateLabel(day)} ${slot.label} 新建日程`}
                                                           onClick={() => onCreate(day, slot.minute)}/>)}
                            {layoutCalendarDay(timedItems).map(({
                                                                    item,
                                                                    lane,
                                                                    lanes
                                                                }) =>
                                <button type="button" className="calendar-event calendar-timed-event" key={item.key}
                                        onClick={() => onOpen(item)}
                                        style={{
                                            backgroundColor: occurrenceColor(item),
                                            top: `calc(${item.startMinute / 60} * var(--calendar-hour-height))`,
                                            height: `calc(${(item.endMinute - item.startMinute) / 60} * var(--calendar-hour-height))`,
                                            left: `${100 * lane / lanes}%`,
                                            width: `${100 / lanes}%`
                                        }}
                                        aria-label={`${item.title}，${eventTime(item)}，${item.location}`}>
                                    <strong>{item.title}</strong><span>{eventTime(item)}</span>{item.location &&
                                    <span>{item.location}</span>}
                                    {item.course && <small>第 {item.course.startUnit}–{item.course.endUnit} 节</small>}
                                </button>)}
                        </div>
                    })}
                </div>
            </div>
        </div>
    </div>
}

export function CalendarAgenda({items, onOpen, onMore}: Pick<ViewProps, 'items' | 'onOpen'> & { onMore?: () => void }) {
    return <div className="calendar-agenda">
        {items.length === 0 && <p className="calendar-empty" role="status">暂无日程</p>}
        {[...groupByDate(items)].map(([date, events]) => <section className="calendar-agenda-group" key={date}>
            <div className="calendar-agenda-date">{Number(date.slice(5, 7))}月{Number(date.slice(8))}日
                星期{calendarWeekdays[asDate(date).getUTCDay()]}
                <span>农历{lunarDate(date, true)}</span></div>
            <div className="calendar-agenda-card">{events.map(item => <button type="button" key={item.key}
                                                                              className="calendar-agenda-event"
                                                                              onClick={() => onOpen(item)}>
                <span
                    className="calendar-agenda-time">{item.allDay ? '全天' : timeLabel(item.startMinute)}{!item.allDay &&
                    <small>{timeLabel(item.endMinute)}</small>}</span>
                <span className="calendar-agenda-bar" style={{backgroundColor: occurrenceColor(item)}}/>
                <span className="calendar-agenda-text"><strong>{item.title}</strong>{item.location &&
                    <span>{item.location}</span>}</span>
            </button>)}</div>
        </section>)}
        {onMore &&
            <button type="button" className="secondary-button calendar-load-more" onClick={onMore}>显示更多</button>}
    </div>
}
