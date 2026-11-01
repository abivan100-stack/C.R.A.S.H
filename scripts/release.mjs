/* Release step: copy the Vite build into the repo root, because the backend's
   static allowlist serves root-level files only. The entry HTML is published as
   app.html so the legacy index.html stays on disk as the regression-test oracle
   while the served app is the React build. */
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');

const entries = await readdir(dist);
let copied = 0;
for (const name of entries) {
  const from = path.join(dist, name);
  const info = await stat(from);
  if (!info.isFile()) continue;
  const target = name === 'index.html' ? 'app.html' : name;
  await copyFile(from, path.join(root, target));
  if (target === 'app.html') {
    const html = await readFile(path.join(root, target), 'utf8');
    /* Classic script: the backend's static handler sends root .js as
       text/plain, which strict module MIME checks reject. The bundle is an
       IIFE, so it needs no module loader. */
    const classic = html.replace(
      /<script type="module" crossorigin src="([^"]+)"><\/script>/,
      '<script defer src="$1"></script>',
    );
    await writeFile(path.join(root, target), classic);
  }
  copied += 1;
}
console.log(`release: ${copied} file(s) published from dist/ (entry: app.html)`);
