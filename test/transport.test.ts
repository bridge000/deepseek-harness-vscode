import { describe, expect, it } from 'vitest';
import { spawnDshTransport, shellQuote } from '../src/acp/transport';
import { JsonRpcPeer } from '../src/acp/jsonrpc';
import type { JsonRpcMessage } from '../src/acp/protocol';

const CLIENT_SCRIPT = String.raw`
const readline = require('node:readline');
process.stdout.write('dirty log line [llm-deepseek-account] model listing\n');
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'hello', params: { n: 1 } }) + '\n');
process.stdout.write(JSON.stringify([
  { jsonrpc: '2.0', method: 'hello', params: { n: 2 } },
  { jsonrpc: '2.0', method: 'hello', params: { n: 3 } },
]) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pong: message.params && message.params.x } }) + '\n');
  }
  if (message.method === 'bye') process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
`;

function createTransport(): ReturnType<typeof spawnDshTransport> {
	return spawnDshTransport({
		file: process.execPath,
		args: ['-e', CLIENT_SCRIPT],
		shell: false,
		cwd: process.cwd(),
		env: process.env,
		log: () => undefined,
	});
}

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = (): void => {
			if (check()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe('spawnDshTransport', () => {
	it('skips dirty stdout lines and dispatches JSON frames, including batches', async () => {
		const messages: JsonRpcMessage[] = [];
		const dirty: string[] = [];
		const transport = spawnDshTransport({
			file: process.execPath,
			args: ['-e', CLIENT_SCRIPT],
			shell: false,
			cwd: process.cwd(),
			env: process.env,
			log: () => undefined,
			onDirtyLine: (line) => dirty.push(line),
		});
		transport.onMessage((message) => messages.push(message));
		try {
			await waitFor(() => messages.length >= 3);
			expect(dirty.some((line) => line.includes('dirty log line'))).toBe(true);
			expect(messages).toHaveLength(3);
			expect(messages[0]).toMatchObject({ method: 'hello', params: { n: 1 } });
			expect(messages[1]).toMatchObject({ method: 'hello', params: { n: 2 } });
			expect(messages[2]).toMatchObject({ method: 'hello', params: { n: 3 } });
		} finally {
			transport.close();
		}
	});

	it('round-trips JSON-RPC requests over stdio', async () => {
		const transport = createTransport();
		const peer = new JsonRpcPeer(transport, () => undefined);
		try {
			const result = await peer.request<{ pong: number }>('ping', { x: 42 }, { timeoutMs: 5000 });
			expect(result).toEqual({ pong: 42 });
		} finally {
			peer.dispose();
			transport.close();
		}
	});

	it('reports process exit to close listeners', async () => {
		const transport = createTransport();
		let closed = false;
		transport.onClose(() => {
			closed = true;
		});
		transport.send({ jsonrpc: '2.0', method: 'bye' });
		await waitFor(() => closed);
		expect(closed).toBe(true);
	});

	it('rejects unsafe shell tokens', () => {
		expect(shellQuote('C:\\Program Files\\dsh.cmd')).toBe('"C:\\Program Files\\dsh.cmd"');
		expect(() => shellQuote('bad"quote')).toThrow();
		expect(() => shellQuote('bad\nnewline')).toThrow();
	});
});
