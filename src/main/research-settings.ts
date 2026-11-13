import type {AppDatabase} from './database'
import type {SecretStorage} from './llm-settings'
import {
    type CampusState,
    defaultResearchSettings,
    type ResearchSettings,
    validateResearchSettings
} from '../shared/research'

export class ResearchSettingsService {
    private saving = false

    constructor(private db: AppDatabase, private secrets: SecretStorage) {
    }

    get(campus: CampusState): ResearchSettings {
        const saved = this.db.getResearchSettings()
        if (!saved) return {...defaultResearchSettings(), campus}
        return {
            searchDepth: saved.searchDepth,
            searchMaxResults: saved.searchMaxResults,
            searchMaxSnippetChars: saved.searchMaxSnippetChars,
            searchTimeoutSeconds: saved.searchTimeoutSeconds,
            httpTimeoutSeconds: saved.httpTimeoutSeconds,
            campusMaxContentChars: saved.campusMaxContentChars,
            researchMaxToolCalls: saved.researchMaxToolCalls,
            maxCampusPages: saved.maxCampusPages,
            requestBudgetSeconds: saved.requestBudgetSeconds,
            reviewEnabled: saved.reviewEnabled,
            hasSearchApiKey: !!saved.encryptedSearchApiKey?.length,
            campus,
        }
    }

    async save(input: unknown, campus: CampusState): Promise<ResearchSettings> {
        if (this.saving) throw new Error('正在保存调研设置，请等待完成。')
        this.saving = true
        try {
            const checked = validateResearchSettings(input)
            if (!checked.ok) throw new Error(checked.error)
            const value = checked.data
            const saved = this.db.getResearchSettings()
            let encryptedSearchApiKey = saved?.encryptedSearchApiKey ?? null
            if (value.clearSearchApiKey) encryptedSearchApiKey = null
            else if (value.searchApiKey) {
                if (!await this.secrets.available()) throw new Error('系统安全存储不可用，无法保存 API Key。')
                try {
                    encryptedSearchApiKey = await this.secrets.encrypt(value.searchApiKey)
                } catch {
                    throw new Error('API Key 加密失败，设置未保存。')
                }
            }
            this.db.saveResearchSettings({
                searchDepth: value.searchDepth, searchMaxResults: value.searchMaxResults,
                searchMaxSnippetChars: value.searchMaxSnippetChars, searchTimeoutSeconds: value.searchTimeoutSeconds,
                httpTimeoutSeconds: value.httpTimeoutSeconds, campusMaxContentChars: value.campusMaxContentChars,
                researchMaxToolCalls: value.researchMaxToolCalls, maxCampusPages: value.maxCampusPages,
                requestBudgetSeconds: value.requestBudgetSeconds, reviewEnabled: value.reviewEnabled,
                encryptedSearchApiKey,
            })
            return this.get(campus)
        } finally {
            this.saving = false
        }
    }

    hasSearchKey(): boolean {
        return !!this.db.getResearchSettings()?.encryptedSearchApiKey?.length
    }

    async searchApiKey(): Promise<string> {
        const saved = this.db.getResearchSettings()
        if (!saved?.encryptedSearchApiKey?.length) return ''
        if (!await this.secrets.available()) throw new Error('系统安全存储不可用，无法读取 Tavily API Key。')
        try {
            return await this.secrets.decrypt(saved.encryptedSearchApiKey)
        } catch {
            throw new Error('无法解密 Tavily API Key，请在旦挞设置中重新保存。')
        }
    }
}
