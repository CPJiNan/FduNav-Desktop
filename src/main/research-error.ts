export class ResearchError extends Error {
    constructor(public code: string, message: string, public status = 502) {
        super(message)
        this.name = 'ResearchError'
    }
}
