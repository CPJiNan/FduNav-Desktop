import {useCallback, useEffect, useRef, useState} from 'react'
import type {WeatherCampus, WeatherForecast} from '../../shared/weather'
import {Icon} from './Icon'

type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'snow' | 'fog'

const cloudShape = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'

function weatherKind(condition: string): WeatherKind {
    if (/雪|冰粒/.test(condition)) return 'snow'
    if (/雷|雹/.test(condition)) return 'storm'
    if (/雨/.test(condition)) return 'rain'
    if (/雾|霾|沙|尘/.test(condition)) return 'fog'
    if (/阴/.test(condition)) return 'overcast'
    if (/云/.test(condition)) return 'cloudy'
    return 'clear'
}

function WeatherGlyph({condition}: { condition: string }) {
    const kind = weatherKind(condition)
    const rain = 'M10 19.5l-1 3.5M15 19.5l-1 3.5M20 19.5l-1 3.5'
    const snow = [9.5, 14.5, 19.5].map(x => `M${x} 18v4m-1.7-3 3.4 2m-3.4 2 3.4-2`).join('')
    return <svg className="dashboard-weather-glyph" data-kind={kind} viewBox="0 0 24 28" aria-hidden="true">
        {kind === 'clear' ? <>
            <circle cx="12" cy="13" r="5"/>
            <path
                d="M12 3v2.5M12 20.5V23M2 13h2.5M19.5 13H22M4.9 5.9l1.8 1.8M17.3 18.3l1.8 1.8M19.1 5.9l-1.8 1.8M6.7 18.3l-1.8 1.8"/>
        </> : <>
            {kind === 'cloudy' && <>
                <circle cx="19" cy="4.5" r="2.2"/>
                <path d="M19 1.5v1M22.5 4.5h1M21.5 2.5l.7-.7"/>
            </>}
            <g transform="translate(0 -2)">
                {kind === 'overcast' && <path className="dashboard-weather-glyph-wash" d={cloudShape}/>}
                <path d={cloudShape}/>
            </g>
            {kind === 'rain' && <path d={rain}/>}
            {kind === 'storm' &&
                <path className="dashboard-weather-glyph-solid" d="M13.5 18.5 11 23h2.5L12 27l4.5-5.5h-3L15 18.5Z"/>}
            {kind === 'snow' && <path d={snow}/>}
            {kind === 'fog' && <path d="M4 20h16M7 23.5h13"/>}
        </>}
    </svg>
}

function formatUpdatedAt(value: string) {
    return new Date(value).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    })
}

function campusNotes(campuses: WeatherCampus[]) {
    const notes = new Set<string>()
    for (const campus of campuses) for (const day of campus.days) if (day.description) notes.add(day.description)
    return [...notes]
}

function CampusWeather({campus}: { campus: WeatherCampus }) {
    const current = campus.days[0]
    const next = campus.days[1]
    const wind = [current.windDirection, current.windLevel].filter(Boolean).join(' ')
    return <article className="dashboard-weather-campus" aria-label={`${campus.name}天气`}>
        <div className="dashboard-weather-campus-heading">
            <h3>{campus.name}</h3>
            <span className="dashboard-weather-period" title={current.period}>{current.period}</span>
        </div>
        <div className="dashboard-weather-now">
            <WeatherGlyph condition={current.condition}/>
            <div>
                <p className="dashboard-weather-temperature">
                    <span className="sr-only">{current.low} 至 {current.high} 摄氏度</span>
                    <strong aria-hidden="true">{current.low}–{current.high}</strong>
                    <span aria-hidden="true">°C</span>
                </p>
                <p className="dashboard-weather-condition">{current.condition}</p>
            </div>
        </div>
        {(current.humidity || wind) && <p className="dashboard-weather-detail">
            {current.humidity && <span>湿度 {current.humidity}</span>}
            {wind && <span>{wind}</span>}
        </p>}
        {next &&
            <p className="dashboard-weather-next" title={`${next.period}：${next.condition} ${next.low}–${next.high}°C`}>
                <span className="dashboard-weather-next-label">下一时段</span>
                <span className="dashboard-weather-next-condition">{next.condition}</span>
                <strong>{next.low}–{next.high}°C</strong>
            </p>}
        {current.warnings.length > 0 &&
            <p className="dashboard-weather-warning">{current.warnings.join('；')}</p>}
    </article>
}

export function WeatherWidget({refreshVersion}: { refreshVersion: number }) {
    const [data, setData] = useState<WeatherForecast | null>(null)
    const [busy, setBusy] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState('')
    const mounted = useRef(false)
    const pending = useRef(false)
    const queuedRefresh = useRef(false)
    const previousVersion = useRef(refreshVersion)
    const api = window.weather

    const load = useCallback(async function load(force = false) {
        if (pending.current) {
            if (force) {
                queuedRefresh.current = true;
                setRefreshing(true)
            }
            return
        }
        if (!api) {
            setBusy(false)
            setError('请在桌面应用中查看天气。')
            return
        }
        pending.current = true
        setBusy(true)
        setRefreshing(force)
        setError('')
        try {
            const result = await api.forecast(force)
            if (!mounted.current) return
            if (result.ok) setData(result.data)
            else setError(result.error)
        } catch {
            if (mounted.current) setError('无法连接天气服务，请刷新重试。')
        } finally {
            pending.current = false
            if (mounted.current) {
                setBusy(false)
                if (queuedRefresh.current) {
                    queuedRefresh.current = false
                    void load(true)
                } else setRefreshing(false)
            }
        }
    }, [api])

    useEffect(() => {
        mounted.current = true
        void load()
        return () => {
            mounted.current = false
        }
    }, [load])

    useEffect(() => {
        if (previousVersion.current === refreshVersion) return
        previousVersion.current = refreshVersion
        void load(true)
    }, [refreshVersion, load])

    const campuses = data?.campuses ?? []
    const notes = campusNotes(campuses)

    return <div aria-busy={busy}>
        <div className="dashboard-widget-heading">
            <h2><Icon name="sun"/>天气</h2>
            <button type="button" disabled={busy || !api} onClick={() => void load(true)} aria-label="刷新天气">
                <Icon name="refresh"/>{refreshing ? '更新中…' : '刷新'}
            </button>
        </div>
        {busy && !data && <p className="dashboard-widget-caption" role="status">正在读取复旦天气…</p>}
        {error && <p className="dashboard-error" role="alert">{error}</p>}
        {data && !campuses.length && <p className="dashboard-empty">暂无天气数据</p>}
        {campuses.length > 0 && <div className="dashboard-weather-grid">
            {campuses.map(campus => <CampusWeather key={campus.id} campus={campus}/>)}
        </div>}
        {notes.length > 0 && <div className="dashboard-weather-notes">
            {notes.map(note => <p key={note}>{note}</p>)}
        </div>}
        {data && <p className="dashboard-widget-caption">
            数据来源：复旦大学大气与海洋科学系 · 更新于{' '}
            <time dateTime={data.updatedAt}>{formatUpdatedAt(data.updatedAt)}</time>
        </p>}
    </div>
}
