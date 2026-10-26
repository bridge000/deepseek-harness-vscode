import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPermissionBroker } from '../src/ui/permissionBroker';
import type { PermissionRequest } from '../src/types';

function request(id = 'p1', title = '写文件'): PermissionRequest {
	return {
		id,
		sessionId: 's1',
		title,
		toolKind: 'edit',
		locations: [{ path: 'src/a.ts', line: 1 }],
		options: [
			{ optionId: 'allow1', name: '允许一次', kind: 'allow_once' },
			{ optionId: 'reject1', name: '拒绝', kind: 'reject_once' },
		],
	};
}

function setup(overrides: Partial<Parameters<typeof createPermissionBroker>[0]> = {}) {
	const posted: PermissionRequest[] = [];
	const modalCalls: PermissionRequest[] = [];
	const logs: string[] = [];
	const visible = { value: true };
	const modalResult = { value: 'reject1' as string | undefined };
	const broker = createPermissionBroker({
		isViewVisible: () => visible.value,
		postPermission: (r) => posted.push(r),
		modalPick: async (r) => {
			modalCalls.push(r);
			return modalResult.value;
		},
		autoApprove: () => false,
		log: (line) => logs.push(line),
		timeoutMs: 5000,
		...overrides,
	});
	return { broker, posted, modalCalls, logs, visible, modalResult };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('permissionBroker', () => {
	it('posts a card when visible and resolves with the selected option', async () => {
		const { broker, posted, modalCalls } = setup();
		const promise = broker.pick(request());
		expect(posted).toHaveLength(1);
		expect(modalCalls).toHaveLength(0);
		broker.respond('p1', 'allow1');
		await expect(promise).resolves.toBe('allow1');
		expect(broker.pending()).toBe(0);
	});

	it('uses the modal picker while the sidebar is hidden', async () => {
		const { broker, posted, modalCalls, visible, modalResult } = setup();
		visible.value = false;
		modalResult.value = 'allow1';
		await expect(broker.pick(request())).resolves.toBe('allow1');
		expect(posted).toHaveLength(0);
		expect(modalCalls).toHaveLength(1);
	});

	it('auto approves the first allow_* option', async () => {
		const { broker, posted } = setup({ autoApprove: () => true });
		await expect(broker.pick(request())).resolves.toBe('allow1');
		expect(posted).toHaveLength(0);
	});

	it('falls back to the card when autoApprove is on but there is no allow option', async () => {
		const { broker, posted } = setup({ autoApprove: () => true });
		const noAllow: PermissionRequest = request('p2');
		noAllow.options = [{ optionId: 'reject1', name: '拒绝', kind: 'reject_once' }];
		const promise = broker.pick(noAllow);
		expect(posted).toHaveLength(1);
		broker.respond('p2', 'reject1');
		await expect(promise).resolves.toBe('reject1');
	});

	it('ignores responses for unknown or already settled requests', async () => {
		const { broker, posted, logs } = setup();
		const promise = broker.pick(request());
		broker.respond('nope', 'allow1');
		broker.respond('p1', 'allow1');
		broker.respond('p1', 'reject1');
		await expect(promise).resolves.toBe('allow1');
		expect(posted).toHaveLength(1);
		expect(logs.some((line) => line.includes('未知或已过期'))).toBe(true);
	});

	it('cancels pending cards on cancelAll', async () => {
		const { broker } = setup();
		const first = broker.pick(request('p1'));
		const second = broker.pick(request('p2'));
		expect(broker.pending()).toBe(2);
		broker.cancelAll('测试取消');
		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(broker.pending()).toBe(0);
	});

	it('cancels a visible card after the timeout', async () => {
		vi.useFakeTimers();
		const { broker, logs } = setup();
		const promise = broker.pick(request());
		vi.advanceTimersByTime(5000);
		await expect(promise).resolves.toBeUndefined();
		expect(logs.some((line) => line.includes('超时'))).toBe(true);
	});

	it('falls back to the modal picker when the card times out and the view is hidden', async () => {
		vi.useFakeTimers();
		const { broker, visible, modalCalls, modalResult } = setup();
		visible.value = true;
		const promise = broker.pick(request());
		visible.value = false;
		modalResult.value = 'allow1';
		vi.advanceTimersByTime(5000);
		await vi.runAllTimersAsync();
		await expect(promise).resolves.toBe('allow1');
		expect(modalCalls).toHaveLength(1);
	});

	it('falls back to the modal picker when posting the card throws', async () => {
		const { broker, modalCalls, modalResult } = setup({
			postPermission: () => {
				throw new Error('webview gone');
			},
		});
		modalResult.value = 'reject1';
		await expect(broker.pick(request())).resolves.toBe('reject1');
		expect(modalCalls).toHaveLength(1);
	});
});
