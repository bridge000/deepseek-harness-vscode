/**
 * Contracts between the webview view (owned by the UI module) and the
 * extension controller. Keeping them in one file prevents the UI and the
 * controller from depending on each other's implementations.
 */
import type * as vscode from 'vscode';
import type { ProbeResult } from '../acp/contracts';
import type { ContextRef, Finding, RuntimeState, SessionInfo, UiState } from '../types';
import type { CommandId, ExtToWeb } from './protocol';

/** Callbacks implemented by the extension controller and consumed by the view. */
export interface ChatController {
	getState(): UiState;
	send(text: string, refs: ContextRef[]): Promise<void>;
	cancel(): void;
	newSession(): Promise<void>;
	resumeSession(sessionId: string): Promise<void>;
	refreshHistory(): Promise<SessionInfo[]>;
	pickContext(): Promise<ContextRef[]>;
	setConfig(configId: string, value: string): Promise<void>;
	permissionResponse(requestId: string, optionId?: string): void;
	openFile(path: string, line?: number): void;
	runCommand(command: CommandId): void;
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
}

export interface ChatViewDeps {
	extensionUri: vscode.Uri;
	controller: ChatController;
	log: (line: string) => void;
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
