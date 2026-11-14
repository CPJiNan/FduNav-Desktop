import {ipcMain, type IpcMainInvokeEvent} from 'electron'
import type {Result} from '../shared/accounts'
import {parseWeather, type WeatherForecast} from '../shared/weather'

const endpoint = 'https://aos.fudan.edu.cn/_web/_customizes/fudan/weather/api/today.rst'
const cacheDuration = 15 * 60_000

export function registerWeatherHandlers(trusted: (event: IpcMainInvokeEvent) => boolean) {
    let cached: WeatherForecast | null = null
    let pending: Promise<Result<WeatherForecast>> | null = null

    ipcMain.handle('weather:forecast', async (event, refresh: unknown): Promise<Result<WeatherForecast>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        if (refresh !== undefined && typeof refresh !== 'boolean') return {ok: false, error: '天气查询参数无效。'}
        if (pending) return pending
        if (!refresh && cached && Date.now() - Date.parse(cached.updatedAt) < cacheDuration) return {
            ok: true,
            data: cached
        }
        pending = (async (): Promise<Result<WeatherForecast>> => {
            let response: Response
            try {
                response = await fetch(endpoint, {
                    redirect: 'error', cache: 'no-store',
                    headers: {Accept: 'application/json', Referer: 'https://aos.fudan.edu.cn/'},
                    signal: AbortSignal.timeout(15_000),
                })
            } catch {
                return {ok: false, error: '无法获取复旦天气，请检查网络或稍后重试。'}
            }
            if (!response.ok) return {ok: false, error: `复旦天气服务返回 HTTP ${response.status}，请稍后重试。`}
            let payload: unknown
            try {
                payload = await response.json()
            } catch {
                return {ok: false, error: '复旦天气返回了无法识别的数据。'}
            }
            const forecast = parseWeather(payload)
            if (!forecast) return {ok: false, error: '复旦天气数据格式已变化，暂时无法显示。'}
            cached = forecast
            return {ok: true, data: forecast}
        })().finally(() => {
            pending = null
        })
        return pending
    })
}
