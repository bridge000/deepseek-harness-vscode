/**
 * Contracts for the ACP runtime/session layer. Lead-owned so the extension
 * controller and the runtime implementation can be built independently.
 */
import type {
	ActiveSession,
	ConfigOption,
	PermissionRequest,
	RuntimeState,
	SessionInfo,
	TranscriptEntry,
	UsageInfo,
} from '../types';
import type { ContentBlock } from './protocol';
import type { JsonRpcPeer } from './jsonrpc';

export interface Disposable {
	dispose(): void;
}

export interface RuntimeOptions {
	/** Absolute executable path or wrapper command. */
	executable: string;
	/** ACP-capable profile name. */
	profile: string;
	/** Working directory for the child process (workspace root). */
	cwd: string;
	/** Written to `DSH_PERMISSION_MODE`. */
	permissionMode: 'workspace-write' | 'read-only' | 'danger-full-access';
	log: (line: string) => void;
	onDirtyStdout?: (line: string) => void;
}

/** Probe result cached by the compatibility layer. */
export interface ProbeResult {
	ok: boolean;
	executable: string;
	profile: string;
	dshVersion?: string;
	protocolVersion?: number;
	executableCandidates: string[];
	capabilities: RuntimeState['capabilities'];
	warnings: string[];
	error?: string;
	checkedAt: number;
}

export interface DshRuntime {
	state(): RuntimeState;
	onDidChangeState(listener: (state: RuntimeState) => void): Disposable;
	/** Start (or reuse) the ACP process and finish the ACP handshake. */
	start(): Promise<RuntimeState>;
	restart(): Promise<RuntimeState>;
	stop(): Promise<void>;
	/** Ready peer; throws when the runtime is not ready. */
	peer(): JsonRpcPeer;
	/** Last compatibility probe, if any. */
	probe(): ProbeResult | undefined;
	setProbe(probe: ProbeResult | undefined): void;
}

export interface PromptOutcome {
	stopReason: string;
}

export interface PromptDisplayOptions {
	/** 'auto' = summarize blocks (default); 'none' = no user entry; string = exact bubble text. */
	userEntry?: 'auto' | 'none' | string;
}

export type SessionEvent =
	| { type: 'entry'; entry: TranscriptEntry }
	| { type: 'entryPatch'; id: string; patch: Partial<TranscriptEntry> }
	| { type: 'configOptions'; options: ConfigOption[] }
	| { type: 'usage'; usage: UsageInfo }
	| { type: 'busy'; busy: boolean }
	| { type: 'session'; session: ActiveSession }
	| { type: 'error'; message: string };

export interface SessionServiceOptions {
	/** Current workspace root (used when `cwd` arguments are omitted). */
	cwd: () => string;
	/** Ask the user for a permission decision; resolves to an ACP optionId or undefined (= cancel). */
	pickPermission?: (request: PermissionRequest) => Promise<string | undefined>;
	/** When true every permission request is auto-allowed. */
	autoApprove?: () => boolean;
	log?: (line: string) => void;
	onEvent: (event: SessionEvent) => void;
}

export interface SessionService {
	active(): ActiveSession | undefined;
	busy(): boolean;
	create(cwd?: string): Promise<ActiveSession>;
	resume(sessionId: string, cwd?: string): Promise<ActiveSession>;
	list(cwd?: string): Promise<SessionInfo[]>;
	setConfig(configId: string, value: unknown): Promise<ConfigOption[]>;
	prompt(sessionId: string, blocks: ContentBlock[], options?: PromptDisplayOptions): Promise<PromptOutcome>;
	cancel(sessionId?: string): void;
	close(): Promise<void>;
	dispose(): Promise<void>;
}

/** Local transcript persistence (survives session resume / window reload). */
export interface TranscriptStore {
	load(sessionId: string): TranscriptEntry[];
	save(sessionId: string, entries: readonly TranscriptEntry[]): Promise<void>;
	prune(keep: number): Promise<void>;
}
