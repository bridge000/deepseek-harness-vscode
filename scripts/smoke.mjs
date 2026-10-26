import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runSmokeCli } = require('../dist/compat.cjs');

if (typeof runSmokeCli !== 'function') {
	console.error('dist/compat.cjs 缺少 runSmokeCli，请先运行 `npm run build`');
	process.exit(2);
}

process.exitCode = Number(await runSmokeCli());
