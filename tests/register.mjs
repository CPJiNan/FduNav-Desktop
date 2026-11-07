import {registerHooks} from 'node:module'
import {fileURLToPath} from 'node:url'
import {existsSync} from 'node:fs'
const electron = new URL('./fakes/electron.ts', import.meta.url).href
registerHooks({resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return {url: electron, shortCircuit: true}
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
        const url = new URL(`${specifier}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
}})
