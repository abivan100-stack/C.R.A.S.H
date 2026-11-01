import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* Dev server: everything that production serves from the single FastAPI origin
   (static assets, dataset, API) is proxied there, so the React app talks to the
   exact same URLs and payloads it will in production. */
const BACKEND = 'http://localhost:8000';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/data': BACKEND,
      '/vendor': BACKEND,
      '/shared': BACKEND,
      '/crash.css': BACKEND,
      '/favicon.svg': BACKEND,
      '/crash-mark.svg': BACKEND,
      '/crash-logo.svg': BACKEND,
      '/report': BACKEND,
      '/reports': BACKEND,
      '/ask': BACKEND,
      '/health': BACKEND,
      '/export': BACKEND,
    },
  },
  build: {
    /* The backend's static allowlist serves root-level files and shared/ and
       vendor/ only, so the entry HTML and every hashed asset are emitted flat
       and copied to the repo root at release time. */
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: '',
    sourcemap: false,
  },
});
