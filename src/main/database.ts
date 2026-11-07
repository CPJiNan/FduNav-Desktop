import type {ChatTraceEvent} from '../shared/agent'
import type {Memory} from '../shared/memory'
import {validateMemory} from '../shared/memory'
import type {UsageSummary, UsageTotals} from '../shared/chat'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import type {Compaction} from './chat-context'
import {type AdditionalLlmPrompts, readAdditionalLlmPrompts} from '../shared/llm-prompts'
import type {Theme} from '../shared/accounts'
import {type CloseAction, isCloseAction} from '../shared/general-settings'
import {
    isNoticeRefreshInterval,
    isNoticeReminderMode,
    type NoticeRefreshInterval,
    type NoticeReminderMode
} from '../shared/notification-settings'
import type {Notice, NoticeList, NoticeRef, NoticeRelevanceChoice, ParsedNotice} from '../shared/notices'
import type {Timetable} from '../shared/timetable'
import type {CalendarEvent} from '../shared/calendar'
import {type CalendarReminderMinutes, isCalendarReminderMinutes} from '../shared/calendar-reminders'
import type {Todo} from '../shared/todos'
import {defaultSources, type MessageSource, type SourceId} from '../shared/sources.ts'
import {
    emptyMessagePreferences,
    type MessagePreferences,
    validateMessagePreferences
} from '../shared/message-preferences.ts'

const defaultSourceRank = new Map<string, number>(defaultSources.map((source, index) => [source.id, index]))

export interface ConsolidationGroupRecord {
    groupId: string
    before: Memory[]
    status: 'ok' | 'failed'
    merged?: Memory
    error?: string
    applied?: boolean
}

export interface ConsolidationRecord {
    id: string
    username: string
    createdAt: string
    status: 'preview' | 'applied' | 'undone' | 'discarded'
    before: Memory[]
    after: ConsolidationGroupRecord[]
    error?: string
}

export interface SavedAccount {
    username: string
    cookies: Uint8Array
    target: string
    last_login: string
}

export interface SavedLlmSettings extends AdditionalLlmPrompts {
    baseUrl: string;
    model: string;
    encryptedApiKey: Uint8Array | null
    summaryPrompt: string
}

export class AppDatabase {
    private db: DatabaseSync
    private transactionDepth = 0
    private commitCallbacks: (() => void)[] = []

    constructor(path: string) {
        this.db = new DatabaseSync(path)
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA secure_delete = ON;
            CREATE TABLE IF NOT EXISTS memories (
                username TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (username, id)
            );
            CREATE TABLE IF NOT EXISTS llm_usage (
                id INTEGER PRIMARY KEY, username TEXT NOT NULL, turn_id TEXT NOT NULL,
                model TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
                cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
                elapsed_ms INTEGER NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS llm_usage_owner_time ON llm_usage (username, created_at);
            CREATE TABLE IF NOT EXISTS chat_traces (
                username TEXT NOT NULL, turn_id TEXT NOT NULL, event_id TEXT NOT NULL,
                position INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, details TEXT,
                PRIMARY KEY (username, turn_id, event_id)
            );
            CREATE INDEX IF NOT EXISTS chat_traces_kind ON chat_traces (username, kind);
            CREATE TABLE IF NOT EXISTS chat_trace_stats (username TEXT PRIMARY KEY, steps INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS chat_payloads (
                username TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (username, hash)
            );
            CREATE TABLE IF NOT EXISTS chat_context_updates (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chat_context_updates_owner ON chat_context_updates (username, seq);
            CREATE TABLE IF NOT EXISTS chat_running_turns (
                username TEXT PRIMARY KEY, turn_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_compactions (username TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memory_consolidations (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL,
                status TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, error TEXT
            );
            CREATE INDEX IF NOT EXISTS memory_consolidations_owner ON memory_consolidations (username, created_at);
            CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chat_conversations (username TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS timetable_cache (
                username TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (username, kind)
            );
            CREATE TABLE IF NOT EXISTS calendar_events (
                username TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (username, id)
            );
            CREATE TABLE IF NOT EXISTS calendar_reminder_deliveries (
                username TEXT NOT NULL, event_id TEXT NOT NULL, remind_at INTEGER NOT NULL,
                PRIMARY KEY (username, event_id),
                FOREIGN KEY (username, event_id) REFERENCES calendar_events (username, id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS todos (
                username TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (username, id)
            );
            CREATE TABLE IF NOT EXISTS elearning_imports (
                username TEXT NOT NULL, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                PRIMARY KEY (username, course_id, assignment_id)
            );
            CREATE TABLE IF NOT EXISTS todo_reminder_deliveries (
                username TEXT NOT NULL, todo_id TEXT NOT NULL, remind_at INTEGER NOT NULL,
                PRIMARY KEY (username, todo_id),
                FOREIGN KEY (username, todo_id) REFERENCES todos (username, id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                username TEXT NOT NULL, cookies BLOB NOT NULL,
                target TEXT NOT NULL, last_login TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                revision INTEGER NOT NULL DEFAULT 1,
                list_url TEXT,
                updated_at TEXT,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS notices (
                source_id TEXT NOT NULL REFERENCES message_sources (id) ON DELETE CASCADE,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                published TEXT NOT NULL,
                PRIMARY KEY (source_id, url)
            );
            CREATE INDEX IF NOT EXISTS notices_published ON notices (published DESC);
            CREATE TABLE IF NOT EXISTS notice_reads (
                username TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL,
                PRIMARY KEY (username, source_id, url),
                FOREIGN KEY (source_id, url) REFERENCES notices (source_id, url) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS notice_relevance_choices (
                username TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL,
                relevance TEXT NOT NULL CHECK (relevance IN ('related', 'maybe', 'none')),
                PRIMARY KEY (username, source_id, url),
                FOREIGN KEY (source_id, url) REFERENCES notices (source_id, url) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS llm_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                base_url TEXT NOT NULL, model TEXT NOT NULL, api_key BLOB,
                summary_prompt TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS notice_summary_cache (
                source_id TEXT NOT NULL,
                url TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                model TEXT NOT NULL,
                summary TEXT NOT NULL,
                relevance TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (source_id, url, cache_key),
                FOREIGN KEY (source_id, url) REFERENCES notices (source_id, url) ON DELETE CASCADE
            );
        `)
        this.db.exec('PRAGMA foreign_keys = ON;')
        this.initializeSources()
    }

    saveChatTraceEvent(username: string, turnId: string, event: ChatTraceEvent, position: number) {
        const {details, ...data} = event
        const serialized = JSON.stringify(data)
        const detailJson = details === undefined ? null : JSON.stringify(details)
        const inserted = this.db.prepare(`INSERT INTO chat_traces (username, turn_id, event_id, position, kind, data, details)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username, turn_id, event_id) DO NOTHING`)
            .run(username, turnId, event.id, position, event.kind, serialized, detailJson)
        if (Number(inserted.changes) > 0) this.bumpSteps(username, event.kind === 'tool' ? 1 : 0)
        this.db.prepare(`UPDATE chat_traces SET position = ?, kind = ?, data = ?, details = COALESCE(?, details)
            WHERE username = ? AND turn_id = ? AND event_id = ?`)
            .run(position, event.kind, serialized, detailJson, username, turnId, event.id)
    }

    saveChatTrace(username: string, turnId: string, events: ChatTraceEvent[]) {
        events.forEach((event, index) => this.saveChatTraceEvent(username, turnId, event, index))
    }

    getChatTrace(username: string, turnId: string): ChatTraceEvent[] {
        return this.db.prepare('SELECT data, details FROM chat_traces WHERE username = ? AND turn_id = ? ORDER BY position')
            .all(username, turnId).map(row => ({
                ...JSON.parse(String(row.data)),
                ...(row.details === null ? {} : {details: JSON.parse(String(row.details))})
            })).map(event => this.hydrateChatTrace(username, event))
    }

    saveChatPayload(username: string, value: unknown): string {
        const data = JSON.stringify(value)
        const hash = createHash('sha256').update(data).digest('hex')
        this.db.prepare('INSERT OR IGNORE INTO chat_payloads (username, hash, data) VALUES (?, ?, ?)').run(username, hash, data)
        return hash
    }

    getChatPayload(username: string, hash: string): unknown {
        const row = this.db.prepare('SELECT data FROM chat_payloads WHERE username = ? AND hash = ?').get(username, hash)
        if (!row) throw new Error('模型请求快照缺失。')
        return JSON.parse(String(row.data))
    }

    saveChatModelRequest(username: string, body: Record<string, unknown>): string {
        const {messages, tools, ...options} = body
        return this.saveChatPayload(username, {
            ...options,
            messageRefs: (messages as unknown[]).map(message => this.saveChatPayload(username, message)),
            ...(tools === undefined ? {} : {toolsRef: this.saveChatPayload(username, tools)})
        })
    }

    hydrateChatTrace(username: string, event: ChatTraceEvent): ChatTraceEvent {
        if (!event.details || typeof event.details !== 'object' || !['model', 'compaction'].includes(event.kind)) return event
        const {requestRefs, rawResponseRefs, responseRef, ...details} = event.details as Record<string, unknown>
        return {
            ...event, details: {
                ...details,
                ...(Array.isArray(requestRefs) ? {
                    requests: requestRefs.map(ref => {
                        const {
                            messageRefs,
                            toolsRef,
                            ...options
                        } = this.getChatPayload(username, String(ref)) as Record<string, unknown>
                        return {
                            ...options,
                            messages: (messageRefs as string[]).map(id => this.getChatPayload(username, id)),
                            ...(typeof toolsRef === 'string' ? {tools: this.getChatPayload(username, toolsRef)} : {})
                        }
                    })
                } : {}),
                ...(Array.isArray(rawResponseRefs) ? {rawResponses: rawResponseRefs.map(ref => this.getChatPayload(username, String(ref)))} : {}),
                ...(typeof responseRef === 'string' ? {response: this.getChatPayload(username, responseRef)} : {}),
            }
        }
    }

    appendChatContextUpdate(username: string, value: unknown) {
        this.db.prepare('INSERT INTO chat_context_updates (username, data) VALUES (?, ?)').run(username, JSON.stringify(value))
    }

    getChatContextUpdates(username: string, after = 0): Array<{ seq: number; data: unknown }> {
        return this.db.prepare('SELECT seq, data FROM chat_context_updates WHERE username = ? AND seq > ? ORDER BY seq')
            .all(username, after).map(row => ({seq: Number(row.seq), data: JSON.parse(String(row.data))}))
    }

    clearChatContextUpdates(username: string) {
        this.db.prepare('DELETE FROM chat_context_updates WHERE username = ?').run(username)
    }

    getChatTraceMetadata(username: string, turnId: string): Array<Omit<ChatTraceEvent, 'details'> & {
        hasDetails: boolean
    }> {
        return this.db.prepare('SELECT data, details IS NOT NULL AS has_details FROM chat_traces WHERE username = ? AND turn_id = ? ORDER BY position')
            .all(username, turnId).map(row => ({
                ...JSON.parse(String(row.data)),
                hasDetails: Number(row.has_details) === 1
            }))
    }

    clearChatTrace(username: string) {
        this.db.prepare('DELETE FROM chat_traces WHERE username = ?').run(username)
        this.db.prepare('DELETE FROM chat_trace_stats WHERE username = ?').run(username)
        this.db.prepare('DELETE FROM chat_payloads WHERE username = ?').run(username)
    }

    removeChatTrace(username: string, turnId: string) {
        this.db.prepare('DELETE FROM chat_traces WHERE username = ? AND turn_id = ?').run(username, turnId)
        const steps = this.db.prepare("SELECT COUNT(*) AS n FROM chat_traces WHERE username = ? AND kind = 'tool'").get(username)!
        this.db.prepare(`INSERT INTO chat_trace_stats (username, steps) VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET steps = excluded.steps`).run(username, Number(steps.n))
    }

    pruneChatTrace(username: string, keepTurns?: number) {
        if (keepTurns === undefined) return
        this.db.prepare(`DELETE FROM chat_traces WHERE username = ? AND turn_id NOT IN (
            SELECT turn_id FROM (SELECT turn_id, MAX(rowid) AS last FROM chat_traces WHERE username = ?
                GROUP BY turn_id ORDER BY last DESC LIMIT ?))`).run(username, username, keepTurns)
        const steps = this.db.prepare("SELECT COUNT(*) AS n FROM chat_traces WHERE username = ? AND kind = 'tool'").get(username)!
        this.db.prepare(`INSERT INTO chat_trace_stats (username, steps) VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET steps = excluded.steps`).run(username, Number(steps.n))
    }

    saveRunningTurn(username: string, turnId: string, position: number, data: string) {
        this.db.prepare(`INSERT INTO chat_running_turns (username, turn_id, position, data) VALUES (?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET turn_id = excluded.turn_id, position = excluded.position, data = excluded.data`)
            .run(username, turnId, position, data)
    }

    getRunningTurn(username: string): { turnId: string; position: number; data: string } | null {
        const row = this.db.prepare('SELECT turn_id, position, data FROM chat_running_turns WHERE username = ?').get(username)
        return row ? {turnId: String(row.turn_id), position: Number(row.position), data: String(row.data)} : null
    }

    clearRunningTurn(username: string) {
        this.db.prepare('DELETE FROM chat_running_turns WHERE username = ?').run(username)
    }

    afterCommit(action: () => void) {
        if (this.transactionDepth) this.commitCallbacks.push(action)
        else action()
    }

    transaction<T>(action: () => T): T {
        const start = this.commitCallbacks.length
        this.db.exec('SAVEPOINT agent_write')
        this.transactionDepth++
        let result: T
        try {
            result = action()
            this.db.exec('RELEASE agent_write')
        } catch (error) {
            this.db.exec('ROLLBACK TO agent_write');
            this.db.exec('RELEASE agent_write')
            this.commitCallbacks.splice(start);
            this.transactionDepth--
            throw error
        }
        this.transactionDepth--
        if (!this.transactionDepth) for (const callback of this.commitCallbacks.splice(0)) {
            try {
                callback()
            } catch {
                console.warn('数据已保存，提醒刷新失败，将在下次定时检查时重试。')
            }
        }
        return result
    }

    getMemories(username: string): Memory[] {
        return this.db.prepare('SELECT data FROM memories WHERE username = ? ORDER BY id').all(username)
            .map(row => JSON.parse(String(row.data)) as Memory)
    }

    getMemoryEnabled(username: string): boolean {
        return this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(`memory_enabled:${username}`)?.value === 'true'
    }

    setMemoryEnabled(username: string, enabled: boolean) {
        this.db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(`memory_enabled:${username}`, JSON.stringify(enabled))
    }

    saveMemory(username: string, memory: Memory) {
        const checked = validateMemory(memory)
        if (!checked.ok) throw new Error(checked.error)
        this.db.prepare('INSERT INTO memories (username, id, data) VALUES (?, ?, ?) ON CONFLICT(username, id) DO UPDATE SET data = excluded.data')
            .run(username, memory.id, JSON.stringify(memory))
    }

    removeMemory(username: string, id: string) {
        this.db.prepare('DELETE FROM memories WHERE username = ? AND id = ?').run(username, id)
    }

    saveConsolidation(record: ConsolidationRecord) {
        this.db.prepare(`INSERT INTO memory_consolidations (id, username, created_at, status, before, after, error)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, after = excluded.after, error = excluded.error`)
            .run(record.id, record.username, record.createdAt, record.status, JSON.stringify(record.before),
                JSON.stringify(record.after), record.error ?? null)
    }

    getConsolidation(username: string, id: string): ConsolidationRecord | null {
        const row = this.db.prepare('SELECT * FROM memory_consolidations WHERE username = ? AND id = ?').get(username, id)
        if (!row) return null
        return {
            id: String(row.id), username: String(row.username), createdAt: String(row.created_at),
            status: String(row.status) as ConsolidationRecord['status'],
            before: JSON.parse(String(row.before)) as Memory[],
            after: JSON.parse(String(row.after)) as ConsolidationGroupRecord[],
            ...(row.error === null ? {} : {error: String(row.error)}),
        }
    }

    findConsolidationPreview(username: string): ConsolidationRecord | null {
        const row = this.db.prepare(`SELECT id FROM memory_consolidations WHERE username = ? AND status = 'preview'
            ORDER BY created_at DESC LIMIT 1`).get(username)
        return row ? this.getConsolidation(username, String(row.id)) : null
    }

    setConsolidationStatus(username: string, id: string, status: ConsolidationRecord['status']) {
        this.db.prepare('UPDATE memory_consolidations SET status = ? WHERE username = ? AND id = ?').run(status, username, id)
    }

    pruneConsolidations(username: string, before: string) {
        this.db.prepare("DELETE FROM memory_consolidations WHERE username = ? AND status = 'preview' AND created_at < ?")
            .run(username, before)
    }

    getCompaction(username: string): Compaction | null {
        const row = this.db.prepare('SELECT data FROM chat_compactions WHERE username = ?').get(username)
        return row ? JSON.parse(String(row.data)) : null
    }

    saveCompaction(username: string, value: Compaction | null) {
        if (!value) this.db.prepare('DELETE FROM chat_compactions WHERE username = ?').run(username)
        else this.db.prepare('INSERT INTO chat_compactions (username, data) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET data = excluded.data')
            .run(username, JSON.stringify(value))
    }

    clearLlmUsage(username: string) {
        this.db.prepare('DELETE FROM llm_usage WHERE username = ?').run(username)
    }

    recordLlmUsage(username: string, turnId: string, model: string,
                   usage: {
                       promptTokens: number | null; completionTokens: number | null;
                       cacheHitTokens?: number | null; cacheMissTokens?: number | null
                   }, elapsedMs: number) {
        this.db.prepare('INSERT INTO llm_usage (username, turn_id, model, prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, elapsed_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(username, turnId, model, usage.promptTokens, usage.completionTokens,
                usage.cacheHitTokens ?? null, usage.cacheMissTokens ?? null, Math.round(elapsedMs), new Date().toISOString())
    }

    getChatStats(username: string) {
        const usage = this.db.prepare(`SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit, COALESCE(SUM(elapsed_ms), 0) AS elapsed
            FROM llm_usage WHERE username = ?`).get(username)!
        const last = this.db.prepare('SELECT prompt_tokens FROM llm_usage WHERE username = ? ORDER BY id DESC LIMIT 1').get(username)
        const steps = this.db.prepare('SELECT steps FROM chat_trace_stats WHERE username = ?').get(username)
        const saved = this.db.prepare('SELECT data FROM chat_conversations WHERE username = ?').get(username)
        const turns = saved ? (JSON.parse(String(saved.data)) as unknown[]).length : 0
        return {
            turns, steps: steps ? Number(steps.steps) : 0, requests: Number(usage.requests),
            promptTokens: Number(usage.prompt), completionTokens: Number(usage.completion),
            cacheHitTokens: Number(usage.cache_hit), elapsedMs: Number(usage.elapsed),
            lastPromptTokens: last ? Number(last.prompt_tokens ?? 0) : 0
        }
    }

    getUsage(username: string, now = new Date()): UsageSummary {
        const date = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'})
        const rows = this.db.prepare('SELECT prompt_tokens, completion_tokens, elapsed_ms, created_at FROM llm_usage WHERE username = ? AND created_at >= ?')
            .all(username, new Date(`${date.slice(0, 7)}-01T00:00:00+08:00`).toISOString())
        const sum = (today: boolean): UsageTotals => rows.reduce<UsageTotals>((total, row) => {
            if (today && new Date(String(row.created_at)).toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'}) !== date) return total
            total.requests++;
            total.elapsedMs += Number(row.elapsed_ms)
            total.promptTokens += Number(row.prompt_tokens ?? 0);
            total.completionTokens += Number(row.completion_tokens ?? 0)
            if (row.prompt_tokens === null || row.completion_tokens === null) total.missingUsage++
            return total
        }, {promptTokens: 0, completionTokens: 0, elapsedMs: 0, requests: 0, missingUsage: 0})
        return {today: sum(true), month: sum(false)}
    }

    getTodos(username: string): Todo[] {
        return this.db.prepare('SELECT data FROM todos WHERE username = ?').all(username)
            .map(row => JSON.parse(row.data as string) as Todo)
    }

    getTodo(username: string, id: string): Todo | null {
        const row = this.db.prepare('SELECT data FROM todos WHERE username = ? AND id = ?').get(username, id)
        return row ? JSON.parse(row.data as string) as Todo : null
    }

    saveTodo(username: string, todo: Todo) {
        this.db.prepare(`INSERT INTO todos (username, id, data)
                         VALUES (?, ?, ?) ON CONFLICT(username, id) DO
        UPDATE SET data = excluded.data`).run(username, todo.id, JSON.stringify(todo))
    }

    removeTodo(username: string, id: string) {
        this.db.prepare('DELETE FROM todos WHERE username = ? AND id = ?').run(username, id)
    }

    hasElearningImport(username: string, courseId: string, assignmentId: string): boolean {
        return !!this.db.prepare('SELECT 1 FROM elearning_imports WHERE username = ? AND course_id = ? AND assignment_id = ?')
            .get(username, courseId, assignmentId)
    }

    markElearningImport(username: string, courseId: string, assignmentId: string, importedAt: string) {
        this.db.prepare(`INSERT INTO elearning_imports (username, course_id, assignment_id, imported_at)
                         VALUES (?, ?, ?, ?) ON CONFLICT(username, course_id, assignment_id) DO NOTHING`)
            .run(username, courseId, assignmentId, importedAt)
    }

    todoReminderDelivered(username: string, id: string, remindAt: number): boolean {
        return !!this.db.prepare('SELECT 1 FROM todo_reminder_deliveries WHERE username = ? AND todo_id = ? AND remind_at = ?')
            .get(username, id, remindAt)
    }

    markTodoReminderDelivered(username: string, id: string, remindAt: number) {
        this.db.prepare(`INSERT INTO todo_reminder_deliveries (username, todo_id, remind_at)
                         VALUES (?, ?, ?) ON CONFLICT(username, todo_id) DO
        UPDATE SET remind_at = excluded.remind_at`).run(username, id, remindAt)
    }

    clearTodoReminderDelivery(username: string, id: string, remindAt: number) {
        this.db.prepare('DELETE FROM todo_reminder_deliveries WHERE username = ? AND todo_id = ? AND remind_at = ?')
            .run(username, id, remindAt)
    }

    getLlmSettings(): SavedLlmSettings | null {
        const saved = this.db.prepare('SELECT base_url AS baseUrl, model, api_key AS encryptedApiKey, summary_prompt AS summaryPrompt FROM llm_settings WHERE id = 1')
            .get() as unknown as SavedLlmSettings | undefined
        if (!saved) return null
        let prompts: unknown
        try {
            prompts = JSON.parse(String(this.db.prepare("SELECT value FROM preferences WHERE key = 'llm_prompts'").get()?.value ?? 'null'))
        } catch {
        }
        return {...saved, ...readAdditionalLlmPrompts(prompts)}
    }

    getLlmEnabled(): boolean {
        return this.db.prepare("SELECT value FROM preferences WHERE key = 'llm_enabled'").get()?.value === 'true'
    }

    setLlmEnabled(enabled: boolean) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('llm_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify(enabled))
    }

    saveLlmSettings(value: SavedLlmSettings) {
        this.db.exec('SAVEPOINT save_llm_settings')
        try {
            this.db.prepare(`INSERT INTO llm_settings (id, base_url, model, api_key, summary_prompt)
                             VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO
            UPDATE SET base_url = excluded.base_url, model = excluded.model, api_key = excluded.api_key,
                summary_prompt = excluded.summary_prompt`)
                .run(value.baseUrl, value.model, value.encryptedApiKey, value.summaryPrompt)
            const {chatPrompt, connectionTestPrompt, toolDescriptions} = value
            this.db.prepare("INSERT INTO preferences (key, value) VALUES ('llm_prompts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .run(JSON.stringify({chatPrompt, connectionTestPrompt, toolDescriptions}))
            this.db.exec('RELEASE save_llm_settings')
        } catch (error) {
            this.db.exec('ROLLBACK TO save_llm_settings')
            this.db.exec('RELEASE save_llm_settings')
            throw error
        }
    }

    getAccount(): SavedAccount | null {
        return (this.db.prepare('SELECT username, cookies, target, last_login FROM account WHERE id = 1').get() as unknown as SavedAccount) ?? null
    }

    saveAccount(account: SavedAccount) {
        this.db.prepare(`INSERT INTO account (id, username, cookies, target, last_login)
                         VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO
        UPDATE SET username = excluded.username, cookies = excluded.cookies,
            target = excluded.target, last_login = excluded.last_login`).run(account.username, account.cookies, account.target, account.last_login)
    }

    clearAccount() {
        this.db.exec('DELETE FROM account; DELETE FROM timetable_cache; PRAGMA wal_checkpoint(TRUNCATE);')
    }

    getTimetable(username: string, kind: Timetable['kind']): Timetable | null {
        const row = this.db.prepare('SELECT data FROM timetable_cache WHERE username = ? AND kind = ?').get(username, kind)
        if (!row) return null
        try {
            return JSON.parse(String(row.data)) as Timetable
        } catch {
            return null
        }
    }

    saveTimetable(username: string, timetable: Timetable) {
        this.db.prepare('INSERT INTO timetable_cache (username, kind, data) VALUES (?, ?, ?) ON CONFLICT(username, kind) DO UPDATE SET data = excluded.data')
            .run(username, timetable.kind, JSON.stringify(timetable))
    }

    getTheme(): Theme | null {
        const value = this.db.prepare("SELECT value FROM preferences WHERE key = 'theme'").get()?.value
        return value === 'light' || value === 'dark' || value === 'auto' ? value : null
    }

    getCloseAction(): CloseAction {
        const value = this.db.prepare("SELECT value FROM preferences WHERE key = 'close_action'").get()?.value
        return isCloseAction(value) ? value : 'tray'
    }

    getNoticeRefreshInterval(): NoticeRefreshInterval {
        const value = Number(this.db.prepare("SELECT value FROM preferences WHERE key = 'notice_refresh_interval'").get()?.value)
        return isNoticeRefreshInterval(value) ? value : 0
    }

    getCalendarDefaultReminder(): CalendarReminderMinutes {
        const stored = this.db.prepare("SELECT value FROM preferences WHERE key = 'calendar_default_reminder'").get()?.value
        const value = stored === undefined ? undefined : Number(stored)
        return isCalendarReminderMinutes(value) ? value : 30
    }

    getTodoDefaultReminder(): CalendarReminderMinutes {
        const stored = this.db.prepare("SELECT value FROM preferences WHERE key = 'todo_default_reminder'").get()?.value
        const value = stored === undefined ? undefined : Number(stored)
        return isCalendarReminderMinutes(value) ? value : 120
    }

    setTodoDefaultReminder(minutes: CalendarReminderMinutes) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('todo_default_reminder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(minutes))
    }

    setCalendarDefaultReminder(minutes: CalendarReminderMinutes) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('calendar_default_reminder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(minutes))
    }

    getNoticeReminderMode(): NoticeReminderMode {
        const value = this.db.prepare("SELECT value FROM preferences WHERE key = 'notice_reminder_mode'").get()?.value
        return isNoticeReminderMode(value) ? value : 'all'
    }

    setNoticeReminderMode(mode: NoticeReminderMode) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('notice_reminder_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(mode)
    }

    getNoticeAutoSummary(): boolean {
        return this.db.prepare("SELECT value FROM preferences WHERE key = 'notice_auto_summary'").get()?.value === 'true'
    }

    setNoticeAutoSummary(enabled: boolean) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('notice_auto_summary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(enabled))
    }

    setNoticeRefreshInterval(interval: NoticeRefreshInterval) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('notice_refresh_interval', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(interval))
    }

    setCloseAction(action: CloseAction) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('close_action', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(action)
    }

    getChatConversation(username: string): string | null {
        const row = this.db.prepare('SELECT data FROM chat_conversations WHERE username = ?').get(username)
        return row ? String(row.data) : null
    }

    saveChatConversation(username: string, data: string) {
        this.db.prepare('INSERT INTO chat_conversations (username, data) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET data = excluded.data')
            .run(username, data)
    }

    getCalendarEvents(username: string): CalendarEvent[] {
        return this.db.prepare('SELECT data FROM calendar_events WHERE username = ? ORDER BY id').all(username)
            .map(row => JSON.parse(String(row.data)) as CalendarEvent)
    }

    hasCalendarEvent(username: string, id: string) {
        return !!this.db.prepare('SELECT 1 FROM calendar_events WHERE username = ? AND id = ?').get(username, id)
    }

    calendarReminderDelivered(username: string, id: string, remindAt: number): boolean {
        return !!this.db.prepare('SELECT 1 FROM calendar_reminder_deliveries WHERE username = ? AND event_id = ? AND remind_at = ?')
            .get(username, id, remindAt)
    }

    markCalendarReminderDelivered(username: string, id: string, remindAt: number) {
        this.db.prepare(`INSERT INTO calendar_reminder_deliveries (username, event_id, remind_at)
                         VALUES (?, ?, ?) ON CONFLICT(username, event_id) DO
        UPDATE SET remind_at = excluded.remind_at`).run(username, id, remindAt)
    }

    clearCalendarReminderDelivery(username: string, id: string, remindAt: number) {
        this.db.prepare('DELETE FROM calendar_reminder_deliveries WHERE username = ? AND event_id = ? AND remind_at = ?')
            .run(username, id, remindAt)
    }

    saveCalendarEvent(username: string, event: CalendarEvent) {
        this.db.prepare('INSERT INTO calendar_events (username, id, data) VALUES (?, ?, ?) ON CONFLICT(username, id) DO UPDATE SET data = excluded.data')
            .run(username, event.id, JSON.stringify(event))
    }

    getCalendarEvent(username: string, id: string): CalendarEvent | null {
        const row = this.db.prepare('SELECT data FROM calendar_events WHERE username = ? AND id = ?').get(username, id)
        return row ? JSON.parse(String(row.data)) as CalendarEvent : null
    }

    removeCalendarEvent(username: string, id: string) {
        this.db.prepare('DELETE FROM calendar_events WHERE username = ? AND id = ?').run(username, id)
    }

    setTheme(theme: Theme) {
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(theme)
    }

    getMessagePreferences(): MessagePreferences {
        const row = this.db.prepare("SELECT value FROM preferences WHERE key = 'message_preferences'").get()
        if (!row) return emptyMessagePreferences()
        const result = validateMessagePreferences(JSON.parse(String(row.value)))
        if (!result.ok) throw new Error('Invalid saved message preferences')
        return result.data
    }

    setMessagePreferences(input: MessagePreferences): MessagePreferences {
        const result = validateMessagePreferences(input)
        if (!result.ok) throw new Error(result.error)
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('message_preferences', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify(result.data))
        return result.data
    }

    hasUnreadNotices(username: string): boolean {
        return !!this.db.prepare(`SELECT 1
                                  FROM notices n
                                           JOIN message_sources s ON s.id = n.source_id
                                  WHERE s.enabled = 1
                                    AND NOT EXISTS (SELECT 1
                                                    FROM notice_reads r
                                                    WHERE r.username = ?
                                                      AND r.source_id = n.source_id
                                                      AND r.url = n.url)
                                      LIMIT 1`).get(username)
    }

    getNotices(username = this.getAccount()?.username ?? ''): NoticeList {
        const rows = this.db.prepare(`SELECT n.url,
                                             n.title,
                                             n.published,
                                             n.source_id AS sourceId,
                                             s.name      AS sourceName,
                                             r.url IS NOT NULL AS read
                                      FROM notices n
                                          JOIN message_sources s
                                      ON s.id = n.source_id
                                          LEFT JOIN notice_reads r ON r.source_id = n.source_id AND r.url = n.url AND r.username = ?
                                      WHERE s.enabled = 1
                                      ORDER BY n.published
                                          DESC, n.title, n.source_id`).all(username) as unknown as (Omit<Notice, 'read'> & {
            read: number
        })[]
        const items = rows.map(row => ({...row, read: !!row.read}))
        const sources = this.getSources()
        const updatedAt = sources.filter(source => source.enabled && source.updatedAt).map(source => source.updatedAt!).sort().at(-1) ?? null
        return {items, updatedAt, sources}
    }

    hasNotice(url: string, sourceId: string) {
        return !!this.db.prepare('SELECT 1 FROM notices WHERE url = ? AND source_id = ?').get(url, sourceId)
    }

    getNotice(sourceId: string, url: string, username = this.getAccount()?.username ?? ''): Notice | null {
        const row = this.db.prepare(`SELECT n.url,
                                            n.title,
                                            n.published,
                                            n.source_id AS sourceId,
                                            s.name      AS sourceName,
                                            r.url IS NOT NULL AS read
                                     FROM notices n
                                         JOIN message_sources s
                                     ON s.id = n.source_id
                                         LEFT JOIN notice_reads r ON r.source_id = n.source_id AND r.url = n.url AND r.username = ?
                                     WHERE n.source_id = ?
                                       AND n.url = ?`).get(username, sourceId, url) as unknown as (Omit<Notice, 'read'> & {
            read: number
        }) | undefined
        return row ? {...row, read: !!row.read} : null
    }

    markNoticeRead(username: string, sourceId: string, url: string) {
        this.db.prepare(`INSERT INTO notice_reads (username, source_id, url)
                         VALUES (?, ?,
                                 ?) ON CONFLICT(username, source_id, url) DO NOTHING`).run(username, sourceId, url)
    }

    markNoticesRead(username: string, notices: NoticeRef[]) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const notice of notices) this.markNoticeRead(username, notice.sourceId, notice.url)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    getNoticeRelevanceChoice(username: string, sourceId: string, url: string): NoticeRelevanceChoice | null {
        const row = this.db.prepare('SELECT relevance FROM notice_relevance_choices WHERE username = ? AND source_id = ? AND url = ?')
            .get(username, sourceId, url)
        return row ? row.relevance as NoticeRelevanceChoice : null
    }

    setNoticeRelevanceChoice(username: string, sourceId: string, url: string, relevance: NoticeRelevanceChoice) {
        this.db.prepare(`INSERT INTO notice_relevance_choices (username, source_id, url, relevance)
                         VALUES (?, ?, ?, ?) ON CONFLICT(username, source_id, url) DO
        UPDATE SET relevance = excluded.relevance`)
            .run(username, sourceId, url, relevance)
    }

    getNoticeSummary(sourceId: string, url: string, cacheKey: string): {
        model: string;
        summary: string;
        relevance: string
    } | null {
        return this.db.prepare(`SELECT model, summary, relevance
                                FROM notice_summary_cache
                                WHERE source_id = ?
                                  AND url = ?
                                  AND cache_key = ?`)
            .get(sourceId, url, cacheKey) as unknown as {
            model: string;
            summary: string;
            relevance: string
        } ?? null
    }

    saveNoticeSummary(sourceId: string, url: string, cacheKey: string, model: string, summary: string,
                      relevance: string) {
        this.db.prepare(`INSERT INTO notice_summary_cache (source_id, url, cache_key, model, summary, relevance, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, url, cache_key) DO
        UPDATE SET model = excluded.model,
            summary = excluded.summary,
            relevance = excluded.relevance,
            created_at = excluded.created_at`)
            .run(sourceId, url, cacheKey, model, summary, relevance, new Date().toISOString())
    }

    saveNotices(items: ParsedNotice[], sourceId: string, expectedRevision?: number, listUrl?: string) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const source = this.getSource(sourceId)
            if (!source?.enabled || (expectedRevision !== undefined && source.revision !== expectedRevision)) {
                this.db.exec('ROLLBACK')
                return false
            }
            const insert = this.db.prepare(`INSERT INTO notices (source_id, url, title, published)
                                            VALUES (?, ?, ?, ?) ON CONFLICT(source_id, url) DO
            UPDATE SET title = excluded.title, published = excluded.published`)
            for (const item of items) {
                insert.run(sourceId, item.url, item.title, item.published)
            }
            this.db.prepare('UPDATE message_sources SET updated_at = ?, last_error = NULL, list_url = COALESCE(?, list_url) WHERE id = ?')
                .run(new Date().toISOString(), listUrl ?? null, sourceId)
            this.db.prepare(`DELETE
                             FROM notices
                             WHERE source_id = ?
                               AND url NOT IN
                                   (SELECT url FROM notices WHERE source_id = ? ORDER BY published DESC, title
                                 LIMIT 200)`).run(sourceId, sourceId)
            this.db.exec('COMMIT')
            return true
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error
        }
    }

    getSources(): MessageSource[] {
        const saved = this.db.prepare("SELECT value FROM preferences WHERE key = 'source_order'").get()
        const ids = saved ? JSON.parse(saved.value as string) as string[] : []
        const rank = new Map(ids.map((id, index) => [id, index]))
        return (this.db.prepare(`SELECT id,
                                        name,
                                        url,
                                        enabled,
                                        revision,
                                        list_url   AS listUrl,
                                        updated_at AS updatedAt,
                                        last_error AS lastError
                                 FROM message_sources
                                 ORDER BY rowid`).all()
            .map(row => ({...row, enabled: row.enabled === 1})) as unknown as MessageSource[])
            .sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length) ||
                (defaultSourceRank.get(a.id) ?? defaultSources.length) -
                (defaultSourceRank.get(b.id) ?? defaultSources.length))
    }

    reorderSources(ids: SourceId[]): MessageSource[] {
        const sources = this.getSources()
        if (ids.length !== sources.length || new Set(ids).size !== ids.length ||
            ids.some(id => !sources.some(source => source.id === id))) throw new Error('消息来源排序无效。')
        this.db.prepare("INSERT INTO preferences (key, value) VALUES ('source_order', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify(ids))
        return this.getSources()
    }

    getSource(id: string): MessageSource | undefined {
        return this.getSources().find(source => source.id === id)
    }

    setSourceEnabled(id: SourceId, enabled: boolean): MessageSource[] {
        this.db.prepare('UPDATE message_sources SET enabled = ? WHERE id = ?').run(Number(enabled), id)
        return this.getSources()
    }

    setSourceError(id: string, revision: number, error: string) {
        this.db.prepare('UPDATE message_sources SET last_error = ? WHERE id = ? AND revision = ? AND enabled = 1')
            .run(error.slice(0, 500), id, revision)
    }

    close() {
        this.db.close()
    }

    private bumpSteps(username: string, delta: number) {
        if (!delta) return
        this.db.prepare(`INSERT INTO chat_trace_stats (username, steps) VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET steps = steps + excluded.steps`).run(username, delta)
    }

    private initializeSources() {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const insert = this.db.prepare(`INSERT INTO message_sources (id, name, url, enabled)
                                            VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
            for (const source of defaultSources) {
                insert.run(source.id, source.name, source.url, Number(source.enabled))
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }
}
