import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // Unity/WebView2 can keep an older entry chunk alive during a local rebuild.
  // Retain its content-hashed lazy chunks so in-app navigation does not 404.
  // Use a fresh staging directory for a clean distribution/package build.
  build: { emptyOutDir: false },
})
