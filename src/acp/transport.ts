/**
 * Spawns the DSH ACP process and turns its stdio into a tolerant message
 * transport.
 *
 * Real DSH builds occasionally print log lines to *stdout* in addition to the
 * protocol frames (observed: `[llm-deepseek-account] model listing ...`). A
 * strict NDJSON parser would kill the connection there, so non-JSON lines are
 * reported through `onDirtyLine` and discarded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { TransportLike } from './jsonrpc';
import type { JsonRpcMessage } from './protocol';

export interface TransportSpec {
	/** Executable or wrapper (.cmd/.exe/…). */
	file: string;
	args: string[];
	/** Windows `.cmd` wrappers cannot be spawned directly on Node >= 20; use a shell for those. */
	shell: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
	onStderr?: (text: string) => void;
	onDirtyLine?: (line: string) => void;
	log?: (line: string) => void;
}

export interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface SpawnedTransport extends TransportLike {
	readonly pid: number | undefined;
	kill(): Promise<void>;
	onExit(listener: (info: ExitInfo) => void): { dispose(): void };
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Quote a single token for `cmd.exe`-style shells; rejects characters we never generate. */
export function shellQuote(token: string): string {
	if (/["\r\n]/.test(token)) throw new Error(`Refusing to shell-quote unsafe token: ${token}`);
	return `"${token}"`;
}

export function spawnDshTransport(spec: TransportSpec): SpawnedTransport {
	const log = spec.log ?? (() => undefined);
	let child: ChildProcess;
	try {
		if (spec.shell) {
			const commandLine = [spec.file, ...spec.args].map(shellQuote).join(' ');
			child = spawn(commandLine, [], {
				shell: true,
				cwd: spec.cwd,
				env: spec.env,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} else {
			child = spawn(spec.file, spec.args, {
				shell: false,
				cwd: spec.cwd,
				env: spec.env,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		}
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}

	let closed = false;
	let exitInfo: ExitInfo | undefined;
	let buffer = '';
	let closing = false;
	const messageListeners = new Set<(message: JsonRpcMessage) => void>();
	const closeListeners = new Set<(error?: Error) => void>();
	const exitListeners = new Set<(info: ExitInfo) => void>();

	const emitClose = (error?: Error): void => {
		if (closed) return;
		closed = true;
		closeListeners.forEach((listener) => {
			try {
				listener(error);
			} catch {
				/* ignore */
			}
		});
	};

	const dispatchLine = (line: string): void => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			spec.onDirtyLine?.(trimmed);
			return;
		}
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of messages) {
			if (typeof item !== 'object' || item === null) {
				spec.onDirtyLine?.(trimmed);
				continue;
			}
			messageListeners.forEach((listener) => {
				try {
					listener(item as JsonRpcMessage);
				} catch (error) {
					log(`[transport] message listener failed: ${String(error)}`);
				}
			});
		}
	};

	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_LINE_BYTES) {
			log(`[transport] protocol line exceeded ${MAX_LINE_BYTES} bytes; closing connection`);
			emitClose(new Error('ACP protocol line too large'));
			void kill();
			return;
		}
		let index: number;
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, '');
			buffer = buffer.slice(index + 1);
			dispatchLine(line);
		}
	});

	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => spec.onStderr?.(chunk));

	child.on('error', (error) => {
		log(`[transport] process error: ${error.message}`);
		emitClose(error);
	});

	child.on('exit', (code, signal) => {
		exitInfo = { code, signal };
		exitListeners.forEach((listener) => {
			try {
				listener(exitInfo as ExitInfo);
			} catch {
				/* ignore */
			}
		});
		if (!closed) {
			emitClose(closing ? undefined : new Error(`DSH process exited (code=${String(code)}, signal=${String(signal)})`));
		}
	});

	const kill = async (): Promise<void> => {
		if (exitInfo) return;
		const pid = child.pid;
		try {
			child.stdin?.end();
		} catch {
			/* ignore */
		}
		const exited = await new Promise<boolean>((resolve) => {
			if (exitInfo) return resolve(true);
			const timer = setTimeout(() => resolve(false), 1500);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		if (exited || exitInfo || pid === undefined) return;
		if (process.platform === 'win32' && spec.shell) {
			await new Promise<void>((resolve) => {
				const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
					windowsHide: true,
					stdio: 'ignore',
				});
				killer.on('exit', () => resolve());
				killer.on('error', () => resolve());
				setTimeout(resolve, 3000);
			});
		} else {
			try {
				child.kill('SIGTERM');
			} catch {
				/* ignore */
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						/* ignore */
					}
					resolve();
				}, 1500);
				child.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	};

	const transport: SpawnedTransport = {
		pid: child.pid,
		get closed() {
			return closed;
		},
		send(message: JsonRpcMessage | JsonRpcMessage[]): void {
			if (closed) throw new Error('Transport is closed');
			const payload = `${JSON.stringify(message)}\n`;
			try {
				child.stdin?.write(payload);
			} catch (error) {
				emitClose(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		},
		onMessage(listener) {
			messageListeners.add(listener);
			return { dispose: () => messageListeners.delete(listener) };
		},
		onClose(listener) {
			closeListeners.add(listener);
			return { dispose: () => closeListeners.delete(listener) };
		},
		onExit(listener) {
			exitListeners.add(listener);
			return { dispose: () => exitListeners.delete(listener) };
		},
		close() {
			closing = true;
			emitClose(undefined);
			try {
				child.stdin?.end();
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				void kill();
			}, 10);
		},
		kill,
	};

	return transport;
}
