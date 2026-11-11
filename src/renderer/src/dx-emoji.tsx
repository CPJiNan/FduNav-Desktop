import {type ReactNode, useMemo} from 'react'

// 旦挞帖子里的小表情写成 markdown 图片占位符：![](dx_fright)。
// 官方客户端把 dx_* 映射到内置贴纸资源；这里同样打包到本地，不依赖网络。
const modules = import.meta.glob('./assets/dx/*.webp', {eager: true, query: '?url', import: 'default'}) as Record<
    string,
    string
>

const emojiUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(modules)) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.webp$/, '')
    emojiUrls[name] = url
}

export const knownEmojiCount = Object.keys(emojiUrls).length

// ![](dx_xxx) —— 名字限定为小写字母数字下划线，避免吃掉正常的 markdown 图片。
const pattern = /!\[\]\((dx_[a-z0-9_]+)\)/g

function renderText(text: string, keyBase: string): ReactNode[] {
    const nodes: ReactNode[] = []
    let cursor = 0
    let index = 0
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        if (match.index > cursor) {
            nodes.push(text.slice(cursor, match.index))
        }
        const name = match[1]
        const src = emojiUrls[name]
        const key = `${keyBase}:${index++}`
        if (src) {
            nodes.push(<img key={key} className="dx-emoji" src={src} alt={name} title={name} draggable={false}/>)
        } else {
            // 资源缺失时不吞掉内容，留一个可辨认的小标记。
            nodes.push(
                <span key={key} className="dx-emoji-missing" title={`缺少表情资源：${name}`}>
                    {name.replace(/^dx_/, '')}
                </span>
            )
        }
        cursor = match.index + match[0].length
    }
    if (cursor < text.length) {
        nodes.push(text.slice(cursor))
    }
    return nodes
}

/**
 * 渲染树洞正文：把 ![](dx_*) 换成内置表情图，其余文本原样保留。
 * 不引入完整 markdown 渲染，因为帖子正文里主要需要处理的就是表情占位符。
 */
export function PostContent({text, className}: {text: string; className?: string}) {
    const nodes = useMemo(() => renderText(text, 'dx'), [text])
    return <span className={className}>{nodes}</span>
}
