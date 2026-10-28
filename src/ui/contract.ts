/**
 * Contracts between the webview view (owned by the UI module) and the
 * extension controller. Keeping them in one file prevents the UI and the
 * controller from depending on each other's implementations.
 */
import type * as vscode from 'vscode';
import type { ProbeResult } from '../acp/contracts';
import type { ContextRef, Finding, PermissionMode, RuntimeState, SessionInfo, SessionMode, UiState } from '../types';
import type { CommandId, ExtToWeb } from './protocol';

/** Callbacks implemented by the extension controller and consumed by the view. */
export interface ChatController {
	getState(): UiState;
	/** Send one message; `pendingMode` queues/steers it while the agent is busy. */
	send(text: string, refs?: ContextRef[], pendingMode?: 'queue' | 'steer'): Promise<void>;
	/** Promote (`steer`) or drop (`cancel`) one queued interjection. */
	pendingAction(id: string, action: 'steer' | 'cancel'): void;
	cancel(): void;
	newSession(): Promise<void>;
	resumeSession(sessionId: string): Promise<void>;
	refreshHistory(): Promise<SessionInfo[]>;
	pickContext(): Promise<ContextRef[]>;
	setConfig(configId: string, value: string): Promise<void>;
	/** Enable/disable auto context for the following messages. */
	setAutoContext(enabled: boolean): void;
	/** Client-side collaboration mode (agent / plan / goal). */
	setMode(mode: SessionMode): void;
	/** Review the turn's changes automatically after every chat turn. */
	setAutoReview(enabled: boolean): void;
	/** Switch the effective permission preset; the runtime restarts and resumes. */
	setPermissionMode(mode: PermissionMode): Promise<void>;
	/** Persist and apply the sidebar font scale (0.8–1.8). */
	setFontScale(value: number): Promise<void>;
	permissionResponse(requestId: string, optionId?: string): void;
	openFile(path: string, line?: number): void;
	runCommand(command: CommandId): void;
	/** Fix exactly one reviewed finding (from the sidebar list). */
	fixFinding(finding: Finding): Promise<void>;
	clearFindings(): void;
	restartRuntime(): Promise<void>;
	openSettings(): void;
	copyDiagnostics(): Promise<void>;
}

/** Provider created by the UI module, registered by the extension. */
export interface ChatViewProvider extends vscode.WebviewViewProvider {
	readonly viewId: string;
	/** Push a protocol message to the webview (no-op while the view is hidden). */
	post(message: ExtToWeb): void;
	postState(): void;
	postFindings(findings: Finding[]): void;
	reveal(): Promise<void>;
	/** Whether the sidebar is currently visible (drives permission cards vs modal). */
	isVisible(): boolean;
}

export interface ChatViewDeps {
	extensionUri: vscode.Uri;
	controller: ChatController;
	log: (line: string) => void;
	/** Called once when the webview is resolved, so the controller can auto-start. */
	onVisible?: () => void;
}

/** Everything the compatibility diagnose report shows/copies. */
export interface DiagnoseInput {
	extensionVersion: string;
	runtime: RuntimeState;
	probe?: ProbeResult;
	executableCandidates: string[];
	config: {
		executable: string;
		profile: string;
		permissionMode: string;
		autoApprove: string;
		workspaceRoot: string;
	};
	logTail: string[];
	notes: string[];
}
