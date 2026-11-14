import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the site from /<repo>/. Override with BASE=/ for local preview at the root.
export default defineConfig({
  base: process.env.BASE ?? '/dala-fire/',
  plugins: [react()],
})
