/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Project is served from GitHub Pages under /hydrograph_metrics_explorer/
export default defineConfig({
  base: '/hydrograph_metrics_explorer/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
