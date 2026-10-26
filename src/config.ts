import * as vscode from 'vscode';

export type PermissionMode = 'workspace-write' | 'read-only' | 'danger-full-access';
export type AutoApproveMode = 'ask' | 'all';

export interface ExtensionConfig {
	executable: string;
	profile: string;
	permissionMode: PermissionMode;
	autoApprove: AutoApproveMode;
	workspaceRootIndex: number;
	maxReviewChars: number;
	saveTranscriptLimit: number;
	showChangesNotice: boolean;
	checkCompatOnVersionChange: boolean;
	compatAutoRepair: boolean;
	/** Resolved working directory for the ACP process and review paths. */
	workspaceRoot: string;
}

const PERMISSION_MODES: readonly PermissionMode[] = ['workspace-write', 'read-only', 'danger-full-access'];

function clampIndex(value: number, length: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	const index = Math.floor(value);
	return index < length ? index : 0;
}

export function workspaceRootUri(): vscode.Uri | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) return undefined;
	const raw = vscode.workspace.getConfiguration('dshReview').get<number>('workspaceRootIndex', 0);
	return folders[clampIndex(raw, folders.length)].uri;
}

export function readConfig(): ExtensionConfig {
	const config = vscode.workspace.getConfiguration('dshReview');
	const folders = vscode.workspace.workspaceFolders ?? [];
	const root = workspaceRootUri();
	const executable = (config.get<string>('executable', '') ?? '').trim();
	const profile = (config.get<string>('profile', 'acp') ?? '').trim();
	const rawPermission = config.get<string>('permissionMode', 'workspace-write');
	const permissionMode: PermissionMode = (PERMISSION_MODES as readonly string[]).includes(rawPermission)
		? (rawPermission as PermissionMode)
		: 'workspace-write';
	const autoApprove: AutoApproveMode = config.get<string>('autoApprove', 'ask') === 'all' ? 'all' : 'ask';
	const maxReviewChars = Math.max(2000, Math.floor(config.get<number>('maxReviewChars', 60000)));
	const saveTranscriptLimit = Math.max(1, Math.floor(config.get<number>('saveTranscriptLimit', 50)));
	return {
		executable,
		profile,
		permissionMode,
		autoApprove,
		workspaceRootIndex: clampIndex(config.get<number>('workspaceRootIndex', 0), Math.max(folders.length, 1)),
		maxReviewChars,
		saveTranscriptLimit,
		showChangesNotice: config.get<boolean>('showChangesNotice', true),
		checkCompatOnVersionChange: config.get<boolean>('checkCompatOnVersionChange', true),
		compatAutoRepair: config.get<boolean>('compat.autoRepair', true),
		workspaceRoot: root?.fsPath ?? '',
	};
}
