// Bundles each entry point with esbuild and copies static files into dist/.
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
// Debug builds add a postMessage bridge so automation can drive the extension from a reddit.com tab.
const debugBridge = process.argv.includes('--debug-bridge');
const outdir = 'dist';

const entryPoints = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/ui/popup/index.tsx',
  options: 'src/ui/options/index.tsx',
  review: 'src/ui/review/index.tsx',
  ...(debugBridge ? { 'debug-bridge': 'src/debug/bridge.ts' } : {}),
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function copyStatic() {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  if (debugBridge) {
    manifest.name += ' (debug bridge)';
    manifest.content_scripts.push({ matches: ['*://www.reddit.com/*'], js: ['debug-bridge.js'], run_at: 'document_start' });
  }
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await cp('static', outdir, { recursive: true });
}

const options = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: ['firefox128'],
  sourcemap: watch ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
  define: { __DEBUG_BRIDGE__: String(debugBridge) },
};

await copyStatic();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
