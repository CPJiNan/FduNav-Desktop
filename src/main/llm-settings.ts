import type {AppDatabase} from './database'
import {emptyLlmSettings, type LlmSettings, validateLlmSettings} from '../shared/llm.ts'

export interface SecretStorage {
    available(): Promise<boolean>

    encrypt(value: string): Promise<Uint8Array>

    decrypt(value: Uint8Array): Promise<string>
}

export class LlmSettingsService {
    private db: AppDatabase
    private secrets: SecretStorage
    private requests = new AbortController()
    private saving = false

    constructor(db: AppDatabase, secrets: SecretStorage) {
        this.db = db
        this.secrets = secrets
    }

    get(): LlmSettings {
        const saved = this.db.getLlmSettings()
        return {
            ...(saved ? {
                baseUrl: saved.baseUrl,
                model: saved.model,
                summaryPrompt: saved.summaryPrompt,
                chatPrompt: saved.chatPrompt,
                connectionTestPrompt: saved.connectionTestPrompt,
                toolDescriptions: saved.toolDescriptions,
                hasApiKey: !!saved.encryptedApiKey?.length
            } : emptyLlmSettings()),
            enabled: this.db.getLlmEnabled()
        }
    }

    setEnabled(enabled: unknown): LlmSettings {
        if (typeof enabled !== 'boolean') throw new Error('LLM 启用状态无效。')
        this.db.setLlmEnabled(enabled)
        if (!enabled) this.requests.abort('settings_changed')
        else if (this.requests.signal.aborted) this.requests = new AbortController()
        return this.get()
    }

    getRequestSignal(): AbortSignal {
        this.assertEnabled()
        return this.requests.signal
    }

    async save(input: unknown): Promise<LlmSettings> {
        if (this.saving) throw new Error('正在保存 LLM 设置，请等待完成。')
        this.saving = true
        try {
            return await this.saveSettings(input)
        } finally {
            this.saving = false
        }
    }


    async getConnection(): Promise<{ baseUrl: string; model: string; apiKey: string }> {
        const signal = this.getRequestSignal()
        const saved = this.db.getLlmSettings()
        if (!saved) throw new Error('请先配置 LLM。')
        let apiKey = ''
        if (saved.encryptedApiKey?.length) {
            if (!await this.storageAvailable()) throw new Error('系统安全存储不可用。')
            try {
                apiKey = await this.secrets.decrypt(saved.encryptedApiKey)
            } catch {
                throw new Error('无法解密 API Key，请在 LLM 设置中重新保存。')
            }
        }
        if (signal.aborted) throw new Error('LLM 已停用，请重新发起请求。')
        return {baseUrl: saved.baseUrl, model: saved.model, apiKey}
    }

    async getDraftConnection(input: unknown, requireModel = true): Promise<{
        baseUrl: string;
        model: string;
        apiKey: string
    }> {
        this.assertEnabled()
        const result = validateLlmSettings(input, requireModel)
        if (!result.ok) throw new Error(result.error)
        const {baseUrl, model, apiKey, clearApiKey} = result.data
        const saved = this.db.getLlmSettings()
        if (apiKey || clearApiKey || !saved?.encryptedApiKey?.length) {
            return {baseUrl, model, apiKey: clearApiKey ? '' : apiKey}
        }
        if (new URL(saved.baseUrl).origin !== new URL(baseUrl).origin) {
            throw new Error('更换接口站点时，请重新输入 API Key 或勾选清除已保存的密钥。')
        }
        return {baseUrl, model, apiKey: (await this.getConnection()).apiKey}
    }

    private assertEnabled() {
        if (!this.db.getLlmEnabled()) throw new Error('LLM 已停用，请先启用。')
    }

    private async storageAvailable(): Promise<boolean> {
        try {
            return await this.secrets.available()
        } catch {
            return false
        }
    }

    private async saveSettings(input: unknown): Promise<LlmSettings> {
        const result = validateLlmSettings(input)
        if (!result.ok) throw new Error(result.error)
        const value = result.data
        const saved = this.db.getLlmSettings()
        if (saved?.encryptedApiKey?.length && new URL(saved.baseUrl).origin !== new URL(value.baseUrl).origin &&
            !value.apiKey && !value.clearApiKey) {
            throw new Error('更换接口站点时，请重新输入 API Key 或勾选清除已保存的密钥。')
        }
        let encryptedApiKey = value.clearApiKey ? null : saved?.encryptedApiKey ?? null
        if (value.apiKey) {
            if (!await this.storageAvailable()) throw new Error('系统安全存储不可用，无法保存 API Key。')
            try {
                encryptedApiKey = await this.secrets.encrypt(value.apiKey)
            } catch {
                throw new Error('API Key 加密失败，设置未保存。')
            }
        }
        this.db.saveLlmSettings({
            baseUrl: value.baseUrl,
            model: value.model,
            encryptedApiKey,
            summaryPrompt: value.summaryPrompt,
            chatPrompt: value.chatPrompt,
            connectionTestPrompt: value.connectionTestPrompt,
            toolDescriptions: value.toolDescriptions,
        })
        this.requests.abort('settings_changed')
        if (this.db.getLlmEnabled()) this.requests = new AbortController()
        return this.get()
    }
}
