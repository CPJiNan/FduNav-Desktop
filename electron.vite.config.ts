import {defineConfig, loadEnv} from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({mode}) => {
    if (mode === 'development' && !process.env.ELECTRON_EXEC_PATH) {
        const {ELECTRON_EXEC_PATH} = loadEnv(mode, process.cwd(), 'ELECTRON_EXEC_PATH')
        if (ELECTRON_EXEC_PATH) process.env.ELECTRON_EXEC_PATH = ELECTRON_EXEC_PATH
    }
    return {
        main: {},
        preload: {},
        renderer: {
            plugins: [react()]
        }
    }
})
