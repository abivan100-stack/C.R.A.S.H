import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/* Dev convenience: the repo-root static assets (vendor libs, crash.css, data,
   shared legacy modules) live outside the Vite root, so serve them through the
   dev server. Production builds never use this. */
function repoRootStatics() {
  const root = path.resolve(__dirname, '..');
  return {
    name: 'crash-repo-root-statics',
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(async (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer | string) => void }, next: () => void) => {
        const url = (req.url || '').split('?')[0];
        const prefixes = ['/vendor/', '/data/', '/shared/', '/crash.css', '/favicon.svg', '/crash-mark.svg', '/crash-logo.svg'];
        if (!prefixes.some((p) => url.startsWith(p))) return next();
        try {
          const file = path.join(root, decodeURIComponent(url));
          const buf = await readFile(file);
          const ext = path.extname(file);
          const types: Record<string, string> = {
            '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
            '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
          };
          res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
          res.end(buf);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  root: 'frontend',
  plugins: [react(), repoRootStatics()],
  server: { port: 5173 },
  build: {
    // Hash-free subdirectory is not servable by the backend allowlist, so emit
    // the entry HTML and every asset flat.
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: '',
    sourcemap: false,
  },
});
