import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FIREBASE_MODULE = /[\\/]node_modules[\\/](@firebase|firebase)[\\/]/;

/** After the build, tell the service worker which files exist (docs/contracts.md section 7) by putting
 *  one line at the top of the built sw.js:  self.__BUILD = { version: '<hash>', files: ['/', ...] };
 *  In dev there is no such line, so the worker sees `self.__BUILD` undefined and precaches nothing.
 *  A demo build (VITE_BACKEND=demo) leaves out every chunk that contains or imports Firebase code, so
 *  demo mode never downloads it. */
function serviceWorkerManifest() {
  let outDir = 'dist';
  const firebaseFiles = new Set();
  return {
    name: 'habit-tally-sw-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      for (const c of chunks) if (Object.keys(c.modules).some((id) => FIREBASE_MODULE.test(id))) firebaseFiles.add(c.fileName);
      for (let grew = true; grew;) {
        grew = false;
        for (const c of chunks) {
          if (!firebaseFiles.has(c.fileName) && c.imports.some((f) => firebaseFiles.has(f))) {
            firebaseFiles.add(c.fileName);
            grew = true;
          }
        }
      }
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      if (!existsSync(swPath)) return;
      const demo = process.env.VITE_BACKEND === 'demo';
      const all = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else all.push(relative(outDir, full).split(sep).join('/'));
        }
      };
      walk(outDir);
      const list = all
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !(demo && firebaseFiles.has(f)))
        .sort();
      const hash = createHash('sha256');
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const build = {
        version: hash.digest('hex').slice(0, 12),
        files: list.map((f) => (f === 'index.html' ? '/' : '/' + f)),
      };
      writeFileSync(swPath, `self.__BUILD = ${JSON.stringify(build)};\n` + readFileSync(swPath, 'utf8'));
    },
  };
}

export default defineConfig({
  plugins: [serviceWorkerManifest()],
  build: { target: 'es2022', sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
