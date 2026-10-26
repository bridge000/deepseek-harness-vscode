/**
 * Minimal JSON-RPC 2.0 peer. Intentionally tolerant: unknown methods, unknown
 * notifications and malformed traffic from the agent never break the session.
 */
import {
	RPC_ERROR,
	type JsonRpcErrorObject,
	type JsonRpcMessage,
	type JsonRpcNotificationMessage,
	type JsonRpcRequestMessage,
	type JsonRpcResponseMessage,
} from './protocol';

export interface TransportLike {
	send(message: JsonRpcMessage | JsonRpcMessage[]): void;
	onMessage(listener: (message: JsonRpcMessage) => void): { dispose(): void };
	onClose(listener: (error?: Error) => void): { dispose(): void };
	close(): void;
	readonly closed: boolean;
}

export class RpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(error: JsonRpcErrorObject) {
		super(error.message);
		this.name = 'RpcError';
		this.code = error.code;
		this.data = error.data;
	}
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

type RequestHandler = (params: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class JsonRpcPeer {
	private transport: TransportLike;
	private readonly onLog: (line: string) => void;
	private nextId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private subscriptions: { dispose(): void }[] = [];
	private closed = false;
	private closeListeners = new Set<(error?: Error) => void>();

	constructor(transport: TransportLike, onLog?: (line: string) => void) {
		this.transport = transport;
		this.onLog = onLog ?? (() => undefined);
		this.subscriptions.push(
			this.transport.onMessage((message) => this.handleMessage(message)),
			this.transport.onClose((error) => this.handleClose(error)),
		);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
		if (this.closed) return Promise.reject(new Error('ACP connection is closed'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (options?.timeoutMs !== undefined) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`ACP request timed out after ${options.timeoutMs}ms: ${method}`));
				}, options.timeoutMs);
			}
			if (options?.signal) {
				const signal = options.signal;
				pending.signal = signal;
				pending.onAbort = () => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					if (entry.timer) clearTimeout(entry.timer);
					reject(new Error(`ACP request aborted: ${method}`));
				};
				if (signal.aborted) {
					reject(new Error(`ACP request aborted: ${method}`));
					return;
				}
				signal.addEventListener('abort', pending.onAbort, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.transport.send({ jsonrpc: '2.0', id, method, params });
			} catch (error) {
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		try {
			this.transport.send({ jsonrpc: '2.0', method, params });
		} catch (error) {
			this.onLog(`[jsonrpc] notify ${method} failed: ${String(error)}`);
		}
	}

	onRequest(method: string, handler: RequestHandler): { dispose(): void } {
		this.requestHandlers.set(method, handler);
		return {
			dispose: () => {
				if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
			},
		};
	}

	onNotification(method: string, handler: NotificationHandler): { dispose(): void } {
		let handlers = this.notificationHandlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.notificationHandlers.set(method, handlers);
		}
		handlers.add(handler);
		return {
			dispose: () => {
				handlers?.delete(handler);
			},
		};
	}

	onClose(listener: (error?: Error) => void): { dispose(): void } {
		this.closeListeners.add(listener);
		return {
			dispose: () => {
				this.closeListeners.delete(listener);
			},
		};
	}

	dispose(error?: Error): void {
		this.handleClose(error);
	}

	private handleMessage(raw: unknown): void {
		if (Array.isArray(raw)) {
			for (const item of raw) this.handleMessage(item);
			return;
		}
		if (typeof raw !== 'object' || raw === null) return;
		const message = raw as JsonRpcMessage;
		const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && (message as { id?: unknown }).id !== undefined;
		const hasMethod = typeof (message as { method?: unknown }).method === 'string';
		if (hasMethod) {
			if (hasId) this.handleRequest(message as JsonRpcRequestMessage);
			else this.handleNotification(message as JsonRpcNotificationMessage);
			return;
		}
		this.handleResponse(message as JsonRpcResponseMessage);
	}

	private handleResponse(message: JsonRpcResponseMessage): void {
		const key = message.id;
		if (key === null || key === undefined) return;
		const pending = this.pending.get(key);
		if (!pending) return;
		this.pending.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
		if (message.error && typeof message.error === 'object') {
			pending.reject(new RpcError(message.error as JsonRpcErrorObject));
		} else {
			pending.resolve(message.result);
		}
	}

	private handleNotification(message: JsonRpcNotificationMessage): void {
		const handlers = this.notificationHandlers.get(message.method);
		if (!handlers || handlers.size === 0) {
			this.onLog(`[jsonrpc] ignored unknown notification: ${message.method}`);
			return;
		}
		for (const handler of handlers) {
			try {
				handler(message.params);
			} catch (error) {
				this.onLog(`[jsonrpc] notification handler ${message.method} failed: ${String(error)}`);
			}
		}
	}

	private handleRequest(message: JsonRpcRequestMessage): void {
		const handler = this.requestHandlers.get(message.method);
		if (!handler) {
			this.onLog(`[jsonrpc] unsupported server request: ${message.method}`);
			this.respondError(message.id, RPC_ERROR.methodNotFound, `Method not supported by client: ${message.method}`);
			return;
		}
		const controller = new AbortController();
		Promise.resolve()
			.then(() => handler(message.params, controller.signal))
			.then((result) => {
				this.transport.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
			})
			.catch((error: unknown) => {
				const messageText = error instanceof Error ? error.message : String(error);
				this.respondError(message.id, RPC_ERROR.internalError, messageText);
			});
	}

	private respondError(id: number | string, code: number, message: string): void {
		try {
			this.transport.send({ jsonrpc: '2.0', id, error: { code, message } });
		} catch (error) {
			this.onLog(`[jsonrpc] failed to send error response: ${String(error)}`);
		}
	}

	private handleClose(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
		const failure = error ?? new Error('ACP connection closed');
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
			pending.reject(failure);
		}
		this.closeListeners.forEach((listener) => {
			try {
				listener(error);
			} catch {
				/* ignore listener failures */
			}
		});
	}
}
