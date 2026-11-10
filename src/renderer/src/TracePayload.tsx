import {useState} from 'react'

/** Payloads larger than this are truncated in the DOM; the download keeps the original. */
const previewChars = 20000

export function downloadJson(value: unknown, filename: string) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url; link.download = filename; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Trace details: bounded <pre> plus an explicit download of the full payload. */
export function TracePayload({value, filename}: {value: unknown; filename: string}) {
    const [expanded, setExpanded] = useState(false)
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const truncated = text.length > previewChars
    const shown = truncated && !expanded ? `${text.slice(0, previewChars)}\n…（已截断，共 ${text.length} 字符）` : text
    return <>
        <pre tabIndex={0}>{shown}</pre>
        {truncated && <button type="button" className="secondary-button" onClick={() => setExpanded(value => !value)}>
            {expanded ? '收起' : '显示全部'}</button>}
        <button type="button" className="secondary-button" onClick={() => downloadJson(value, filename)}>下载 JSON</button>
    </>
}
