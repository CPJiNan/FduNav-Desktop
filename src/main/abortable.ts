export function abortError(reason: unknown): Error {
    if (reason instanceof Error) return reason
    return new DOMException(typeof reason === 'string' && reason ? reason : '已停止', 'AbortError')
}

export function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError(signal.reason))
        signal.addEventListener('abort', abort, {once: true})
        work.then(value => {
            signal.removeEventListener('abort', abort);
            resolve(value)
        }, error => {
            signal.removeEventListener('abort', abort);
            reject(error)
        })
        if (signal.aborted) {
            signal.removeEventListener('abort', abort);
            reject(abortError(signal.reason))
        }
    })
}
