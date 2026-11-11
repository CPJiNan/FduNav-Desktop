import {useState} from 'react'

const previewChars = 20000

export function downloadJson(value: unknown, filename: string) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url;
    link.download = filename;
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function TracePayload({value, filename}: { value: unknown; filename: string }) {
    const [expanded, setExpanded] = useState(false)
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const truncated = text.length > previewChars
    const shown = truncated && !expanded ? `${text.slice(0, previewChars)}\n…（已截断，共 ${text.length} 字符）` : text
    return <>
        <pre tabIndex={0}>{shown}</pre>
        <div className="trace-payload-actions">
            {truncated && <button type="button" className="secondary-button" aria-expanded={expanded}
                                  onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</button>}
            <button type="button" className="secondary-button" onClick={() => downloadJson(value, filename)}>下载 JSON
            </button>
        </div>
    </>
}
