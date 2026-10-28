import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionService, SessionServiceOptions } from '../src/acp/contracts';
import { JsonRpcPeer, type TransportLike } from '../src/acp/jsonrpc';
import type { JsonRpcMessage } from '../src/acp/protocol';
import type { DshRuntimeWithCapabilities } from '../src/acp/runtime';
import type { AcpCapabilities, PermissionRequest, RuntimeState } from '../src/types';
import { createSessionService } from '../src/session/manager';

type SentMessage = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};

class FakeTransport implements TransportLike {
	readonly sent: JsonRpcMessage[] = [];
	closed = false;
	private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();

	send(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (this.closed) throw new Error('transport closed');
		for (const item of Array.isArray(message) ? message : [message]) this.sent.push(item);
	}

	onMessage(listener: (message: JsonRpcMessage) => void): { dispose(): void } {
		this.messageListeners.add(listener);
		return { dispose: () => this.messageListeners.delete(listener) };
	}

	onClose(listener: (error?: Error) => void): { dispose(): void } {
		this.closeListeners.add(listener);
		return { dispose: () => this.closeListeners.delete(listener) };
	}

	close(): void {
		this.closed = true;
		for (const listener of this.closeListeners) listener();
	}

	inject(message: JsonRpcMessage): void {
		for (const listener of this.messageListeners) listener(message);
	}

	respond(id: number | string, result: unknown): void {
		this.inject({ jsonrpc: '2.0', id, result } as JsonRpcMessage);
	}

	respondError(id: number | string, code: number, message: string): void {
		this.inject({ jsonrpc: '2.0', id, error: { code, message } } as JsonRpcMessage);
	}

	requests(method: string): SentMessage[] {
		return this.sent.filter((message) => (message as SentMessage).method === method) as SentMessage[];
	}

	request(method: string): SentMessage | undefined {
		return this.requests(method)[0];
	}

	lastRequest(method: string): SentMessage | undefined {
		const list = this.requests(method);
		return list[list.length - 1];
	}

	notifications(method: string): SentMessage[] {
		return (this.sent as SentMessage[]).filter((message) => message.method === method && message.id === undefined);
	}
}

interface Harness {
	transport: FakeTransport;
	peer: JsonRpcPeer;
	service: SessionService;
	events: SessionEvent[];
	logs: string[];
	state: RuntimeState;
	capabilityPatches: Partial<AcpCapabilities>[];
}

function createHarness(overrides: Partial<SessionServiceOptions> & { capabilities?: Partial<AcpCapabilities> } = {}): Harness {
	const { capabilities, ...serviceOptions } = overrides;
	const transport = new FakeTransport();
	const peer = new JsonRpcPeer(transport, () => undefined);
	const state: RuntimeState = {
		phase: 'ready',
		profile: 'acp',
		protocolVersion: 1,
		capabilities: {
			sessionList: true,
			sessionResume: true,
			sessionClose: true,
			modelConfig: true,
			reasoningConfig: true,
			imagePrompts: false,
			...capabilities,
		},
	};
	const events: SessionEvent[] = [];
	const logs: string[] = [];
	const capabilityPatches: Partial<AcpCapabilities>[] = [];
	const runtime: DshRuntimeWithCapabilities = {
		state: () => state,
		onDidChangeState: () => ({ dispose: () => undefined }),
		start: async () => state,
		restart: async () => state,
		stop: async () => undefined,
		peer: () => peer,
		probe: () => undefined,
		setProbe: () => undefined,
		updateCapabilities: (patch) => {
			capabilityPatches.push(patch);
		},
	};
	const service = createSessionService(runtime, {
		cwd: () => 'C:\\workspace',
		onEvent: (event) => events.push(event),
		log: (line) => logs.push(line),
		...serviceOptions,
	});
	return { transport, peer, service, events, logs, state, capabilityPatches };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor<T>(probe: () => T | undefined, description: string, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
		await flush();
	}
}

async function waitForRequest(transport: FakeTransport, method: string, afterId?: number | string): Promise<SentMessage> {
	return waitFor(
		() => transport.requests(method).find((request) => request.id !== afterId),
		`请求 ${method}`,
	);
}

async function waitForResponse(transport: FakeTransport, id: number | string): Promise<SentMessage> {
	return waitFor(
		() => (transport.sent as SentMessage[]).find((message) => message.id === id && (message.result !== undefined || message.error !== undefined)),
		`响应 id=${String(id)}`,
	);
}

const SESSION_ID = 'session-1';

const CONFIG_OPTIONS = [
	{
		id: 'model',
		name: 'Model',
		category: 'model',
		type: 'select',
		currentValue: '["deepseek-official","deepseek-v4-flash"]',
		options: [
			{
				group: 'deepseek-official',
				name: 'DeepSeek',
				options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }],
			},
		],
	},
	{ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'off', name: 'Off' }] },
];

async function createSession(harness: Harness): Promise<void> {
	const pending = harness.service.create('C:\\workspace');
	const request = await waitForRequest(harness.transport, 'session/new');
	harness.transport.respond(request.id as number, { sessionId: SESSION_ID, configOptions: CONFIG_OPTIONS });
	await pending;
}

async function startPrompt(harness: Harness, text = '你好'): Promise<{ outcome: Promise<unknown>; request: SentMessage }> {
	const outcome = harness.service.prompt(SESSION_ID, [{ type: 'text', text }]);
	const request = await waitForRequest(harness.transport, 'session/prompt');
	return { outcome, request };
}

async function startAndFinishPrompt(harness: Harness, text = '你好'): Promise<void> {
	const { outcome, request } = await startPrompt(harness, text);
	harness.transport.respond(request.id as number, { stopReason: 'end_turn' });
	await outcome;
}

function pushUpdate(harness: Harness, update: Record<string, unknown>, sessionId = SESSION_ID): void {
	harness.transport.inject({
		jsonrpc: '2.0',
		method: 'session/update',
		params: { sessionId, update },
	} as JsonRpcMessage);
}

describe('session create/resume/list', () => {
	it('create 发送 session/new 并归一化 configOptions', async () => {
		const h = createHarness();
		await createSession(h);
		const active = h.service.active();
		expect(active?.sessionId).toBe(SESSION_ID);
		expect(active?.configOptions.map((option) => option.id)).toEqual(['model', 'reasoning_effort']);
		expect(h.events.some((event) => event.type === 'session')).toBe(true);
		expect(h.events.some((event) => event.type === 'configOptions')).toBe(true);
		// initialize 不带 configOptions，首个会话创建后要回填模型/推理能力。
		expect(h.capabilityPatches.at(-1)).toEqual({ modelConfig: true, reasoningConfig: true });
	});

	it('list 归一化会话历史；-32601 时降级为空数组', async () => {
		const h = createHarness();
		await createSession(h);
		const pending = h.service.list('C:\\workspace');
		const request = await waitForRequest(h.transport, 'session/list');
		h.transport.respond(request.id as number, {
			sessions: [
				{ sessionId: 'a', cwd: 'C:\\workspace', title: '修复 bug', updatedAt: '2026-10-26T00:00:00.000Z' },
				{ sessionId: 'b', cwd: 'C:\\workspace', updatedAt: 1761436800000 },
				{ cwd: 'C:\\workspace' },
			],
		});
		await expect(pending).resolves.toEqual([
			{ sessionId: 'a', cwd: 'C:\\workspace', title: '修复 bug', updatedAt: '2026-10-26T00:00:00.000Z' },
			{ sessionId: 'b', cwd: 'C:\\workspace', title: undefined, updatedAt: new Date(1761436800000).toISOString() },
		]);

		const degraded = h.service.list();
		const degradedRequest = await waitForRequest(h.transport, 'session/list', request.id);
		h.transport.respondError(degradedRequest.id as number, -32601, 'Method not found');
		await expect(degraded).resolves.toEqual([]);
	});

	it('resume 在 -32601 或未声明能力时退化为本地恢复', async () => {
		const h = createHarness();
		await createSession(h);
		const pending = h.service.resume('old-session');
		const request = await waitForRequest(h.transport, 'session/resume');
		h.transport.respondError(request.id as number, -32601, 'Method not found');
		const session = await pending;
		expect(session.sessionId).toBe('old-session');
		expect(session.configOptions).toEqual([]);

		const noResume = createHarness({ capabilities: { sessionResume: false } });
		const local = await noResume.service.resume('local-session', 'C:\\workspace');
		expect(local.sessionId).toBe('local-session');
		expect(noResume.transport.requests('session/resume')).toHaveLength(0);
		expect(noResume.logs.some((line) => line.includes('session/resume'))).toBe(true);
	});

	it('close 发送 session/close；-32601 时只记录日志', async () => {
		const h = createHarness();
		await createSession(h);
		const pending = h.service.close();
		const request = await waitForRequest(h.transport, 'session/close');
		h.transport.respondError(request.id as number, -32601, 'Method not found');
		await expect(pending).resolves.toBeUndefined();
		expect(h.service.active()).toBeUndefined();
		expect(h.logs.some((line) => line.includes('session/close'))).toBe(true);
	});
});

describe('session prompt 事件映射', () => {
	it('user entry + 流式 assistant 累积 + busy 复位 + stopReason', async () => {
		const h = createHarness();
		await createSession(h);
		const { outcome, request } = await startPrompt(h, '请审查 a.ts');
		expect(h.events.some((event) => event.type === 'busy' && event.busy)).toBe(true);
		const userEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'user');
		expect(userEntry).toMatchObject({ type: 'entry', entry: { kind: 'user', text: '请审查 a.ts' } });

		pushUpdate(h, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '你' } });
		pushUpdate(h, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '好' } });
		pushUpdate(h, { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: '思考中' } });
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });

		const assistantEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'assistant');
		expect(assistantEntry).toMatchObject({ type: 'entry', entry: { kind: 'assistant', text: '' } });
		const assistantId = assistantEntry && assistantEntry.type === 'entry' ? assistantEntry.entry.id : '';
		const textPatches = h.events
			.flatMap((event) => (event.type === 'entryPatch' ? [event] : []))
			.filter((event) => event.id === assistantId && 'text' in event.patch);
		expect(textPatches.at(-1)).toMatchObject({ patch: { text: '你好', streaming: true } });
		expect(h.events.some((event) => event.type === 'entry' && event.entry.kind === 'thought')).toBe(true);
		// 结束时所有流式 entry 都要置 streaming=false，最后 busy=false。
		expect(h.events.some((event) => event.type === 'entryPatch' && event.patch.streaming === false)).toBe(true);
		expect(h.events.at(-1)).toEqual({ type: 'busy', busy: false });
	});

	it('长 prompt 的 user 气泡只保留摘要，但发给 agent 的 blocks 保持完整', async () => {
		const h = createHarness();
		await createSession(h);
		const longText = '上下文'.repeat(400);
		const { outcome, request } = await startPrompt(h, longText);
		const userEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'user');
		const displayText = userEntry && userEntry.type === 'entry' ? userEntry.entry.text : '';
		expect(displayText.length).toBeLessThan(700);
		expect(displayText.endsWith('…（已附带 1200 字符上下文）')).toBe(true);
		expect(displayText.startsWith('上下文')).toBe(true);
		const sent = (request.params as { prompt: unknown[] }).prompt;
		expect(sent).toEqual([{ type: 'text', text: longText }]);
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it("userEntry: 'none' 时不产生 user 条目，assistant 与 busy 事件保持不变", async () => {
		const h = createHarness();
		await createSession(h);
		const outcome = h.service.prompt(SESSION_ID, [{ type: 'text', text: '请审查 src/a.ts' }], { userEntry: 'none' });
		const request = await waitForRequest(h.transport, 'session/prompt');
		expect(h.events.some((event) => event.type === 'busy' && event.busy)).toBe(true);
		expect(h.events.some((event) => event.type === 'entry' && event.entry.kind === 'user')).toBe(false);

		pushUpdate(h, { sessionUpdate: 'agent_message_chunk', messageId: 'm-none', content: { type: 'text', text: '好的' } });
		expect(h.events.some((event) => event.type === 'entry' && event.entry.kind === 'assistant')).toBe(true);

		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
		expect(h.events.at(-1)).toEqual({ type: 'busy', busy: false });
		// 显示层隐藏用户条目，但不影响发给 agent 的完整 blocks。
		expect((request.params as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: '请审查 src/a.ts' }]);
	});

	it('userEntry 为字符串时气泡文本精确等于该字符串，不含提示词正文，refs 仍来自 blocks', async () => {
		const h = createHarness();
		await createSession(h);
		const promptBody = `请以严格标准审查以下代码：${'const a = 1;'.repeat(80)}`;
		const outcome = h.service.prompt(
			SESSION_ID,
			[
				{ type: 'text', text: promptBody },
				{ type: 'resource_link', uri: 'file:///workspace/src/a.ts', name: 'src/a.ts' },
			],
			{ userEntry: '审查 src/a.ts' },
		);
		const request = await waitForRequest(h.transport, 'session/prompt');
		const userEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'user');
		expect(userEntry).toMatchObject({ type: 'entry', entry: { kind: 'user', text: '审查 src/a.ts' } });
		if (userEntry && userEntry.type === 'entry') {
			expect(userEntry.entry.text).toBe('审查 src/a.ts');
			expect(userEntry.entry.text).not.toContain('严格标准');
			expect(userEntry.entry.refs).toEqual([{ name: 'src/a.ts', uri: 'file:///workspace/src/a.ts' }]);
		}
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it('不传 options 时 user 气泡仍按现有 auto 摘要行为渲染', async () => {
		const h = createHarness();
		await createSession(h);
		const longText = '上下文'.repeat(400);
		const { outcome, request } = await startPrompt(h, longText);
		const userEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'user');
		const displayText = userEntry && userEntry.type === 'entry' ? userEntry.entry.text : '';
		expect(userEntry).toMatchObject({ type: 'entry', entry: { kind: 'user', text: expect.stringContaining('…（已附带 1200 字符上下文）') } });
		expect(displayText.length).toBeLessThan(700);
		expect(displayText.startsWith('上下文')).toBe(true);
		expect((request.params as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: longText }]);
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it('dispose 时在飞 prompt 兜底发布 busy=false', async () => {
		const h = createHarness();
		await createSession(h);
		const { outcome, request } = await startPrompt(h);
		const settled = outcome.catch((error: unknown) => error as Error);
		await h.service.dispose();
		expect(h.events.at(-1)).toEqual({ type: 'busy', busy: false });
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await settled;
	});

	it('tool_call 转 entry，tool_call_update 转 entryPatch', async () => {
		const h = createHarness();
		await createSession(h);
		pushUpdate(h, {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-1',
			title: '读取 a.ts',
			kind: 'read',
			status: 'in_progress',
			locations: [{ path: 'src/a.ts', line: 3 }],
			rawInput: { command: 'cat src/a.ts' },
		});
		pushUpdate(h, {
			sessionUpdate: 'tool_call_update',
			toolCallId: 'call-1',
			status: 'completed',
			content: [{ type: 'text', text: '读取完成' }],
		});
		const toolEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'tool');
		expect(toolEntry).toMatchObject({
			type: 'entry',
			entry: { kind: 'tool', id: 'tool:call-1', toolCallId: 'call-1', toolKind: 'read', title: '读取 a.ts', status: 'in_progress' },
		});
		expect(h.events.some((event) => event.type === 'entryPatch' && event.id === 'tool:call-1' && event.patch.status === 'completed')).toBe(true);
	});

	it('usage_update 兼容 used/size，config_option_update 发 configOptions', async () => {
		const h = createHarness();
		await createSession(h);
		pushUpdate(h, { sessionUpdate: 'usage_update', used: 20511, size: 1000000 });
		expect(h.events.find((event) => event.type === 'usage')).toEqual({
			type: 'usage',
			usage: { totalTokens: 20511, contextSize: 1000000 },
		});

		const before = h.events.filter((event) => event.type === 'configOptions').length;
		pushUpdate(h, {
			sessionUpdate: 'config_option_update',
			configOptions: [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] }],
		});
		expect(h.events.filter((event) => event.type === 'configOptions').length).toBe(before + 1);
		expect(h.service.active()?.configOptions[0]).toMatchObject({ id: 'reasoning_effort', currentValue: 'low' });
	});

	it('usage_update 的 size 保留为 contextSize（嵌套 usage 形状）', async () => {
		const h = createHarness();
		await createSession(h);
		pushUpdate(h, { sessionUpdate: 'usage_update', usage: { used: 1200, size: 16000 } });
		const usageEvent = h.events.find((event) => event.type === 'usage');
		expect(usageEvent).toMatchObject({ type: 'usage', usage: { totalTokens: 1200, contextSize: 16000 } });
	});

	it('image content block 生成 kind=image 的 user refs，且原样发给 agent', async () => {
		const h = createHarness();
		await createSession(h);
		const imageBlock = {
			type: 'image' as const,
			data: 'aGVsbG8=',
			mimeType: 'image/png',
			uri: 'file:///C:/x/a.png',
		};
		const outcome = h.service.prompt(
			SESSION_ID,
			[{ type: 'text', text: '请描述这张图' }, imageBlock],
			{ userEntry: '看下图' },
		);
		const request = await waitForRequest(h.transport, 'session/prompt');
		const userEntry = h.events.find((event) => event.type === 'entry' && event.entry.kind === 'user');
		expect(userEntry).toMatchObject({ type: 'entry', entry: { kind: 'user', text: '看下图' } });
		if (userEntry && userEntry.type === 'entry') {
			expect(userEntry.entry.refs).toEqual([
				{ name: 'a.png', uri: 'file:///C:/x/a.png', kind: 'image', mimeType: 'image/png' },
			]);
		}
		expect((request.params as { prompt: unknown[] }).prompt[1]).toEqual(imageBlock);
		h.transport.respond(request.id as number, { stopReason: 'end_turn' });
		await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it('未知 sessionUpdate 与其它会话的通知被忽略并记录日志', async () => {
		const h = createHarness();
		await createSession(h);
		const entryCount = h.events.filter((event) => event.type === 'entry').length;
		pushUpdate(h, { sessionUpdate: 'plan_update', plan: [] });
		expect(h.logs.some((line) => line.includes('未知 sessionUpdate'))).toBe(true);
		expect(h.events.filter((event) => event.type === 'entry')).toHaveLength(entryCount);

		await startPrompt(h);
		const request = h.transport.lastRequest('session/prompt');
		pushUpdate(h, { sessionUpdate: 'agent_message_chunk', messageId: 'other', content: { type: 'text', text: '串台' } }, 'other-session');
		expect(h.events.filter((event) => event.type === 'entry' && event.entry.kind === 'assistant')).toHaveLength(0);
		h.transport.respond(request?.id as number, { stopReason: 'end_turn' });
		await flush();
	});
});

describe('session 权限请求', () => {
	const permissionParams = {
		sessionId: SESSION_ID,
		toolCall: {
			toolCallId: 'call-9',
			title: '执行命令',
			kind: 'execute',
			locations: [{ path: 'src/a.ts' }],
			rawInput: { command: 'npm test' },
		},
		options: [
			{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
			{ optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
		],
	};

	async function sendPermission(harness: Harness, id: number, params: unknown = permissionParams): Promise<SentMessage> {
		harness.transport.inject({ jsonrpc: '2.0', id, method: 'session/request_permission', params } as JsonRpcMessage);
		return waitForResponse(harness.transport, id);
	}

	it('pickPermission 返回 optionId 时回传 selected', async () => {
		const picked: PermissionRequest[] = [];
		const h = createHarness({
			pickPermission: async (request) => {
				picked.push(request);
				return 'allow-once';
			},
		});
		await createSession(h);
		const response = await sendPermission(h, 71);
		expect(response.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
		expect(picked[0]).toMatchObject({ sessionId: SESSION_ID, title: '执行命令', toolKind: 'execute', command: 'npm test' });
		expect(picked[0].locations).toEqual([{ path: 'src/a.ts', line: undefined }]);
	});

	it('autoApprove 时自动选第一个 allow 选项，不调用 pickPermission', async () => {
		let called = 0;
		const h = createHarness({
			autoApprove: () => true,
			pickPermission: async () => {
				called += 1;
				return 'reject-once';
			},
		});
		await createSession(h);
		const response = await sendPermission(h, 72);
		expect(response.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
		expect(called).toBe(0);
	});

	it('没有 pickPermission 时选择第一个 reject 选项（保守拒绝）', async () => {
		const h = createHarness();
		await createSession(h);
		const response = await sendPermission(h, 73);
		expect(response.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
	});

	it('既无 allow/reject 选项也无 pickPermission 时返回 cancelled', async () => {
		const h = createHarness();
		await createSession(h);
		const response = await sendPermission(h, 74, {
			sessionId: SESSION_ID,
			toolCall: { toolCallId: 'x', title: '未知操作' },
			options: [{ optionId: 'other', name: '其它', kind: 'other' }],
		});
		expect(response.result).toEqual({ outcome: { outcome: 'cancelled' } });
	});

	it('pickPermission 返回 undefined 时按取消处理', async () => {
		const h = createHarness({ pickPermission: async () => undefined });
		await createSession(h);
		const response = await sendPermission(h, 75);
		expect(response.result).toEqual({ outcome: { outcome: 'cancelled' } });
	});
});

describe('session 单飞/排队/取消/-32601 降级', () => {
	it('prompt 忙时排队，前一个结束后自动执行', async () => {
		const h = createHarness();
		await createSession(h);
		const first = await startPrompt(h, '第一');
		const secondOutcome = h.service.prompt(SESSION_ID, [{ type: 'text', text: '第二' }]);
		await flush();
		expect(h.transport.requests('session/prompt')).toHaveLength(1);
		expect(h.logs.some((line) => line.includes('排队'))).toBe(true);

		h.transport.respond(first.request.id as number, { stopReason: 'end_turn' });
		await expect(first.outcome).resolves.toEqual({ stopReason: 'end_turn' });
		const secondRequest = await waitForRequest(h.transport, 'session/prompt', first.request.id);
		expect((secondRequest.params as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: '第二' }]);
		h.transport.respond(secondRequest.id as number, { stopReason: 'end_turn' });
		await expect(secondOutcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it('排队中的 prompt 出队后仍按各自的 userEntry 策略渲染', async () => {
		const h = createHarness();
		await createSession(h);
		const first = await startPrompt(h, '第一');
		const secondOutcome = h.service.prompt(SESSION_ID, [{ type: 'text', text: '第二' }], { userEntry: 'none' });
		await flush();
		expect(h.events.filter((event) => event.type === 'entry' && event.entry.kind === 'user')).toHaveLength(1);

		h.transport.respond(first.request.id as number, { stopReason: 'end_turn' });
		await expect(first.outcome).resolves.toEqual({ stopReason: 'end_turn' });
		const secondRequest = await waitForRequest(h.transport, 'session/prompt', first.request.id);
		// 第二个 prompt 明确 none：出队执行后不应再新增 user 条目。
		expect(h.events.filter((event) => event.type === 'entry' && event.entry.kind === 'user')).toHaveLength(1);
		expect((secondRequest.params as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: '第二' }]);
		h.transport.respond(secondRequest.id as number, { stopReason: 'end_turn' });
		await expect(secondOutcome).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it('cancel 发送 session/cancel 通知并清空排队', async () => {
		const h = createHarness();
		await createSession(h);
		const first = await startPrompt(h, '第一');
		const second = h.service.prompt(SESSION_ID, [{ type: 'text', text: '第二' }]);
		const secondSettled = second.catch((error: unknown) => error as Error);
		await flush();
		h.service.cancel(SESSION_ID);
		expect(h.transport.notifications('session/cancel')).toHaveLength(1);
		expect((h.transport.notifications('session/cancel')[0].params as { sessionId: string }).sessionId).toBe(SESSION_ID);
		expect(await secondSettled).toBeInstanceOf(Error);
		expect((await secondSettled).message).toContain('取消');

		h.transport.respond(first.request.id as number, { stopReason: 'cancelled' });
		await expect(first.outcome).resolves.toEqual({ stopReason: 'cancelled' });
		expect(h.events.at(-1)).toEqual({ type: 'busy', busy: false });
	});

	it('setConfig 正常返回新配置；-32601 时本地回写 currentValue', async () => {
		const h = createHarness();
		await createSession(h);
		const pending = h.service.setConfig('reasoning_effort', 'low');
		const request = await waitForRequest(h.transport, 'session/set_config_option');
		h.transport.respond(request.id as number, {
			configOptions: [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] }],
		});
		const options = await pending;
		expect(options[0]).toMatchObject({ id: 'reasoning_effort', currentValue: 'low' });

		const degraded = h.service.setConfig('reasoning_effort', 'max');
		const degradedRequest = await waitForRequest(h.transport, 'session/set_config_option', request.id);
		h.transport.respondError(degradedRequest.id as number, -32601, 'Method not found');
		const local = await degraded;
		expect(local[0]).toMatchObject({ id: 'reasoning_effort', currentValue: 'max' });
		expect(h.logs.some((line) => line.includes('set_config_option'))).toBe(true);
	});

	it('prompt 收到错误时发 error 事件并复位 busy', async () => {
		const h = createHarness();
		await createSession(h);
		const { outcome, request } = await startPrompt(h);
		h.transport.respondError(request.id as number, -32603, 'internal exploded');
		await expect(outcome).rejects.toThrow('internal exploded');
		expect(h.events.some((event) => event.type === 'error' && event.message.includes('internal exploded'))).toBe(true);
		expect(h.events.at(-1)).toEqual({ type: 'busy', busy: false });
	});
});
