/**
 * 会话层：把 ACP 的 `session/*` 方法与会话通知翻译成 UI 可见的 SessionEvent。
 *
 * 关键设计：
 * - peer 可能因 runtime.restart() 被替换，所以通知/请求处理器按 peer 实例懒注册。
 * - prompt 单飞：同一时刻只允许一个 prompt 在飞，其余排队（DSH 侧也是串行语义）。
 * - 收到 -32601（方法不存在）时降级而不是报错，兼容旧版 DSH。
 */
import type {
	ActiveSession,
	ConfigOption,
	ContextRef,
	PermissionRequest,
	PermissionOptionInfo,
	SessionInfo,
	ToolLocation,
	ToolStatus,
	TranscriptEntry,
	UsageInfo,
} from '../types';
import type {
	DshRuntime,
	PromptDisplayOptions,
	PromptOutcome,
	SessionEvent,
	SessionService,
	SessionServiceOptions,
} from '../acp/contracts';
import { JsonRpcPeer, RpcError } from '../acp/jsonrpc';
import type { DshRuntimeWithCapabilities } from '../acp/runtime';
import {
	ACP_METHODS,
	RPC_ERROR,
	contentToText,
	findConfigOption,
	normalizeConfigOptions,
	type AcpListSessionsResult,
	type AcpNewSessionResult,
	type AcpPromptResult,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpResumeSessionResult,
	type AcpSessionNotification,
	type AcpSetConfigOptionResult,
	type AcpToolCall,
	type ContentBlock,
	type ContentImage,
} from '../acp/protocol';
import { refNameFromUri } from '../context/media';

const MAX_DETAIL_CHARS = 2000;
const MAX_COMMAND_CHARS = 400;

let entryCounter = 0;

/** 生成不重复的本地 entry id（跨 session 也唯一，便于 UI 按 id upsert）。 */
function nextId(prefix: string): string {
	entryCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${entryCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function toolEntryId(toolCallId: string): string {
	return `tool:${toolCallId}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMethodNotFound(error: unknown): boolean {
	return error instanceof RpcError && error.code === RPC_ERROR.methodNotFound;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeToolStatus(value: unknown): ToolStatus {
	switch (value) {
		case 'completed':
			return 'completed';
		case 'failed':
			return 'failed';
		case 'in_progress':
			return 'in_progress';
		case 'pending':
			return 'pending';
		// 兼容部分 DSH/ACP 实现使用的别名。
		case 'running':
			return 'in_progress';
		case 'success':
		case 'succeeded':
			return 'completed';
		case 'error':
			return 'failed';
		default:
			return 'pending';
	}
}

function normalizeLocations(raw: unknown): ToolLocation[] {
	if (!Array.isArray(raw)) return [];
	const locations: ToolLocation[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const record = item as { path?: unknown; line?: unknown };
		const filePath = asString(record.path);
		if (!filePath) continue;
		locations.push({ path: filePath, line: typeof record.line === 'number' ? record.line : undefined });
	}
	return locations;
}

function summarizeDetail(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		if (!text) return undefined;
		return truncate(text, MAX_DETAIL_CHARS);
	} catch {
		return undefined;
	}
}

/** tool_call_update 的 content 是 ACP 内容块数组，优先取其中的文本摘要。 */
function summarizeContentDetail(content: unknown): string | undefined {
	if (Array.isArray(content)) {
		const text = contentToText(content);
		return text.trim().length > 0 ? truncate(text, MAX_DETAIL_CHARS) : undefined;
	}
	if (typeof content === 'string') {
		return content.trim().length > 0 ? truncate(content, MAX_DETAIL_CHARS) : undefined;
	}
	return undefined;
}

function extractCommand(toolCall: AcpToolCall | undefined): string | undefined {
	if (!toolCall) return undefined;
	const rawInput = toolCall.rawInput;
	if (typeof rawInput === 'string') return truncate(rawInput, MAX_COMMAND_CHARS);
	if (rawInput && typeof rawInput === 'object') {
		const record = rawInput as Record<string, unknown>;
		for (const key of ['command', 'cmd', 'script']) {
			const value = record[key];
			if (typeof value === 'string' && value.length > 0) return truncate(value, MAX_COMMAND_CHARS);
		}
	}
	return undefined;
}

function normalizeUsage(raw: unknown): UsageInfo | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const pick = (key: string): number | undefined => (typeof record[key] === 'number' ? (record[key] as number) : undefined);
	const inputTokens = pick('inputTokens') ?? pick('input_tokens');
	const outputTokens = pick('outputTokens') ?? pick('output_tokens');
	// DSH 的 usage_update 实测形状是 { used, size }（used = 已用上下文，size = 窗口大小）。
	const totalTokens = pick('totalTokens') ?? pick('total_tokens') ?? pick('used');
	const contextSize = pick('size') ?? pick('contextSize') ?? pick('context_size');
	if (
		inputTokens === undefined &&
		outputTokens === undefined &&
		totalTokens === undefined &&
		contextSize === undefined
	) {
		return undefined;
	}
	return { inputTokens, outputTokens, totalTokens, contextSize };
}

function normalizePermissionOptions(raw: unknown): PermissionOptionInfo[] {
	if (!Array.isArray(raw)) return [];
	const options: PermissionOptionInfo[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const record = item as { optionId?: unknown; name?: unknown; kind?: unknown };
		const optionId = asString(record.optionId);
		if (!optionId) continue;
		options.push({
			optionId,
			name: asString(record.name) ?? optionId,
			kind: asString(record.kind) ?? '',
		});
	}
	return options;
}

function normalizeSessions(raw: unknown): SessionInfo[] {
	if (!Array.isArray(raw)) return [];
	const sessions: SessionInfo[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const record = item as { sessionId?: unknown; cwd?: unknown; title?: unknown; updatedAt?: unknown };
		const sessionId = asString(record.sessionId);
		if (!sessionId) continue;
		const updatedAt =
			typeof record.updatedAt === 'string'
				? record.updatedAt
				: typeof record.updatedAt === 'number'
					? new Date(record.updatedAt).toISOString()
					: undefined;
		sessions.push({
			sessionId,
			cwd: asString(record.cwd) ?? '',
			title: asString(record.title),
			updatedAt,
		});
	}
	return sessions;
}

function collectRefs(blocks: readonly ContentBlock[]): ContextRef[] {
	const refs: ContextRef[] = [];
	for (const block of blocks) {
		// 图片以 ACP image content block 发送：气泡里显示为图片 ref，而不是资源链接。
		if (block.type === 'image') {
			const image = block as ContentImage;
			if (typeof image.uri !== 'string' || image.uri.length === 0) continue;
			refs.push({
				name: refNameFromUri(image.uri),
				uri: image.uri,
				kind: 'image',
				mimeType: typeof image.mimeType === 'string' ? image.mimeType : undefined,
			});
			continue;
		}
		if (block.type !== 'resource_link') continue;
		const link = block as { uri?: unknown; name?: unknown };
		if (typeof link.uri !== 'string') continue;
		refs.push({ name: asString(link.name) ?? link.uri, uri: link.uri });
	}
	return refs;
}

function promptText(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === 'text')
		.map((block) => contentToText(block))
		.join('');
}

/** 侧边栏用户气泡只显示摘要：审查 prompt 可能带 60k 字符上下文，全量渲染会拖垮 webview。 */
const USER_BUBBLE_CHARS = 600;

function fitUserBubble(text: string): string {
	if (text.length <= USER_BUBBLE_CHARS) return text;
	return `${text.slice(0, USER_BUBBLE_CHARS)}…（已附带 ${text.length} 字符上下文）`;
}

/**
 * 按显示策略决定用户条目气泡文本：
 * - `'auto'`（默认）：从 blocks 的 text 块拼出摘要；
 * - `'none'`：不显示用户条目；
 * - string：精确使用该字符串（调用方已自行概括，如「审查 src/a.ts」）。
 * 返回 undefined 表示本次 prompt 不 emit 用户条目。
 */
function userEntryDisplayText(blocks: readonly ContentBlock[], strategy: 'auto' | 'none' | string): string | undefined {
	if (strategy === 'none') return undefined;
	if (strategy === 'auto') return fitUserBubble(promptText(blocks));
	return fitUserBubble(strategy);
}

interface QueuedPrompt {
	sessionId: string;
	blocks: ContentBlock[];
	userEntry: 'auto' | 'none' | string;
	resolve: (outcome: PromptOutcome) => void;
	reject: (error: Error) => void;
}

interface StreamingMessage {
	entryId: string;
	text: string;
}

export function createSessionService(runtime: DshRuntime, options: SessionServiceOptions): SessionService {
	const log = options.log ?? (() => undefined);
	let activeSession: ActiveSession | undefined;
	let currentSessionId: string | undefined;
	const queue: QueuedPrompt[] = [];
	const streaming = new Map<string, StreamingMessage>();
	const knownToolCalls = new Set<string>();
	let boundPeer: JsonRpcPeer | undefined;
	let boundSubscriptions: { dispose(): void }[] = [];
	let closed = false;

	const emit = (event: SessionEvent): void => {
		try {
			options.onEvent(event);
		} catch (error) {
			log(`[session] onEvent 处理失败：${errorText(error)}`);
		}
	};

	/** initialize 不返回 configOptions，所以拿到首个会话配置后回填模型/推理能力。 */
	const updateCapabilityFlags = (configOptions: readonly ConfigOption[]): void => {
		const updatable = runtime as Partial<DshRuntimeWithCapabilities>;
		if (!updatable.updateCapabilities) return;
		updatable.updateCapabilities({
			modelConfig: findConfigOption(configOptions, 'model') !== undefined,
			reasoningConfig: findConfigOption(configOptions, 'reasoning') !== undefined,
		});
	};

	const disposeSubscriptions = (): void => {
		for (const subscription of boundSubscriptions.splice(0)) {
			try {
				subscription.dispose();
			} catch {
				/* 忽略 */
			}
		}
	};

	// ---------- ACP 通知/请求 handlers ----------

	const handleChunk = (kind: 'assistant' | 'thought', update: { content?: unknown; messageId?: unknown }): void => {
		const text = contentToText(update.content);
		if (text.length === 0) return;
		const messageId = asString(update.messageId);
		const key = `${kind}:${messageId ?? 'stream'}`;
		let state = streaming.get(key);
		if (!state) {
			state = { entryId: nextId(kind === 'assistant' ? 'msg' : 'thought'), text: '' };
			streaming.set(key, state);
			const entry: TranscriptEntry =
				kind === 'assistant'
					? { id: state.entryId, kind: 'assistant', text: '', messageId, at: Date.now(), streaming: true }
					: { id: state.entryId, kind: 'thought', text: '', messageId, at: Date.now(), streaming: true };
			emit({ type: 'entry', entry });
		}
		state.text += text;
		// 首条 entry + 后续 patch 累积全文：扩展侧按 id 合并，避免每个 chunk 一条记录。
		emit({ type: 'entryPatch', id: state.entryId, patch: { text: state.text, streaming: true } });
	};

	const handleToolCall = (update: AcpToolCall): void => {
		const toolCallId = asString(update.toolCallId) ?? nextId('tool');
		knownToolCalls.add(toolCallId);
		const entry: TranscriptEntry = {
			id: toolEntryId(toolCallId),
			kind: 'tool',
			toolCallId,
			toolKind: asString(update.kind),
			title: asString(update.title) ?? '工具调用',
			status: normalizeToolStatus(update.status),
			locations: normalizeLocations(update.locations),
			detail: summarizeDetail(update.rawInput),
			at: Date.now(),
		};
		emit({ type: 'entry', entry });
	};

	const handleToolCallUpdate = (update: AcpToolCall & { content?: unknown }): void => {
		const toolCallId = asString(update.toolCallId);
		if (!toolCallId) {
			log('[session] 收到缺少 toolCallId 的 tool_call_update，已忽略');
			return;
		}
		// 没先见过 tool_call 时没有可 patch 的 entry，直接补一条完整 entry。
		if (!knownToolCalls.has(toolCallId)) {
			handleToolCall(update);
			return;
		}
		const patch: Partial<TranscriptEntry> = {};
		const title = asString(update.title);
		if (title) (patch as { title?: string }).title = title;
		if (update.status !== undefined) (patch as { status?: ToolStatus }).status = normalizeToolStatus(update.status);
		if (update.locations !== undefined) (patch as { locations?: ToolLocation[] }).locations = normalizeLocations(update.locations);
		const detail = summarizeContentDetail(update.content) ?? summarizeDetail(update.rawInput);
		if (detail) (patch as { detail?: string }).detail = detail;
		emit({ type: 'entryPatch', id: toolEntryId(toolCallId), patch });
	};

	const applyConfigOptions = (raw: unknown, sessionId?: string): ConfigOption[] => {
		const configOptions = normalizeConfigOptions(raw);
		if (activeSession && sessionId && activeSession.sessionId === sessionId) activeSession.configOptions = configOptions;
		if (configOptions.length > 0) {
			emit({ type: 'configOptions', options: configOptions });
			updateCapabilityFlags(configOptions);
		}
		return configOptions;
	};

	const handleSessionUpdate = (params: unknown): void => {
		const notification = params as AcpSessionNotification | undefined;
		if (!notification || typeof notification !== 'object') return;
		const sessionId = asString(notification.sessionId);
		// 只处理当前会话的通知，避免多个会话的流串到同一条 transcript。
		if (sessionId && currentSessionId && sessionId !== currentSessionId) {
			log(`[session] 忽略非活动会话 ${sessionId} 的更新`);
			return;
		}
		const update = notification.update;
		if (typeof update !== 'object' || update === null) return;
		const record = update as Record<string, unknown>;
		const sessionUpdate = record.sessionUpdate;
		switch (sessionUpdate) {
			case 'agent_message_chunk':
				handleChunk('assistant', record as { content?: unknown; messageId?: unknown });
				return;
			case 'agent_thought_chunk':
				handleChunk('thought', record as { content?: unknown; messageId?: unknown });
				return;
			case 'tool_call':
				handleToolCall(record as AcpToolCall);
				return;
			case 'tool_call_update':
				handleToolCallUpdate(record as AcpToolCall & { content?: unknown });
				return;
			case 'config_option_update': {
				applyConfigOptions(record.configOptions, sessionId);
				return;
			}
			case 'usage_update': {
				const usage = normalizeUsage(record.usage ?? record);
				if (usage) emit({ type: 'usage', usage });
				return;
			}
			default:
				log(`[session] 未知 sessionUpdate「${String(sessionUpdate)}」，已忽略`);
		}
	};

	const handlePermissionRequest = async (params: unknown): Promise<AcpRequestPermissionResult> => {
		const raw = (params ?? {}) as AcpRequestPermissionParams;
		const toolCall = (raw.toolCall ?? {}) as AcpToolCall;
		const sessionId = asString(raw.sessionId) ?? currentSessionId ?? activeSession?.sessionId ?? '';
		const permissionOptions = normalizePermissionOptions(raw.options);
		const request: PermissionRequest = {
			id: nextId('perm'),
			sessionId,
			title: asString(toolCall.title) ?? 'DSH 请求执行权限',
			toolKind: asString(toolCall.kind),
			locations: normalizeLocations(toolCall.locations),
			command: extractCommand(toolCall),
			options: permissionOptions,
		};
		const allow = permissionOptions.find((option) => option.kind.startsWith('allow_'));
		const reject = permissionOptions.find((option) => option.kind.startsWith('reject_'));
		const select = (optionId: string): AcpRequestPermissionResult => ({
			outcome: { outcome: 'selected', optionId },
		});
		const cancelled = (): AcpRequestPermissionResult => ({ outcome: { outcome: 'cancelled' } });

		if (options.autoApprove?.()) {
			if (allow) {
				log(`[session] 自动批准权限请求：${request.title}`);
				return select(allow.optionId);
			}
			log('[session] autoApprove 已开启，但 DSH 未提供 allow 选项，交由用户决定');
		}
		if (options.pickPermission) {
			try {
				const optionId = await options.pickPermission(request);
				if (optionId && permissionOptions.some((option) => option.optionId === optionId)) return select(optionId);
				return cancelled();
			} catch (error) {
				log(`[session] 权限选择器异常，按拒绝处理：${errorText(error)}`);
				return reject ? select(reject.optionId) : cancelled();
			}
		}
		// 没有 UI 时保守处理：优先明确拒绝，其次取消，绝不静默允许。
		if (reject) return select(reject.optionId);
		return cancelled();
	};

	const ensurePeer = (): JsonRpcPeer => {
		const peer = runtime.peer();
		if (boundPeer === peer) return peer;
		// runtime 重启后 peer 是全新实例，旧的 handler 不会生效，必须重新挂载。
		disposeSubscriptions();
		boundPeer = peer;
		boundSubscriptions = [
			peer.onNotification(ACP_METHODS.sessionUpdate, (params) => handleSessionUpdate(params)),
			peer.onRequest(ACP_METHODS.sessionRequestPermission, (params) => handlePermissionRequest(params)),
			peer.onClose(() => {
				if (boundPeer !== peer) return;
				boundPeer = undefined;
				disposeSubscriptions();
			}),
		];
		return peer;
	};

	const ensureReady = async (): Promise<void> => {
		if (runtime.state().phase !== 'ready') await runtime.start();
		const phase = runtime.state().phase;
		if (phase !== 'ready') throw new Error(runtime.state().error ?? 'DSH 运行时未就绪');
	};

	const resolveCwd = (cwd?: string): string => {
		const value = (cwd ?? options.cwd()).trim();
		return value.length > 0 ? value : process.cwd();
	};

	const markStreamingDone = (): void => {
		for (const state of streaming.values()) {
			emit({ type: 'entryPatch', id: state.entryId, patch: { streaming: false } });
		}
		streaming.clear();
	};

	const runPrompt = async (
		sessionId: string,
		blocks: ContentBlock[],
		userEntry: 'auto' | 'none' | string,
	): Promise<PromptOutcome> => {
		currentSessionId = sessionId;
		emit({ type: 'busy', busy: true });
		const bubbleText = userEntryDisplayText(blocks, userEntry);
		if (bubbleText !== undefined) {
			const refs = collectRefs(blocks);
			const entry: TranscriptEntry = {
				id: nextId('user'),
				kind: 'user',
				text: bubbleText,
				refs: refs.length > 0 ? refs : undefined,
				at: Date.now(),
			};
			emit({ type: 'entry', entry });
		}
		try {
			await ensureReady();
			const peer = ensurePeer();
			const result = await peer.request<AcpPromptResult>(ACP_METHODS.sessionPrompt, { sessionId, prompt: blocks });
			return { stopReason: asString(result?.stopReason) ?? 'end_turn' };
		} catch (error) {
			emit({ type: 'error', message: `DSH 请求失败：${errorText(error)}` });
			throw error;
		} finally {
			markStreamingDone();
			currentSessionId = undefined;
			emit({ type: 'busy', busy: false });
			const next = queue.shift();
			if (next) {
				// 出队后立刻接上：busy 从 false→true 只相隔一个同步调用，UI 不会闪烁。
				void runPrompt(next.sessionId, next.blocks, next.userEntry).then(next.resolve, next.reject);
			}
		}
	};

	const startPrompt = (
		sessionId: string,
		blocks: ContentBlock[],
		userEntry: 'auto' | 'none' | string,
	): Promise<PromptOutcome> => {
		if (currentSessionId !== undefined) {
			return new Promise<PromptOutcome>((resolve, reject) => {
				queue.push({ sessionId, blocks, userEntry, resolve, reject });
				log(`[session] 上一个 prompt 仍在进行，排队中（队列长度 ${queue.length}）`);
			});
		}
		return runPrompt(sessionId, blocks, userEntry);
	};

	const failQueued = (reason: Error): void => {
		const pending = queue.splice(0, queue.length);
		for (const item of pending) item.reject(reason);
	};

	return {
		active: () => activeSession,
		busy: () => currentSessionId !== undefined,

		async create(cwd?: string): Promise<ActiveSession> {
			if (closed) throw new Error('会话服务已释放');
			const targetCwd = resolveCwd(cwd);
			await ensureReady();
			const peer = ensurePeer();
			try {
				const result = await peer.request<AcpNewSessionResult>(
					ACP_METHODS.sessionNew,
					{ cwd: targetCwd, mcpServers: [] },
					{ timeoutMs: 60000 },
				);
				const sessionId = asString(result?.sessionId);
				if (!sessionId) throw new Error('session/new 未返回 sessionId');
				knownToolCalls.clear();
				streaming.clear();
				activeSession = { sessionId, cwd: targetCwd, configOptions: normalizeConfigOptions(result?.configOptions) };
				emit({ type: 'session', session: activeSession });
				if (activeSession.configOptions.length > 0) {
					emit({ type: 'configOptions', options: activeSession.configOptions });
					updateCapabilityFlags(activeSession.configOptions);
				}
				return activeSession;
			} catch (error) {
				emit({ type: 'error', message: `新建会话失败：${errorText(error)}` });
				throw error;
			}
		},

		async resume(sessionId: string, cwd?: string): Promise<ActiveSession> {
			if (closed) throw new Error('会话服务已释放');
			const targetCwd = resolveCwd(cwd);
			await ensureReady();
			// 版本过旧时没有 session/resume：退化为“本地继续”，历史从 transcript 读。
			if (!runtime.state().capabilities.sessionResume) {
				log('[session] 运行时未声明 session/resume 能力，退化为本地恢复');
				activeSession = { sessionId, cwd: targetCwd, configOptions: [] };
				knownToolCalls.clear();
				streaming.clear();
				emit({ type: 'session', session: activeSession });
				return activeSession;
			}
			const peer = ensurePeer();
			try {
				const result = await peer.request<AcpResumeSessionResult>(
					ACP_METHODS.sessionResume,
					{ sessionId, cwd: targetCwd, mcpServers: [] },
					{ timeoutMs: 60000 },
				);
				const resumedId = asString(result?.sessionId) ?? sessionId;
				knownToolCalls.clear();
				streaming.clear();
				activeSession = { sessionId: resumedId, cwd: targetCwd, configOptions: normalizeConfigOptions(result?.configOptions) };
				emit({ type: 'session', session: activeSession });
				if (activeSession.configOptions.length > 0) {
					emit({ type: 'configOptions', options: activeSession.configOptions });
					updateCapabilityFlags(activeSession.configOptions);
				}
				return activeSession;
			} catch (error) {
				if (isMethodNotFound(error)) {
					log('[session] session/resume 不受支持，退化为本地恢复');
					activeSession = { sessionId, cwd: targetCwd, configOptions: [] };
					knownToolCalls.clear();
					streaming.clear();
					emit({ type: 'session', session: activeSession });
					return activeSession;
				}
				emit({ type: 'error', message: `恢复会话失败：${errorText(error)}` });
				throw error;
			}
		},

		async list(cwd?: string): Promise<SessionInfo[]> {
			if (closed) return [];
			await ensureReady();
			if (!runtime.state().capabilities.sessionList) {
				log('[session] 运行时未声明 session/list 能力，返回空历史');
				return [];
			}
			const peer = ensurePeer();
			try {
				const result = await peer.request<AcpListSessionsResult>(
					ACP_METHODS.sessionList,
					{ cwd: resolveCwd(cwd) },
					{ timeoutMs: 30000 },
				);
				return normalizeSessions(result?.sessions);
			} catch (error) {
				if (isMethodNotFound(error)) {
					log('[session] session/list 不受支持，返回空历史');
					return [];
				}
				log(`[session] 获取会话历史失败：${errorText(error)}`);
				return [];
			}
		},

		async setConfig(configId: string, value: unknown): Promise<ConfigOption[]> {
			const session = activeSession;
			if (!session) throw new Error('尚无活动会话，无法修改配置');
			await ensureReady();
			const peer = ensurePeer();
			try {
				const result = await peer.request<AcpSetConfigOptionResult>(
					ACP_METHODS.sessionSetConfigOption,
					{ sessionId: session.sessionId, configId, value },
					{ timeoutMs: 30000 },
				);
				const configOptions = normalizeConfigOptions(result?.configOptions);
				if (configOptions.length > 0) {
					session.configOptions = configOptions;
					emit({ type: 'configOptions', options: configOptions });
					updateCapabilityFlags(configOptions);
					return configOptions;
				}
			} catch (error) {
				if (!isMethodNotFound(error)) {
					emit({ type: 'error', message: `修改会话配置失败：${errorText(error)}` });
					throw error;
				}
				log(`[session] session/set_config_option 不受支持，仅本地更新「${configId}」`);
			}
			// 降级：未返回 configOptions 或方法不存在时，本地回写 currentValue 让 UI 不跳回旧值。
			const localOptions = session.configOptions.map((option) =>
				option.id === configId ? { ...option, currentValue: value } : option,
			);
			session.configOptions = localOptions;
			emit({ type: 'configOptions', options: localOptions });
			return localOptions;
		},

		prompt(sessionId: string, blocks: ContentBlock[], options?: PromptDisplayOptions): Promise<PromptOutcome> {
			if (closed) return Promise.reject(new Error('会话服务已释放'));
			const userEntry = options?.userEntry ?? 'auto';
			return startPrompt(sessionId, blocks, userEntry);
		},

		cancel(sessionId?: string): void {
			failQueued(new Error('已取消排队中的请求'));
			const target = sessionId ?? currentSessionId;
			if (!target || currentSessionId !== target) return;
			try {
				const peer = runtime.peer();
				peer.notify(ACP_METHODS.sessionCancel, { sessionId: target });
				log(`[session] 已发送 session/cancel（${target}）`);
			} catch (error) {
				log(`[session] 发送取消失败：${errorText(error)}`);
			}
		},

		async close(): Promise<void> {
			const session = activeSession;
			activeSession = undefined;
			knownToolCalls.clear();
			streaming.clear();
			if (!session) return;
			if (!runtime.state().capabilities.sessionClose) {
				log('[session] 运行时未声明 session/close 能力，仅本地关闭');
				return;
			}
			try {
				const peer = ensurePeer();
				await peer.request(ACP_METHODS.sessionClose, { sessionId: session.sessionId }, { timeoutMs: 15000 });
				log(`[session] 已关闭会话 ${session.sessionId}`);
			} catch (error) {
				if (isMethodNotFound(error)) log('[session] session/close 不受支持，已忽略');
				else log(`[session] 关闭会话失败：${errorText(error)}`);
			}
		},

		async dispose(): Promise<void> {
			closed = true;
			failQueued(new Error('会话服务已释放'));
			if (currentSessionId) {
				try {
					runtime.peer().notify(ACP_METHODS.sessionCancel, { sessionId: currentSessionId });
				} catch {
					/* 运行时可能已停止 */
				}
				// 兜底复位 busy：在飞 prompt 若因连接已断而无法返回，UI 也不会永远卡在“进行中”。
				emit({ type: 'busy', busy: false });
				currentSessionId = undefined;
			}
			disposeSubscriptions();
			boundPeer = undefined;
			activeSession = undefined;
			streaming.clear();
		},
	};
}
