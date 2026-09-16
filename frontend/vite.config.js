import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser only ever talks to the nginx origin; nginx proxies /api/* to the
// backend (see nginx.conf). In `vite dev` we proxy to a locally-run backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
