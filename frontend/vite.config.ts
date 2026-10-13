import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The Go server mounts the dashboard at /dashboard, so assets must be
  // referenced under that subpath.
  base: '/dashboard/',
})
