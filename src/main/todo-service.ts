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
        if (previous?.elearning) throw new TodoError('eLearning 作业由提交记录自动更新，请在学校平台操作后同步。')
        const now = new Date().toISOString()
        const todo = {
            ...result.data,
            id: previous?.id ?? randomUUID(),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now
        }
        this.db.saveTodo(username, todo)
        return todo
    }

    remove(username: string, id: unknown): null {
        if (typeof id !== 'string' || !this.db.getTodo(username, id)) throw new TodoError('待办不存在或已被删除。')
        if (this.db.getTodo(username, id)?.elearning) throw new TodoError('eLearning 作业由学校平台同步，不能在本地删除。')
        this.db.removeTodo(username, id)
        return null
    }
}

export class TodoError extends Error {
}
