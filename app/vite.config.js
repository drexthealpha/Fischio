import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Vite 8 externalizes the bare "buffer" builtin even when the npm package is
    // installed; the trailing slash forces resolution to the npm package, which
    // anchor's borsh layer needs in the browser.
    alias: { buffer: "buffer/" },
  },
  optimizeDeps: { include: ["buffer"] },
})
