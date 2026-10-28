/**
 * Review service: turns editor/workspace/git state into ACP prompt blocks,
 * parses the agent's findings, publishes diagnostics and exposes "本轮改动".
 *
 * Composition root for the review subsystem. Pure logic lives in prompts.ts /
 * findings.ts / git.ts; this file is the only place that talks to both vscode
 * and the pure modules.
 */
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { workspaceRootUri } from '../config';
import { imageMimeType, isImagePath, refNameFromUri } from '../context/media';
import type { ContextRef, Finding } from '../types';
import { createChangeTracker } from './changes';
import type { DiffKind, ReviewInput, ReviewKind, ReviewService, ReviewServiceDeps } from './contracts';
import { createFindingsDiagnostics } from './diagnostics';
import { DEFAULT_MAX_FINDINGS, parseFindings } from './findings';
import * as git from './git';
import {
	buildExplainPrompt,
	buildReviewPrompt,
	type PromptDiffTarget,
	type PromptFileRef,
	type PromptFileTarget,
	type PromptNewFile,
	type PromptSelectionTarget,
} from './prompts';
import { buildTurnDiffPrompt, partitionTurnPaths, toPathspecs } from './turnDiff';

/** Lines of context kept before/after a selection. */
const SELECTION_CONTEXT_LINES = 20;
/** Refuse to parse findings line counts for huge (likely generated) files. */
const MAX_LINE_COUNT_FILE_BYTES = 2 * 1024 * 1024;
/** New files bigger than this are listed but not embedded in the review prompt. */
const MAX_NEW_FILE_BYTES = 200 * 1024;

/** Extensions that `openTextDocument` may open but that are not reviewable text. */
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif',
	'.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.jar', '.wasm',
	'.exe', '.dll', '.so', '.dylib', '.node', '.class', '.o', '.a',
	'.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.webm',
	'.woff', '.woff2', '.ttf', '.otf', '.eot',
	'.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.pdb',
]);

function rootPath(): string {
	return workspaceRootUri()?.fsPath ?? '';
}

function toPosix(value: string): string {
	return value.replace(/\\/g, '/');
}

function isAbsoluteFilePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

/** Workspace-relative POSIX path for prompts; falls back to the absolute path. */
function relativePath(root: string, filePath: string): string {
	if (!root) return toPosix(filePath);
	const relative = nodePath.relative(root, filePath);
	if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) return toPosix(filePath);
	return toPosix(relative);
}

function absolutePath(root: string, filePath: string): string {
	if (isAbsoluteFilePath(filePath)) return toPosix(filePath);
	return nodePath.join(root, filePath);
}

/**
 * Quick pick entry: a workspace file, or the "pick images from disk" action.
 * NB: `kind` is already taken by VS Code's `QuickPickItemKind` (separators), so
 * the custom discriminator is called `pickKind`.
 */
interface ContextPickItem extends vscode.QuickPickItem {
	pickKind: 'file' | 'disk';
	uri?: vscode.Uri;
}

/**
 * Context ref for a picked URI: supported raster images become `kind: 'image'`
 * refs (the caller embeds them as ACP image content blocks), everything else
 * stays a plain file link.
 */
function imageOrFileRef(root: string, uri: vscode.Uri): ContextRef {
	const mimeType = imageMimeType(uri.fsPath);
	const relative = relativePath(root, uri.fsPath);
	if (!mimeType) return { name: relative, uri: uri.toString() };
	// Images picked from disk may live outside the workspace: use the file name.
	const name = isAbsoluteFilePath(relative) ? refNameFromUri(uri.toString()) : relative;
	return { name, uri: uri.toString(), kind: 'image', mimeType };
}

/**
 * Strip the repo prefix (git reports it with a trailing slash) so a
 * repo-relative path can be joined onto the workspace root. `undefined` when
 * the path lives outside the workspace folder.
 */
function workspaceRelativeFromRepo(repoPrefix: string, repoFile: string): string | undefined {
	const normalized = toPosix(repoFile);
	if (!repoPrefix) return normalized || undefined;
	const prefix = repoPrefix.endsWith('/') ? repoPrefix : `${repoPrefix}/`;
	if (!normalized.startsWith(prefix)) return undefined;
	return normalized.slice(prefix.length) || undefined;
}

/** Count lines the way the editor does (newline count + 1). */
function countTextLines(text: string): number {
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

function samePath(left: string, right: string): boolean {
	return toPosix(left).toLowerCase() === toPosix(right).toLowerCase();
}

function isProbablyBinaryFile(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());
}

/** Count lines without opening the document in the editor. */
function countFileLines(filePath: string): number | undefined {
	try {
		const stat = statSync(filePath);
		if (!stat.isFile() || stat.size > MAX_LINE_COUNT_FILE_BYTES) return undefined;
		const content = readFileSync(filePath, 'utf8');
		let lines = 1;
		for (let index = 0; index < content.length; index += 1) {
			if (content.charCodeAt(index) === 10) lines += 1;
		}
		return lines;
	} catch {
		return undefined;
	}
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
	const diagnostics = createFindingsDiagnostics(rootPath, deps.log);
	const tracker = createChangeTracker({ workspaceRoot: rootPath, storageDir: deps.storageDir, log: deps.log });

	function warnNoWorkspace(): void {
		void vscode.window.showWarningMessage('未打开工作区文件夹，无法执行 DSH 审查。');
	}

	async function openTextDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
		try {
			return await vscode.workspace.openTextDocument(uri);
		} catch (error) {
			deps.log.warn(`打开文件失败：${uri.fsPath}（${String(error)}）`);
			return undefined;
		}
	}

	async function collectFile(uri: vscode.Uri | undefined, kind: ReviewKind): Promise<ReviewInput | undefined> {
		const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!targetUri) {
			void vscode.window.showInformationMessage('请先打开要审查的文件。');
			return undefined;
		}
		if (targetUri.scheme !== 'file') {
			void vscode.window.showWarningMessage('只支持审查工作区中的本地文件。');
			return undefined;
		}
		if (isProbablyBinaryFile(targetUri.fsPath)) {
			void vscode.window.showWarningMessage('该文件不是文本文件，无法审查。');
			return undefined;
		}
		const document = await openTextDocument(targetUri);
		if (!document) {
			void vscode.window.showWarningMessage('无法读取文件内容，已取消审查。');
			return undefined;
		}
		const text = document.getText();
		if (!text.trim()) {
			void vscode.window.showInformationMessage('文件为空，没有可审查的内容。');
			return undefined;
		}
		if (text.includes('\0')) {
			void vscode.window.showWarningMessage('该文件包含二进制内容，无法审查。');
			return undefined;
		}

		const target: PromptFileTarget = {
			kind: 'file',
			path: relativePath(rootPath(), targetUri.fsPath),
			uri: targetUri.toString(),
			languageId: document.languageId,
			text,
			totalLines: document.lineCount,
		};
		const options = { maxChars: deps.maxReviewChars };
		return kind === 'explain' ? buildExplainPrompt(target, options) : buildReviewPrompt(target, options);
	}

	async function collectSelection(kind: ReviewKind): Promise<ReviewInput | undefined> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('请先打开文件并选中要审查的代码。');
			return undefined;
		}
		const document = editor.document;
		if (document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('只支持审查工作区中的本地文件。');
			return undefined;
		}
		const selection = editor.selection;
		if (selection.isEmpty) {
			void vscode.window.showInformationMessage('请先选中要审查的代码。');
			return undefined;
		}

		const firstLine = selection.start.line + 1;
		// A selection ending at column 0 of the next line does not include that line.
		const lastLineIndex =
			selection.end.character === 0 && selection.end.line > selection.start.line
				? selection.end.line - 1
				: selection.end.line;
		const lastLine = lastLineIndex + 1;
		const contextStart = Math.max(1, firstLine - SELECTION_CONTEXT_LINES);
		const contextEnd = Math.min(document.lineCount, lastLine + SELECTION_CONTEXT_LINES);
		const contextEndPosition = document.lineAt(contextEnd - 1).range.end;
		const text = document.getText(
			new vscode.Range(contextStart - 1, 0, contextEnd - 1, contextEndPosition.character),
		);
		if (!text.trim()) {
			void vscode.window.showInformationMessage('选中的代码为空。');
			return undefined;
		}

		const target: PromptSelectionTarget = {
			kind: 'selection',
			path: relativePath(rootPath(), document.uri.fsPath),
			uri: document.uri.toString(),
			languageId: document.languageId,
			text,
			startLine: contextStart,
			selectionStart: firstLine,
			selectionEnd: lastLine,
			totalLines: document.lineCount,
		};
		const options = { maxChars: deps.maxReviewChars };
		return kind === 'explain' ? buildExplainPrompt(target, options) : buildReviewPrompt(target, options);
	}

	async function collectDiff(kind: DiffKind): Promise<ReviewInput | undefined> {
		const root = rootPath();
		if (!root) {
			warnNoWorkspace();
			return undefined;
		}
		if (!(await git.isGitRepo(root))) {
			void vscode.window.showWarningMessage('当前工作区不是 Git 仓库，无法审查改动。');
			return undefined;
		}

		let result: git.GitDiffResult | undefined;
		let sha: string | undefined;
		let subject: string | undefined;
		if (kind === 'commit') {
			const entries = await git.logOneline(root, 20);
			if (entries.length === 0) {
				void vscode.window.showInformationMessage('仓库还没有提交记录，无法审查提交。');
				return undefined;
			}
			const picked = await vscode.window.showQuickPick(
				entries.map((entry) => ({
					label: `${entry.sha.slice(0, 7)} ${entry.subject}`,
					description: entry.sha,
					sha: entry.sha,
					subject: entry.subject,
				})),
				{ title: '选择要审查的提交', placeHolder: '来自 git log --oneline -20' },
			);
			if (!picked) return undefined;
			sha = picked.sha;
			subject = picked.subject;
			result = await git.showCommit(root, sha, deps.maxReviewChars);
		} else {
			result = await git.diff(root, kind, deps.maxReviewChars);
		}

		if (!result.text.trim()) {
			void vscode.window.showInformationMessage(
				kind === 'commit' ? '该提交没有可审查的文本改动。' : '没有检测到可审查的改动。',
			);
			return undefined;
		}

		const repoPrefix = await git.repoPrefix(root);
		const files: PromptFileRef[] = [];
		for (const repoFile of result.files) {
			const workspaceRelative = workspaceRelativeFromRepo(repoPrefix, repoFile);
			if (!workspaceRelative) continue;
			files.push({
				path: workspaceRelative,
				uri: vscode.Uri.file(nodePath.join(root, workspaceRelative)).toString(),
			});
		}

		const target: PromptDiffTarget = {
			kind: 'diff',
			diffKind: kind,
			text: result.text,
			files,
			sha,
			subject,
			truncated: result.truncated,
		};
		return buildReviewPrompt(target, { maxChars: deps.maxReviewChars });
	}

	/**
	 * "Review this turn's changes": the diff is limited to the paths that the
	 * turn touched, and untracked (newly created) files are embedded inline
	 * because `git diff HEAD` never shows them.
	 *
	 * Called automatically after every turn, so it degrades silently: no
	 * workspace / non-git / empty turn all return `undefined` without dialogs.
	 */
	async function collectTurnDiff(paths: readonly string[]): Promise<ReviewInput | undefined> {
		const root = rootPath();
		if (!root) return undefined;
		if (!(await git.isGitRepo(root))) return undefined;

		const repoPrefix = await git.repoPrefix(root);
		const status = await git.statusPorcelain(root);
		const partition = partitionTurnPaths(status, paths, repoPrefix);

		let diffResult: git.GitDiffResult = { text: '', files: [], truncated: false };
		if (partition.tracked.length > 0) {
			const specs = toPathspecs(repoPrefix, partition.tracked);
			diffResult = await git.diffPaths(root, specs, deps.maxReviewChars);
		}

		const files: PromptFileRef[] = [];
		const seenFiles = new Set<string>();
		const addFileRef = (workspaceRelative: string): void => {
			if (!workspaceRelative || seenFiles.has(workspaceRelative)) return;
			seenFiles.add(workspaceRelative);
			files.push({
				path: workspaceRelative,
				uri: vscode.Uri.file(nodePath.join(root, workspaceRelative)).toString(),
			});
		};
		for (const repoFile of diffResult.files) {
			const workspaceRelative = workspaceRelativeFromRepo(repoPrefix, repoFile);
			if (workspaceRelative) addFileRef(workspaceRelative);
		}

		// Embed new file contents, sharing the prompt budget with the diff.
		const newFiles: PromptNewFile[] = [];
		let usedChars = diffResult.text.length;
		let newFilesTruncated = false;
		for (const repoPath of partition.untracked) {
			const workspaceRelative = workspaceRelativeFromRepo(repoPrefix, repoPath);
			if (!workspaceRelative) continue;
			const filePath = nodePath.join(root, workspaceRelative);
			let size = 0;
			try {
				const stat = statSync(filePath);
				if (!stat.isFile()) {
					partition.skipped.push({ path: repoPath, reason: '不是普通文件，未内嵌内容' });
					continue;
				}
				size = stat.size;
			} catch (error) {
				partition.skipped.push({ path: repoPath, reason: `无法读取文件信息：${String(error)}` });
				continue;
			}
			if (size > MAX_NEW_FILE_BYTES) {
				partition.skipped.push({ path: repoPath, reason: '文件过大（超过 200KB），未内嵌内容' });
				continue;
			}
			let text: string;
			try {
				text = readFileSync(filePath, 'utf8');
			} catch (error) {
				partition.skipped.push({ path: repoPath, reason: `无法读取文件内容：${String(error)}` });
				continue;
			}
			if (text.includes('\0')) {
				partition.skipped.push({ path: repoPath, reason: '二进制文件，未内嵌内容' });
				continue;
			}
			if (usedChars + text.length > deps.maxReviewChars) {
				partition.skipped.push({ path: repoPath, reason: '提示词长度已达上限，未内嵌内容' });
				newFilesTruncated = true;
				break;
			}
			usedChars += text.length;
			newFiles.push({ path: workspaceRelative, text, totalLines: countTextLines(text) });
			addFileRef(workspaceRelative);
		}

		for (const item of partition.skipped) {
			deps.log.info(`本轮审查跳过 ${item.path}：${item.reason}`);
		}

		return buildTurnDiffPrompt({
			diffText: diffResult.text,
			files,
			newFiles,
			truncated: diffResult.truncated || newFilesTruncated,
			maxChars: deps.maxReviewChars,
		});
	}

	async function pickContextFiles(): Promise<ContextRef[]> {
		const root = rootPath();
		if (!root) {
			warnNoWorkspace();
			return [];
		}
		const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,coverage}/**', 200);
		const fileItems: ContextPickItem[] = uris
			.map((uri) => {
				const mimeType = imageMimeType(uri.fsPath);
				const description = mimeType
					? `${uri.fsPath} · 图片，将作为图像内容附加`
					: uri.fsPath;
				return {
					label: relativePath(root, uri.fsPath),
					description,
					pickKind: 'file' as const,
					uri,
				};
			})
			.sort((left, right) => left.label.localeCompare(right.label));
		// 置顶项：工作区里找不到的图片（或截图目录）直接从磁盘选。
		const diskItem: ContextPickItem = {
			label: '$(file-media) 从磁盘选择图片…',
			description: 'PNG / JPEG / WebP / GIF',
			pickKind: 'disk',
			alwaysShow: true,
		};
		const picked = await vscode.window.showQuickPick<ContextPickItem>([diskItem, ...fileItems], {
			canPickMany: true,
			title: '选择要附加到消息的文件或图片',
			placeHolder: '可多选；图片会作为图像内容附加，其它以资源链接形式加入下一条消息',
		});
		if (!picked) return [];
		const refs: ContextRef[] = [];
		for (const item of picked) {
			if (item.pickKind === 'disk') {
				const selected = await vscode.window.showOpenDialog({
					canSelectMany: true,
					openLabel: '选择图片',
					filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
				});
				if (!selected) continue;
				for (const uri of selected) {
					if (!isImagePath(uri.fsPath)) {
						deps.log.warn(`跳过非图片文件：${uri.fsPath}`);
						continue;
					}
					refs.push(imageOrFileRef(root, uri));
				}
				continue;
			}
			if (item.uri) refs.push(imageOrFileRef(root, item.uri));
		}
		return refs;
	}

	async function publishFindings(label: string, markdown: string): Promise<Finding[]> {
		const root = rootPath();

		// Workspace file list is only used to resolve bare basenames in findings;
		// keep it best-effort so restricted workspaces still publish diagnostics.
		let workspaceFiles: string[] | undefined;
		if (root) {
			try {
				const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,coverage}/**', 5000);
				workspaceFiles = uris.map((uri) => relativePath(root, uri.fsPath));
			} catch (error) {
				deps.log.warn(`枚举工作区文件失败：${String(error)}`);
			}
		}

		const lineCount = (file: string): number | undefined => {
			if (!root) return undefined;
			const absolute = absolutePath(root, file);
			const openDocument = vscode.workspace.textDocuments.find((document) => samePath(document.uri.fsPath, absolute));
			if (openDocument) return openDocument.lineCount;
			return countFileLines(absolute);
		};

		const findings = parseFindings(markdown, {
			workspaceRoot: root,
			workspaceFiles,
			lineCount,
			maxFindings: DEFAULT_MAX_FINDINGS,
		});
		await diagnostics.publish(label, findings);
		return findings;
	}

	return {
		async isGit() {
			const root = rootPath();
			return root ? git.isGitRepo(root) : false;
		},
		collectFile(uri, kind = 'review') {
			return collectFile(uri, kind);
		},
		collectSelection(kind) {
			return collectSelection(kind);
		},
		collectDiff(kind) {
			return collectDiff(kind);
		},
		collectTurnDiff(paths) {
			return collectTurnDiff(paths);
		},
		pickContextFiles,
		publishFindings,
		clearFindings() {
			diagnostics.clear();
		},
		latest() {
			return diagnostics.latest();
		},
		beginChanges() {
			return tracker.begin();
		},
		endChanges() {
			return tracker.end();
		},
		showChanges(files) {
			return tracker.show(files);
		},
		canRevert() {
			return tracker.canRevert();
		},
		revertLastTurn() {
			return tracker.revertLastTurn();
		},
	};
}
