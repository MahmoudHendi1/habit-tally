import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** After the build, tell the service worker which files exist (docs/contracts.md section 7):
 *  '__SW_VERSION__' becomes a hash of the build and '__SW_PRECACHE__' a JSON array of file paths. */
function serviceWorkerManifest() {
  let outDir = 'dist';
  return {
    name: 'habit-tally-sw-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      if (!existsSync(swPath)) return;
      const files = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push('/' + relative(outDir, full).split(sep).join('/'));
        }
      };
      walk(outDir);
      const list = files.filter((f) => f !== '/sw.js' && !f.endsWith('.map')).sort();
      const hash = createHash('sha256');
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const precache = list.map((f) => (f === '/index.html' ? '/' : f));
      const sw = readFileSync(swPath, 'utf8')
        .replaceAll('__SW_VERSION__', version)
        .replaceAll('__SW_PRECACHE__', JSON.stringify(precache));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  plugins: [serviceWorkerManifest()],
  build: { target: 'es2022', sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
