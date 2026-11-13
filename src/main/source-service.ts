import type {AppDatabase} from './database'
import type {MessageSource} from '../shared/sources'
import type {ParsedNotice} from '../shared/notices'
import {discoverNoticeLists, parseNoticeDate, parseNotices} from './notice-parser.ts'
import {sourceReadingRules} from './source-reading-rules.ts'
import {requestSourcePage, type SourcePage} from './source-fetch.ts'

type RequestPage = (url: string) => Promise<SourcePage>
const defaultRequestPage: RequestPage = url => requestSourcePage(url, 25_000)

export async function collectSource(source: MessageSource, requestPage: RequestPage = defaultRequestPage) {
    const rule = sourceReadingRules[source.id]
    const page = await requestPage(source.url)
    let error = ''
    const parseList = async (text: string, url: string) => {
        const items = parseNotices(text, url, source.id, !!rule.detailDate)
        return rule.detailDate && items.length ? fillMissingDates(items, rule.detailDate, requestPage) : items
    }

    const items = await parseList(page.text, page.url)
    if (items.length) return {items, listUrl: page.url}

    const candidates = discoverNoticeLists(page.text, page.url)
    for (const candidate of candidates) {
        try {
            const list = await requestPage(candidate)
            const parsed = await parseList(list.text, list.url)
            if (parsed.length) return {items: parsed, listUrl: list.url}
        } catch (cause) {
            error = cause instanceof Error ? cause.message : '来源加载失败。'
        }
    }
    throw new Error(error || '未解析到通知，请检查来源网址或改用通知列表页。')
}

async function fillMissingDates(items: ParsedNotice[], selector: string,
                                requestPage: RequestPage): Promise<ParsedNotice[]> {
    const pending = items.filter(item => !item.published)
    await Promise.all(Array.from({length: Math.min(4, pending.length)}, async () => {
        while (pending.length) {
            const item = pending.shift()!
            try {
                const detail = await requestPage(item.url)
                item.published = parseNoticeDate(detail.text, selector) ?? ''
            } catch {
                item.published = ''
            }
        }
    }))
    return items.filter(item => !!item.published)
        .sort((a, b) => b.published.localeCompare(a.published) || a.title.localeCompare(b.title, 'zh-CN'))
}

export class SourceRefreshService {
    private refreshing: Promise<ReturnType<AppDatabase['getNotices']>> | null = null
    private db: AppDatabase
    private requestPage: RequestPage

    constructor(db: AppDatabase, requestPage: RequestPage = defaultRequestPage) {
        this.db = db
        this.requestPage = requestPage
    }

    refresh() {
        if (!this.refreshing) this.refreshing = this.run().finally(() => {
            this.refreshing = null
        })
        return this.refreshing
    }

    private async run() {
        const pending = this.db.getSources().filter(source => source.enabled)
        await Promise.all(Array.from({length: Math.min(3, pending.length)}, async () => {
            while (pending.length) {
                const source = pending.shift()!
                try {
                    const result = await collectSource(source, this.requestPage)
                    this.db.saveNotices(result.items, source.id, source.revision, result.listUrl)
                } catch (error) {
                    this.db.setSourceError(source.id, source.revision, error instanceof Error ? error.message : '来源加载失败。')
                }
            }
        }))
        return this.db.getNotices()
    }
}
