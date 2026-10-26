/**
 * Shared, vscode-free data model used across the extension, the ACP layer and
 * the webview message protocol.
 */

/** A file/folder reference attached to a chat message. */
export interface ContextRef {
	/** Human readable name shown in the UI, e.g. `src/extension.ts`. */
	name: string;
	/** `file:` URI string understood by ACP `resource_link` blocks. */
	uri: string;
}

export type Severity = 'error' | 'warning' | 'info';

/** One reviewed problem produced by the agent (parsed from its JSON contract). */
export interface Finding {
	file: string;
	/** 1-based start line. */
	line: number;
	/** 1-based end line (inclusive); defaults to `line`. */
	endLine?: number;
	severity: Severity;
	title: string;
	detail?: string;
}

export interface ReviewReport {
	label: string;
	findings: Finding[];
	at: number;
}

export type RuntimePhase = 'stopped' | 'starting' | 'ready' | 'error';

/** ACP surfaces that are actually available on the connected runtime. */
export interface AcpCapabilities {
	sessionList: boolean;
	sessionResume: boolean;
	sessionClose: boolean;
	modelConfig: boolean;
	reasoningConfig: boolean;
	imagePrompts: boolean;
}

export interface RuntimeState {
	phase: RuntimePhase;
	executable?: string;
	profile?: string;
	dshVersion?: string;
	protocolVersion?: number;
	capabilities: AcpCapabilities;
	/** User facing error summary when `phase === 'error'`. */
	error?: string;
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolLocation {
	path: string;
	line?: number;
}

/** One rendered line in the sidebar transcript. */
export type TranscriptEntry =
	| { id: string; kind: 'user'; text: string; refs?: ContextRef[]; at: number }
	| { id: string; kind: 'assistant'; text: string; messageId?: string; at: number; streaming?: boolean }
	| { id: string; kind: 'thought'; text: string; messageId?: string; at: number; streaming?: boolean }
	| {
			id: string;
			kind: 'tool';
			toolCallId: string;
			toolKind?: string;
			title: string;
			status: ToolStatus;
			locations?: ToolLocation[];
			detail?: string;
			at: number;
	  }
	| { id: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; at: number };

/** One selectable value of an ACP session config option. */
export interface ConfigOptionValue {
	value: string;
	name: string;
	description?: string;
	/** Provider group id for the `model` option. */
	group?: string;
	groupName?: string;
}

/** Normalized ACP session config option (model / reasoning_effort / ...). */
export interface ConfigOption {
	id: string;
	name: string;
	category?: string;
	type: string;
	currentValue: unknown;
	values: ConfigOptionValue[];
}

export interface SessionInfo {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
}

export interface ActiveSession {
	sessionId: string;
	cwd: string;
	title?: string;
	configOptions: ConfigOption[];
}

export interface PermissionOptionInfo {
	optionId: string;
	name: string;
	/** ACP option kind, e.g. `allow_once` / `reject_once`. */
	kind: string;
}

export interface PermissionRequest {
	id: string;
	sessionId: string;
	title: string;
	toolKind?: string;
	locations: ToolLocation[];
	/** Command line for bash/pwsh style tools, when available. */
	command?: string;
	options: PermissionOptionInfo[];
}

export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

/** Everything the webview needs to render itself. */
export interface UiState {
	runtime: RuntimeState;
	session?: { sessionId: string; cwd: string; title?: string };
	busy: boolean;
	configOptions: ConfigOption[];
	transcript: TranscriptEntry[];
	findings: Finding[];
	history: SessionInfo[];
	usage?: UsageInfo;
}
