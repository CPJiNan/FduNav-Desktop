import type {PluginManagerAPI, PluginServices, WindowControlsAPI} from '../../shared/plugins'

declare global {
    interface Window extends Partial<PluginServices> {
        fdunavServices?: PluginServices
        plugins?: PluginManagerAPI
        windowControls?: WindowControlsAPI
    }
}
