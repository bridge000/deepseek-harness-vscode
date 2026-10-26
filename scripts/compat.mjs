import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCompatCli } = require('../dist/compat.cjs');

if (typeof runCompatCli !== 'function') {
	console.error('dist/compat.cjs 缺少 runCompatCli，请先运行 `npm run build`');
	process.exit(2);
}

process.exitCode = Number(await runCompatCli());
