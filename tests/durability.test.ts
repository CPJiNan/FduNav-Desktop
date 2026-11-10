import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {AppDatabase} from '../src/main/database.ts'

test('additive migration retains legacy conversation and trace survives database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fdunav-agent-test-')), path = join(directory, 'app.sqlite')
    try {
        const legacy = new DatabaseSync(path)
        legacy.exec('CREATE TABLE chat_conversations (username TEXT PRIMARY KEY, data TEXT NOT NULL)')
        const history = JSON.stringify([{id: 'old', user: '原消息', reply: '旧回复', cards: [], context: [{role: 'user', content: '原消息'}]}])
        legacy.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('alice', history); legacy.close()
        let db = new AppDatabase(path)
        assert.equal(db.getChatConversation('alice'), history); assert.deepEqual(db.getChatTrace('alice', 'old'), [])
        db.saveChatTrace('alice', 'old', [{id: 'trace', kind: 'tool', label: '工具调用', at: new Date().toISOString(), status: 'completed', details: {rawResponse: '原始响应'}}])
        db.saveCompaction('alice', {summary: '{"facts":[],"actions":[],"pending":[],"preferences":[]}', coversUpTo: 'old'})
        db.close(); db = new AppDatabase(path)
        assert.equal((db.getChatTrace('alice', 'old')[0].details as any).rawResponse, '原始响应')
        assert.equal(db.getCompaction('alice')?.coversUpTo, 'old'); assert.equal(db.getChatConversation('alice'), history)
        db.close()
    } finally {rmSync(directory, {recursive: true, force: true})}
})

test('legacy trace tables gain the kind column and an incremental step counter', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fdunav-agent-test-')), path = join(directory, 'legacy.sqlite')
    try {
        const legacy = new DatabaseSync(path)
        legacy.exec(`CREATE TABLE chat_traces (username TEXT NOT NULL, turn_id TEXT NOT NULL, event_id TEXT NOT NULL,
            position INTEGER NOT NULL, data TEXT NOT NULL, details TEXT, PRIMARY KEY (username, turn_id, event_id))`)
        legacy.prepare('INSERT INTO chat_traces VALUES (?, ?, ?, ?, ?, ?)').run('alice', 'turn', 'event', 0,
            JSON.stringify({id: 'event', kind: 'tool', label: '工具调用', at: 'now', status: 'completed'}), null)
        legacy.close()
        const db = new AppDatabase(path)
        try {
            assert.equal(db.getChatStats('alice').steps, 1)
            assert.equal(db.getChatTrace('alice', 'turn')[0].label, '工具调用')
        } finally {db.close()}
    } finally {rmSync(directory, {recursive: true, force: true})}
})
