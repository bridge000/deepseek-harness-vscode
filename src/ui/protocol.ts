/**
 * Message protocol between the extension host and the sidebar webview.
 * Both sides must only handle the enumerated `type`s; unknown messages are ignored.
 */
import type {
	AutoContextInfo,
	ConfigOption,
	ContextRef,
	Finding,
	PermissionRequest,
	RuntimeState,
	SessionInfo,
	TranscriptEntry,
	UiState,
	UsageInfo,
} from '../types';

export type CommandId =
	| 'reviewFile'
	| 'reviewSelection'
	| 'reviewChanges'
	| 'reviewStaged'
	| 'reviewCommit'
	| 'explainSelection'
	| 'fixFindings'
	| 'showTurnChanges'
	| 'clearFindings'
	| 'newSession'
	| 'history'
	| 'restartRuntime'
	| 'diagnose'
	| 'openSettings';

export type ExtToWeb =
	| { type: 'state'; state: UiState }
	| { type: 'append'; entries: TranscriptEntry[] }
	| { type: 'patch'; id: string; patch: Partial<TranscriptEntry> }
	| { type: 'permission'; request: PermissionRequest }
	| { type: 'findings'; findings: Finding[] }
	| { type: 'error'; message: string }
	| { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
	| { type: 'busy'; busy: boolean }
	| { type: 'usage'; usage: UsageInfo }
	| { type: 'history'; history: SessionInfo[] }
	| { type: 'configOptions'; configOptions: ConfigOption[] }
	| { type: 'contextRefs'; refs: ContextRef[] }
	| { type: 'autoContext'; info: AutoContextInfo }
	| { type: 'runtime'; runtime: RuntimeState }
	| { type: 'focusInput' };

export type WebviewToExt =
	| { type: 'ready' }
	| { type: 'send'; text: string; refs?: ContextRef[] }
	| { type: 'cancel' }
	| { type: 'permissionResponse'; requestId: string; optionId?: string }
	| { type: 'newSession' }
	| { type: 'resumeSession'; sessionId: string }
	| { type: 'setConfig'; configId: string; value: string }
	| { type: 'pickContext' }
	| { type: 'openFile'; path: string; line?: number }
	| { type: 'runCommand'; command: CommandId }
	| { type: 'fixFinding'; finding: Finding }
	| { type: 'clearFindings' }
	| { type: 'restartRuntime' }
	| { type: 'openSettings' }
	| { type: 'copyDiagnostics' }
	| { type: 'setAutoContext'; enabled: boolean };

export function isWebviewToExt(value: unknown): value is WebviewToExt {
	if (typeof value !== 'object' || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === 'ready' ||
		type === 'send' ||
		type === 'cancel' ||
		type === 'permissionResponse' ||
		type === 'newSession' ||
		type === 'resumeSession' ||
		type === 'setConfig' ||
		type === 'pickContext' ||
		type === 'openFile' ||
		type === 'runCommand' ||
		type === 'fixFinding' ||
		type === 'clearFindings' ||
		type === 'restartRuntime' ||
		type === 'openSettings' ||
		type === 'copyDiagnostics' ||
		type === 'setAutoContext'
	);
}

const COMMAND_IDS: readonly CommandId[] = [
	'reviewFile',
	'reviewSelection',
	'reviewChanges',
	'reviewStaged',
	'reviewCommit',
	'explainSelection',
	'fixFindings',
	'showTurnChanges',
	'clearFindings',
	'newSession',
	'history',
	'restartRuntime',
	'diagnose',
	'openSettings',
];

export function isCommandId(value: unknown): value is CommandId {
	return typeof value === 'string' && (COMMAND_IDS as readonly string[]).includes(value);
}
