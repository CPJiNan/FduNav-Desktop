import {useState} from 'react'

/** Copy plain text, falling back to a hidden textarea when the clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch { /* fall through to the legacy path */ }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
}

/** Small copy affordance shown under a message, mirroring the desktop app. */
export function CopyButton({text, label = '复制'}: {text: string; label?: string}) {
    const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
    async function copy(event: React.MouseEvent) {
        event.stopPropagation()
        const ok = await copyText(text)
        setStatus(ok ? 'copied' : 'failed')
        setTimeout(() => setStatus('idle'), 1500)
    }
    return <button type="button" className="chat-message-action" aria-label={label} title={label}
                   onClick={event => void copy(event)}>
        {status === 'copied' ? '已复制' : status === 'failed' ? '复制失败' : '复制'}
    </button>
}
