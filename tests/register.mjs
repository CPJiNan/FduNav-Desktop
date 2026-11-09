import {register} from 'node:module'

// Async hooks are available throughout the application's supported Node 22 range.
register('./resolve-ts.mjs', import.meta.url)
