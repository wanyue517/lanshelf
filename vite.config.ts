import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: { strictPort: true, port: 5173, host: '127.0.0.1' }
})
