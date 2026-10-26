import { describe, expect, it } from 'vitest';
import { JsonRpcPeer, RpcError, type TransportLike } from '../src/acp/jsonrpc';
import type { JsonRpcMessage } from '../src/acp/protocol';

function createPair(): [TransportLike, TransportLike] {
	const listenersA = new Set<(message: JsonRpcMessage) => void>();
	const listenersB = new Set<(message: JsonRpcMessage) => void>();
	const closeA = new Set<(error?: Error) => void>();
	const closeB = new Set<(error?: Error) => void>();
	const make = (
		own: Set<(message: JsonRpcMessage) => void>,
		other: Set<(message: JsonRpcMessage) => void>,
		ownClose: Set<(error?: Error) => void>,
	): TransportLike => ({
		closed: false,
		send(message) {
			if (Array.isArray(message)) {
				for (const item of message) for (const listener of other) listener(item);
			} else {
				for (const listener of other) listener(message);
			}
		},
		onMessage(listener) {
			own.add(listener);
			return { dispose: () => own.delete(listener) };
		},
		onClose(listener) {
			ownClose.add(listener);
			return { dispose: () => ownClose.delete(listener) };
		},
		close() {
			for (const listener of ownClose) listener(new Error('closed'));
		},
	});
	return [make(listenersA, listenersB, closeA), make(listenersB, listenersA, closeB)];
}

describe('JsonRpcPeer', () => {
	it('resolves requests and maps JSON-RPC errors', async () => {
		const [a, b] = createPair();
		const peerA = new JsonRpcPeer(a);
		const peerB = new JsonRpcPeer(b);
		peerB.onRequest('echo', (params) => ({ echo: params }));
		peerB.onRequest('fail', () => {
			throw new Error('boom');
		});
		await expect(peerA.request('echo', { value: 1 })).resolves.toEqual({ echo: { value: 1 } });
		const failure = await peerA.request('fail').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RpcError);
		expect((failure as RpcError).code).toBe(-32603);
	});

	it('answers unknown server requests with method-not-found', async () => {
		const [a, b] = createPair();
		const peerA = new JsonRpcPeer(a);
		const peerB = new JsonRpcPeer(b);
		const failure = await peerB.request('missing/method').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RpcError);
		expect((failure as RpcError).code).toBe(-32601);
		peerA.dispose();
	});

	it('delivers notifications and tolerates unknown ones', () => {
		const [a, b] = createPair();
		const peerA = new JsonRpcPeer(a);
		const peerB = new JsonRpcPeer(b);
		const received: unknown[] = [];
		peerB.onNotification('session/update', (params) => received.push(params));
		peerA.notify('session/update', { sessionId: 's1', update: { sessionUpdate: 'whatever' } });
		peerA.notify('unknown/notification', {});
		expect(received).toEqual([{ sessionId: 's1', update: { sessionUpdate: 'whatever' } }]);
		peerA.dispose();
		peerB.dispose();
	});

	it('dispatches JSON-RPC batch messages', () => {
		const [a, b] = createPair();
		const peerB = new JsonRpcPeer(b);
		const received: unknown[] = [];
		peerB.onNotification('x', (params) => received.push(params));
		a.send([
			{ jsonrpc: '2.0', method: 'x', params: 1 },
			{ jsonrpc: '2.0', method: 'x', params: 2 },
		]);
		expect(received).toEqual([1, 2]);
		peerB.dispose();
	});

	it('times out slow requests and rejects pending requests on close', async () => {
		const [a, b] = createPair();
		const peerA = new JsonRpcPeer(a);
		const peerB = new JsonRpcPeer(b);
		peerB.onRequest('slow', () => new Promise(() => undefined));
		await expect(peerA.request('slow', undefined, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
		const pending = peerA.request('slow');
		peerA.dispose(new Error('transport gone'));
		await expect(pending).rejects.toThrow(/transport gone/);
		peerB.dispose();
	});
});
