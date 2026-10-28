import * as vscode from 'vscode';

import type { PermissionMode } from './types';

export type { PermissionMode } from './types';
export type AutoApproveMode = 'ask' | 'all';
export type AutoContextMode = 'selection-first' | 'file' | 'off';

export interface ExtensionConfig {
	executable: string;
	profile: string;
	permissionMode: PermissionMode;
	autoApprove: AutoApproveMode;
	workspaceRootIndex: number;
	maxReviewChars: number;
	autoContext: AutoContextMode;
	autoContextMaxChars: number;
	preferredModel: string;
	hideLegacyModels: boolean;
	saveTranscriptLimit: number;
	showChangesNotice: boolean;
	checkCompatOnVersionChange: boolean;
	compatAutoRepair: boolean;
	/** Sidebar font scale (0.8–1.8, 1 = follow the VS Code font size). */
	fontScale: number;
	/** Start the DSH runtime in the background as soon as the extension activates. */
	autoStartRuntime: boolean;
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
	const raw = vscode.workspace.getConfiguration('deepseekHarness').get<number>('workspaceRootIndex', 0);
	return folders[clampIndex(raw, folders.length)].uri;
}

export function readConfig(): ExtensionConfig {
	const config = vscode.workspace.getConfiguration('deepseekHarness');
	const folders = vscode.workspace.workspaceFolders ?? [];
	const root = workspaceRootUri();
	const executable = (config.get<string>('executable', '') ?? '').trim();
	const profile = (config.get<string>('profile', 'acp') ?? '').trim();
	const rawPermission = config.get<string>('permissionMode', 'workspace-write');
	const permissionMode: PermissionMode = (PERMISSION_MODES as readonly string[]).includes(rawPermission)
		? (rawPermission as PermissionMode)
		: 'workspace-write';
	const autoApprove: AutoApproveMode = config.get<string>('autoApprove', 'ask') === 'all' ? 'all' : 'ask';
	const rawAutoContext = config.get<string>('autoContext', 'selection-first');
	const autoContext: AutoContextMode =
		rawAutoContext === 'file' || rawAutoContext === 'off' ? rawAutoContext : 'selection-first';
	const autoContextMaxChars = Math.max(2000, Math.floor(config.get<number>('autoContextMaxChars', 40000)));
	const preferredModel = (config.get<string>('preferredModel', '') ?? '').trim();
	const hideLegacyModels = config.get<boolean>('hideLegacyModels', true);
	const maxReviewChars = Math.max(2000, Math.floor(config.get<number>('maxReviewChars', 60000)));
	const saveTranscriptLimit = Math.max(1, Math.floor(config.get<number>('saveTranscriptLimit', 50)));
	const rawFontScale = Number(config.get<number>('fontScale', 1));
	const fontScale = Number.isFinite(rawFontScale) ? Math.min(1.8, Math.max(0.8, rawFontScale)) : 1;
	return {
		executable,
		profile,
		permissionMode,
		autoApprove,
		workspaceRootIndex: clampIndex(config.get<number>('workspaceRootIndex', 0), Math.max(folders.length, 1)),
		maxReviewChars,
		autoContext,
		autoContextMaxChars,
		preferredModel,
		hideLegacyModels,
		saveTranscriptLimit,
		showChangesNotice: config.get<boolean>('showChangesNotice', true),
		checkCompatOnVersionChange: config.get<boolean>('checkCompatOnVersionChange', true),
		compatAutoRepair: config.get<boolean>('compat.autoRepair', true),
		fontScale,
		autoStartRuntime: config.get<boolean>('autoStartRuntime', true) !== false,
		workspaceRoot: root?.fsPath ?? '',
	};
}
