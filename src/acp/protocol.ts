/**
 * ACP v1 wire vocabulary that this extension relies on.
 *
 * Everything protocol-specific lives here so an upstream ACP change only needs
 * this file (plus its tests) to be touched. The extension intentionally reads a
 * *subset*: unknown methods, notifications and fields are ignored by design.
 */
import type { ConfigOption, ConfigOptionValue } from '../types';

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 envelopes. */
export interface JsonRpcRequestMessage {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
}
export interface JsonRpcNotificationMessage {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}
export interface JsonRpcResponseMessage {
	jsonrpc: '2.0';
	id: number | string | null;
	/** Present on success. */
	result?: unknown;
	/** Present on failure. */
	error?: JsonRpcErrorObject;
}
export type JsonRpcMessage = JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;

/** Standard JSON-RPC error codes used for graceful degradation. */
export const RPC_ERROR = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;

export const ACP_METHODS = {
	initialize: 'initialize',
	authenticate: 'authenticate',
	sessionNew: 'session/new',
	sessionList: 'session/list',
	sessionResume: 'session/resume',
	sessionClose: 'session/close',
	sessionSetConfigOption: 'session/set_config_option',
	sessionPrompt: 'session/prompt',
	sessionCancel: 'session/cancel',
	sessionUpdate: 'session/update',
	sessionRequestPermission: 'session/request_permission',
	cancelRequest: '$/cancel_request',
} as const;

export interface AcpInitializeParams {
	protocolVersion: number;
	clientCapabilities: Record<string, unknown>;
}
export interface AcpInitializeResult {
	protocolVersion: number;
	agentInfo?: { name?: string; version?: string };
	agentCapabilities?: {
		sessionCapabilities?: {
			list?: unknown;
			resume?: unknown;
			close?: unknown;
		};
		promptCapabilities?: { image?: boolean; audio?: boolean };
	};
	authMethods?: unknown[];
}

export interface ContentText {
	type: 'text';
	text: string;
}
export interface ContentResourceLink {
	type: 'resource_link';
	uri: string;
	name: string;
	mimeType?: string;
	description?: string;
}
export interface ContentImage {
	type: 'image';
	/** Base64-encoded image bytes. */
	data: string;
	/** MIME type, e.g. `image/png`. */
	mimeType: string;
	/** Optional source URI for reference/logging. */
	uri?: string;
}
export interface UnknownContentBlock {
	type: string;
	[key: string]: unknown;
}
export type ContentBlock = ContentText | ContentResourceLink | ContentImage | UnknownContentBlock;

export interface AcpNewSessionParams {
	cwd: string;
	mcpServers: unknown[];
	additionalDirectories?: string[];
}
export interface AcpNewSessionResult {
	sessionId: string;
	configOptions?: unknown;
}

export interface AcpResumeSessionParams {
	sessionId: string;
	cwd: string;
	mcpServers?: unknown[];
}
export interface AcpResumeSessionResult {
	sessionId?: string;
	configOptions?: unknown;
}

export interface AcpListSessionsParams {
	cwd?: string;
	cursor?: string;
}
export interface AcpSessionInfo {
	sessionId?: unknown;
	cwd?: unknown;
	title?: unknown;
	updatedAt?: unknown;
}
export interface AcpListSessionsResult {
	sessions?: unknown;
	nextCursor?: unknown;
}

export interface AcpSetConfigOptionParams {
	sessionId: string;
	configId: string;
	value: unknown;
}
export interface AcpSetConfigOptionResult {
	configOptions?: unknown;
}

export interface AcpPromptParams {
	sessionId: string;
	prompt: ContentBlock[];
}
export interface AcpPromptResult {
	stopReason?: string;
}

export interface AcpCancelParams {
	sessionId: string;
}

export interface AcpToolLocation {
	path?: unknown;
	line?: unknown;
}

export interface AcpToolCall {
	toolCallId?: unknown;
	title?: unknown;
	kind?: unknown;
	status?: unknown;
	locations?: unknown;
	rawInput?: unknown;
	content?: unknown;
}

/** ACP `session/update` notification payload (unknown variants tolerated). */
export interface AcpSessionNotification {
	sessionId?: unknown;
	update?: unknown;
}

export interface AcpUpdateAgentMessageChunk {
	sessionUpdate: 'agent_message_chunk';
	content?: unknown;
	messageId?: string | null;
}
export interface AcpUpdateAgentThoughtChunk {
	sessionUpdate: 'agent_thought_chunk';
	content?: unknown;
	messageId?: string | null;
}
export interface AcpUpdateToolCall {
	sessionUpdate: 'tool_call';
	toolCallId?: unknown;
	title?: unknown;
	kind?: unknown;
	status?: unknown;
	locations?: unknown;
	rawInput?: unknown;
}
export interface AcpUpdateToolCallUpdate {
	sessionUpdate: 'tool_call_update';
	toolCallId?: unknown;
	title?: unknown;
	kind?: unknown;
	status?: unknown;
	locations?: unknown;
	content?: unknown;
}
export interface AcpUpdateConfigOption {
	sessionUpdate: 'config_option_update';
	configOptions?: unknown;
}
export interface AcpUpdateUsage {
	sessionUpdate: 'usage_update';
	usage?: unknown;
}
export type AcpKnownUpdate =
	| AcpUpdateAgentMessageChunk
	| AcpUpdateAgentThoughtChunk
	| AcpUpdateToolCall
	| AcpUpdateToolCallUpdate
	| AcpUpdateConfigOption
	| AcpUpdateUsage;

export interface AcpPermissionOption {
	optionId?: unknown;
	name?: unknown;
	kind?: unknown;
}
export interface AcpRequestPermissionParams {
	sessionId?: unknown;
	toolCall?: unknown;
	options?: unknown;
}
export interface AcpRequestPermissionResult {
	outcome?: {
		outcome?: 'selected' | 'cancelled' | string;
		optionId?: string;
	};
}

/** Extract plain text from an ACP content block (or array of blocks). */
export function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((item) => contentToText(item)).join('');
	}
	if (typeof content === 'object' && content !== null) {
		const block = content as { type?: unknown; text?: unknown };
		if (block.type === 'text' && typeof block.text === 'string') return block.text;
	}
	return '';
}

export interface RawConfigOptionValue {
	value?: unknown;
	name?: unknown;
	description?: unknown;
	group?: unknown;
}
export interface RawConfigOption {
	id?: unknown;
	name?: unknown;
	category?: unknown;
	type?: unknown;
	currentValue?: unknown;
	options?: unknown;
}

/**
 * Normalize the ACP `configOptions` payload. ACP groups `model` choices by
 * provider (`options: [{ group, name, options: [...] }]`); some versions may
 * emit a flat list, so both shapes are accepted. Unknown fields are ignored.
 */
export function normalizeConfigOptions(raw: unknown): ConfigOption[] {
	if (!Array.isArray(raw)) return [];
	const result: ConfigOption[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const option = item as RawConfigOption;
		if (typeof option.id !== 'string') continue;
		const values: ConfigOptionValue[] = [];
		const pushValue = (value: RawConfigOptionValue, group?: string, groupName?: string): void => {
			if (typeof value !== 'object' || value === null) return;
			if (typeof value.value !== 'string' || typeof value.name !== 'string') return;
			values.push({
				value: value.value,
				name: value.name,
				description: typeof value.description === 'string' ? value.description : undefined,
				group,
				groupName,
			});
		};
		if (Array.isArray(option.options)) {
			for (const entry of option.options as unknown[]) {
				if (typeof entry !== 'object' || entry === null) continue;
				const group = entry as { group?: unknown; name?: unknown; options?: unknown };
				if (Array.isArray(group.options)) {
					const groupId = typeof group.group === 'string' ? group.group : undefined;
					const groupName = typeof group.name === 'string' ? group.name : groupId;
					for (const value of group.options) pushValue(value as RawConfigOptionValue, groupId, groupName);
				} else {
					pushValue(entry as RawConfigOptionValue);
				}
			}
		}
		result.push({
			id: option.id,
			name: typeof option.name === 'string' ? option.name : option.id,
			category: typeof option.category === 'string' ? option.category : undefined,
			type: typeof option.type === 'string' ? option.type : 'select',
			currentValue: option.currentValue,
			values,
		});
	}
	return result;
}

/** Pick the model / reasoning option ids without hard-coding a single spelling. */
export function findConfigOption(options: readonly ConfigOption[], kind: 'model' | 'reasoning'): ConfigOption | undefined {
	for (const option of options) {
		if (kind === 'model' && (option.category === 'model' || option.id === 'model')) return option;
		if (kind === 'reasoning' && (option.category === 'thought_level' || option.id === 'reasoning_effort')) return option;
	}
	return undefined;
}
