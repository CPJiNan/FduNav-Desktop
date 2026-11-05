import {randomUUID} from 'node:crypto'
import type {AppDatabase} from './database'
import {validateTodo} from '../shared/todos.ts'
import type {Todo} from '../shared/todos'

export class TodoService {
    private db: AppDatabase

    constructor(db: AppDatabase) {
        this.db = db
    }

    save(username: string, input: unknown): Todo {
        const result = validateTodo(input)
        if (!result.ok) throw new TodoError(result.error)
        const previous = result.data.id ? this.db.getTodo(username, result.data.id) : null
        if (result.data.id && !previous) throw new TodoError('待办不存在或已被删除。')
        const now = new Date().toISOString()
        const todo = {
            ...result.data,
            id: previous?.id ?? randomUUID(),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            ...(previous?.elearning ? {elearning: previous.elearning} : {})
        }
        this.db.saveTodo(username, todo)
        return todo
    }

    remove(username: string, id: unknown): null {
        if (typeof id !== 'string' || !this.db.getTodo(username, id)) throw new TodoError('待办不存在或已被删除。')
        this.db.removeTodo(username, id)
        return null
    }
}

export class TodoError extends Error {
}
