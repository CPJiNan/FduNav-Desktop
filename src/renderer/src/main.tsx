import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import App from './App'
import {PluginFrame} from './plugins/PluginFrame'
import {emptyPluginState, PluginRuntime} from './plugins/runtime'
import './styles/base.css'
import {initializeTheme} from './theme'

async function start() {
    const result = await window.plugins?.get().catch(() => undefined)
    const runtime = new PluginRuntime(result?.ok ? result.data : emptyPluginState)
    runtime.installServices()
    await initializeTheme()
    const openPlugins = (result && !result.ok) || runtime.state.safeMode || window.location.hash === '#plugins'
    if (window.location.hash === '#plugins') window.history.replaceState(null, '', window.location.href.split('#')[0])

    createRoot(document.getElementById('root')!).render(<StrictMode>
        {[...runtime.providers].map(([id, provider]) => <PluginFrame key={id} runtime={runtime} spec={provider.frame}/>)}
        {runtime.application ? <PluginFrame runtime={runtime} spec={runtime.application}
            fallback={error => <App runtime={runtime} openPlugins pluginStartupError={error}/>}/> :
            <App runtime={runtime} openPlugins={openPlugins}/>}
    </StrictMode>)
}

void start()
