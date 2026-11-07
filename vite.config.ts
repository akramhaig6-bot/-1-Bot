import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'src/client'),
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1', '.e2b.app'],
    hmr: false,
  },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
  },
});
