import {useEffect, useMemo, useRef, useState} from 'react'
import type {MailMessage} from '../../shared/mail'

export function MailContent({message, onError}: {message: MailMessage; onError: (error: string) => void}) {
    const frame = useRef<HTMLIFrameElement>(null), [theme, setTheme] = useState(document.documentElement.dataset.theme ?? '')
    useEffect(() => {
        const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? ''))
        observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'style']})
        return () => observer.disconnect()
    }, [])
    const documentHtml = useMemo(() => {
        const style = getComputedStyle(document.documentElement), text = style.getPropertyValue('--color-text-primary').trim() || '#252c32'
        const link = style.getPropertyValue('--color-accent').trim() || '#3567d6'
        // Message HTML has already been sanitized in the main process. CSP and sandbox are additional independent boundaries.
        return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'none\'; base-uri \'none\'; form-action \'none\'; connect-src \'none\'; frame-src \'none\'"><style>html{color-scheme:' + style.colorScheme + ';background:transparent;overflow:hidden}body{margin:0;font:14px/1.8 system-ui,sans-serif;color:' + text + ';overflow-wrap:anywhere}body *{max-width:100%;box-sizing:border-box;color:inherit!important}a,a *{color:' + link + '!important;text-decoration:underline}img{height:auto}table{border-collapse:collapse}td,th{padding:3px 14px 3px 0;vertical-align:top}pre{white-space:pre-wrap}blockquote{margin:12px 0;padding-left:16px;border-left:2px solid currentColor;opacity:.8}</style></head><body>' + message.html + '</body></html>'
    }, [message.html, theme])
    useEffect(() => {
        const element = frame.current
        if (!element) return
        let resize: ResizeObserver | undefined, pendingFrame = 0, removeClick: (() => void) | undefined
        const loaded = () => {
            const doc = element.contentDocument
            if (!doc?.body) return
            const measure = () => {
                cancelAnimationFrame(pendingFrame)
                pendingFrame = requestAnimationFrame(() => {
                    const height = Math.max(100, Math.min(500000, Math.ceil(doc.body.getBoundingClientRect().height + 8))) + 'px'
                    if (element.style.height !== height) element.style.height = height
                })
            }
            resize?.disconnect(); resize = new ResizeObserver(measure); resize.observe(doc.body); measure()
            removeClick?.()
            const click = (event: MouseEvent) => {
                const anchor = (event.target as Element)?.closest?.('a[href]')
                if (!anchor) return
                event.preventDefault()
                const href = anchor.getAttribute('href')
                if (href) void window.mail?.openLink(href).then(result => {if (!result.ok) onError(result.error)}).catch(() => onError('无法打开链接。'))
            }
            doc.addEventListener('click', click); removeClick = () => doc.removeEventListener('click', click)
        }
        element.addEventListener('load', loaded)
        if (element.contentDocument?.readyState === 'complete') loaded()
        return () => {element.removeEventListener('load', loaded); resize?.disconnect(); cancelAnimationFrame(pendingFrame); removeClick?.()}
    }, [documentHtml, onError])
    if (message.html) return <iframe ref={frame} title="邮件正文" className="mail-html-body" sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={documentHtml}/>
    return <div className="mail-plain-body">{message.body || '无正文'}</div>
}
