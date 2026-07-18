import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Vite 8 externalizes the bare "buffer" builtin even when the npm package is
      // installed; the trailing slash forces resolution to the npm package, which
      // anchor's borsh layer needs in the browser.
      buffer: "buffer/",
      // The repo-root lib/ holds the logic that has to give the same answer everywhere: which
      // lines settle on-chain, and on what terms. The app kept its own copy, and the copy had
      // drifted. It hardcoded stat keys 1 and 2, so it could not recognise a first-half market
      // or a handicap at all, and marked both untradeable. Sharing the module is the only way
      // the board and the market maker stay in agreement about what is tradeable.
      //
      // Only dependency-free modules belong here. Anything reaching for a node builtin will
      // not bundle for the browser.
      "@shared": fileURLToPath(new URL("../lib", import.meta.url)),
    },
  },
  // the dev server will not serve files above its root unless told to
  server: { fs: { allow: [".."] } },
  optimizeDeps: { include: ["buffer"] },
})
