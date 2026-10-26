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
	type PromptSelectionTarget,
} from './prompts';

/** Lines of context kept before/after a selection. */
const SELECTION_CONTEXT_LINES = 20;
/** Refuse to parse findings line counts for huge (likely generated) files. */
const MAX_LINE_COUNT_FILE_BYTES = 2 * 1024 * 1024;

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
			const workspaceRelative = repoPrefix ? (repoFile.startsWith(repoPrefix) ? repoFile.slice(repoPrefix.length) : undefined) : repoFile;
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

	async function pickContextFiles(): Promise<ContextRef[]> {
		const root = rootPath();
		if (!root) {
			warnNoWorkspace();
			return [];
		}
		const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,coverage}/**', 200);
		const items = uris
			.map((uri) => ({
				label: relativePath(root, uri.fsPath),
				description: uri.fsPath,
				uri,
			}))
			.sort((left, right) => left.label.localeCompare(right.label));
		const picked = await vscode.window.showQuickPick(items, {
			canPickMany: true,
			title: '选择要附加到消息的文件',
			placeHolder: '可多选；将以资源链接形式加入下一条消息',
		});
		if (!picked) return [];
		return picked.map((item) => ({ name: item.label, uri: item.uri.toString() }));
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
	};
}
