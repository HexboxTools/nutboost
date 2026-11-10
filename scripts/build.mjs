import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('docs', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, format: 'esm', minify: true, sourcemap: false, target: 'es2022', outfile: 'docs/app.js', platform: 'browser' });
await cp('web/index.html', 'docs/index.html');
await cp('web/style.css', 'docs/style.css');
console.log('built docs/');
