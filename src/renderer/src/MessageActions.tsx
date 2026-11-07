import {useState} from 'react'

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch {
        return false
    }
}

export function CopyButton({text, label = '复制'}: { text: string; label?: string }) {
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
