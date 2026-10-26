import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(root, '..'));

const production = process.argv.includes('--production');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/webview', { recursive: true });

await build({
	entryPoints: ['src/extension.ts'],
	outfile: 'dist/extension.js',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	sourcemap: production ? false : 'inline',
	minify: production,
	logLevel: 'info',
	define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
});

await build({
	entryPoints: ['src/webview/main.ts'],
	outfile: 'dist/webview/main.js',
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	minify: production,
	sourcemap: production ? false : 'inline',
	logLevel: 'info',
});

// Pure-node bundle used by scripts/compat.mjs and scripts/smoke.mjs so the
// scripts exercise the *real* transport and JSON-RPC client.
await build({
	entryPoints: ['src/acp/compat-entry.ts'],
	outfile: 'dist/compat.cjs',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	logLevel: 'info',
});

await cp('src/webview/style.css', 'dist/webview/style.css');
console.log('[build] done', production ? '(production)' : '(development)');
