import {useEffect, useRef, useState} from 'react'
import type {PDFDocumentProxy, RenderTask} from 'pdfjs-dist'
import {Icon} from './Icon'

export function MailAttachmentPreview({attachment, onClose}: {
    attachment: { data: string; name: string; type: string };
    onClose: () => void
}) {
    const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null),
        container = useRef<HTMLDivElement>(null)
    const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [width, setWidth] = useState(600)
    const [loading, setLoading] = useState(true), [error, setError] = useState('')
    const isImage = /^image\/(?:png|jpeg|gif|webp)$/i.test(attachment.type),
        isPdf = attachment.type === 'application/pdf'
    useEffect(() => {
        const element = dialog.current!,
            trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal()
        return () => {
            element.close();
            trigger?.focus({preventScroll: true})
        }
    }, [])
    useEffect(() => {
        if (!isPdf) {
            setLoading(false);
            return
        }
        let cancelled = false, task: { destroy: () => Promise<void> } | undefined
        void (async () => {
            const pdfjs = await import('pdfjs-dist'), worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
            pdfjs.GlobalWorkerOptions.workerSrc = worker.default
            const data = Uint8Array.from(atob(attachment.data), value => value.charCodeAt(0))
            const loadingTask = pdfjs.getDocument({data, useSystemFonts: true, useWorkerFetch: false, enableXfa: false})
            task = loadingTask;
            const document = await loadingTask.promise
            if (cancelled) {
                await loadingTask.destroy();
                return
            }
            setPdf(document)
        })().catch(() => {
            if (!cancelled) {
                setError('无法预览这个 PDF，请下载后查看。');
                setLoading(false)
            }
        })
        return () => {
            cancelled = true;
            void task?.destroy()
        }
    }, [attachment, isPdf])
    useEffect(() => {
        if (!container.current) return
        const observer = new ResizeObserver(entries => setWidth(Math.max(200, entries[0].contentRect.width - 32)))
        observer.observe(container.current);
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        if (!pdf || !canvas.current) return
        let cancelled = false, render: RenderTask | undefined
        setLoading(true)
        void (async () => {
            const documentPage = await pdf.getPage(page)
            if (cancelled || !canvas.current) return
            const base = documentPage.getViewport({scale: 1}), scale = Math.min(width / base.width, 2),
                ratio = Math.min(devicePixelRatio, 2)
            const viewport = documentPage.getViewport({scale: scale * ratio}), element = canvas.current
            element.width = viewport.width;
            element.height = viewport.height;
            element.style.width = viewport.width / ratio + 'px';
            element.style.height = viewport.height / ratio + 'px'
            render = documentPage.render({canvas: element, viewport})
            await render.promise;
            if (!cancelled) setLoading(false)
        })().catch(reason => {
            if (!cancelled && reason?.name !== 'RenderingCancelledException') {
                setError('PDF 页面加载失败，请下载后查看。');
                setLoading(false)
            }
        })
        return () => {
            cancelled = true;
            render?.cancel()
        }
    }, [pdf, page, width])
    return <dialog ref={dialog} className="calendar-dialog mail-attachment-dialog"
                   aria-labelledby="mail-attachment-title" onCancel={event => {
        event.preventDefault();
        onClose()
    }}>
        <header className="mail-attachment-heading"><h3 id="mail-attachment-title">{attachment.name}</h3>
            <button type="button" className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={onClose}><Icon
                name="close"/></button>
        </header>
        <div ref={container} className="mail-attachment-content">{loading &&
            <p role="status">正在加载附件…</p>}{error && <p role="alert" className="account-error">{error}</p>}
            {isImage ? <img src={'data:' + attachment.type + ';base64,' + attachment.data} alt={attachment.name}
                            onError={() => setError('无法预览这张图片，请下载后查看。')}/> : isPdf ?
                <canvas ref={canvas} aria-label={'PDF 第 ' + page + ' 页'}/> :
                <p>这种附件暂不支持预览，请下载后查看。</p>}</div>
        {pdf && <footer className="mail-attachment-pagination">
            <button type="button" className="secondary-button" disabled={page <= 1 || loading}
                    onClick={() => setPage(value => value - 1)}>上一页
            </button>
            <span>{page} / {pdf.numPages}</span>
            <button type="button" className="secondary-button" disabled={page >= pdf.numPages || loading}
                    onClick={() => setPage(value => value + 1)}>下一页
            </button>
        </footer>}
    </dialog>
}
