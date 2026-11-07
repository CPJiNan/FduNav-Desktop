/** Stop awaiting read-only work even when its underlying adapter has no AbortSignal parameter. */
export function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, {once: true})
        work.then(value => {signal.removeEventListener('abort', abort); resolve(value)}, error => {
            signal.removeEventListener('abort', abort); reject(error)
        })
        if (signal.aborted) {signal.removeEventListener('abort', abort); reject(signal.reason)}
    })
}
