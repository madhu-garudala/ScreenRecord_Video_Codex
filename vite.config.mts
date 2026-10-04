import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'development-csp',
      transformIndexHtml: {
        order: 'pre' as const,
        handler(html: string, context: { server?: unknown }) {
          return context.server
            ? html.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173")
            : html;
        },
      },
    },
  ],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
