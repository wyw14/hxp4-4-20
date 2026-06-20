import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5120,
    strictPort: true,
    open: true
  }
});