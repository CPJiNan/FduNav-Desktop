import type {MailFolderNode} from '../../shared/mail-folders'
import {Icon} from './Icon'

export function MailFolderTree({nodes, selected, onSelect}: {
    nodes: MailFolderNode[]; selected: string; onSelect: (path: string) => void
}) {
    return <ul className="mailbox-custom-folders">{nodes.map(node => <li key={node.key}>
        {node.folder ?
            <button type="button" className={'mailbox-nav-item' + (selected === node.folder.path ? ' is-active' : '')}
                    title={node.folder.path} aria-current={selected === node.folder.path ? 'page' : undefined}
                    onClick={() => onSelect(node.folder!.path)}>
                <Icon name="folder"/><span>{node.label}</span>{!!node.folder.unread &&
                <span className="mailbox-nav-count">{node.folder.unread}</span>}
            </button> :
            <div className="mailbox-folder-label" title={node.label}><Icon name="folder"/><span>{node.label}</span>
            </div>}
        {!!node.children.length && <MailFolderTree nodes={node.children} selected={selected} onSelect={onSelect}/>}
    </li>)}</ul>
}
