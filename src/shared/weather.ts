import type {Result} from './accounts'

export type WeatherCampusId = 'handan' | 'jiangwan' | 'zhangjiang' | 'fenglin'

const campusOrder: readonly WeatherCampusId[] = ['handan', 'jiangwan', 'zhangjiang', 'fenglin']

const campusNames: Record<WeatherCampusId, string> = {
    handan: '邯郸校区',
    jiangwan: '江湾校区',
    zhangjiang: '张江校区',
    fenglin: '枫林校区',
}

export interface WeatherDay {
    period: string
    condition: string
    low: number
    high: number
    humidity: string
    windDirection: string
    windLevel: string
    description: string
    warnings: string[]
}

export interface WeatherCampus {
    id: WeatherCampusId
    name: string
    days: WeatherDay[]
}

export interface WeatherForecast {
    campuses: WeatherCampus[]
    updatedAt: string
}

export interface WeatherAPI {
    forecast(refresh?: boolean): Promise<Result<WeatherForecast>>
}

function readText(value: unknown, limit: number): string {
    const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function readTemperature(value: unknown): number | null {
    const temperature = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (!Number.isFinite(temperature) || temperature < -80 || temperature > 80) return null
    return Math.round(temperature * 10) / 10
}

function readWarnings(value: unknown): string[] {
    const items: unknown[] = Array.isArray(value) ? value.slice(0, 4) : value ? [value] : []
    const warnings: string[] = []
    for (const item of items) {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
        const warning = readText(source ? source.name ?? source.content ?? source.text : item, 200)
        if (warning && !warnings.includes(warning)) warnings.push(warning)
    }
    return warnings
}

function readDay(value: unknown): WeatherDay | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const day = value as Record<string, unknown>
    const condition = readText(day.weatherName, 40)
    const low = readTemperature(day.tempLow)
    const high = readTemperature(day.tempHigh)
    if (!condition || low === null || high === null || high < low) return null
    return {
        period: readText(day.weatherDate, 40),
        condition,
        low,
        high,
        humidity: readText(day.humidity, 20),
        windDirection: readText(day.windDirection, 20),
        windLevel: readText(day.windLevel, 20),
        description: readText(day.weatherDesc, 200),
        warnings: readWarnings(day.weatherWarnings),
    }
}

function readCampus(id: WeatherCampusId, value: unknown): WeatherCampus | null {
    if (!Array.isArray(value)) return null
    const days = value.slice(0, 8).map(readDay).filter((day): day is WeatherDay => day !== null)
    if (!days.length) return null
    const first = value[0]
    const rawName = first && typeof first === 'object' && !Array.isArray(first)
        ? readText((first as Record<string, unknown>).campusName, 20)
        : ''
    return {id, name: rawName || campusNames[id], days}
}

export function parseWeather(value: unknown): WeatherForecast | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const payload = value as Record<string, unknown>
    const source = payload.data
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null
    const campuses = campusOrder
        .map(id => readCampus(id, (source as Record<string, unknown>)[id]))
        .filter((campus): campus is WeatherCampus => campus !== null)
    if (!campuses.length) return null
    return {campuses, updatedAt: new Date().toISOString()}
}
