/**
 * Focused-editor collector for the automatic context.
 *
 * Only `vscode.window.activeTextEditor` is inspected: the user may have many
 * editors open, but the agent must receive exactly the file (or selection) the
 * user is looking at. All pure formatting lives in `autoContextBuild.ts` so it
 * can be unit tested without vscode.
 */
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { ContentBlock } from '../acp/protocol';
import type { AutoContextMode } from '../config';
import type { AutoContextInfo } from '../types';
import { buildAutoContextBlocks, SELECTION_CONTEXT_LINES } from './autoContextBuild';

export interface AutoContextLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface AutoContextCollectorOptions {
	mode: AutoContextMode;
	/** Config `deepseekHarness.autoContextMaxChars` (hard upper bound). */
	maxChars: number;
	/** Workspace root used to make paths relative; '' when no folder is open. */
	workspaceRoot: string;
	log: AutoContextLog;
}

export interface AutoContextCollection {
	info: AutoContextInfo;
	blocks: ContentBlock[];
}

export interface AutoContextCollector {
	/** Snapshot the focused editor; never throws, returns `kind: 'none'` instead. */
	collect(): AutoContextCollection;
}

function none(): AutoContextCollection {
	return { info: { kind: 'none' }, blocks: [] };
}

function toPosix(value: string): string {
	return value.replace(/\\/g, '/');
}

/** Workspace-relative POSIX path; absolute POSIX path when outside the root. */
function relativePath(workspaceRoot: string, filePath: string): { path: string; outsideWorkspace: boolean } {
	if (!workspaceRoot) return { path: toPosix(filePath), outsideWorkspace: true };
	const relative = nodePath.relative(workspaceRoot, filePath);
	if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
		return { path: toPosix(filePath), outsideWorkspace: true };
	}
	return { path: toPosix(relative), outsideWorkspace: false };
}

function describePath(
	document: vscode.TextDocument,
	workspaceRoot: string,
): { path: string; outsideWorkspace: boolean } {
	if (document.isUntitled) return { path: toPosix(document.fileName), outsideWorkspace: false };
	return relativePath(workspaceRoot, document.uri.fsPath);
}

function displayPath(document: vscode.TextDocument): string {
	return document.uri.fsPath || document.fileName;
}

/** Real 1-based line range covered by the selection. */
function selectionLines(selection: vscode.Selection): { start: number; end: number } {
	const start = selection.start.line + 1;
	// A selection ending at column 0 of the next line does not include that line.
	const lastLineIndex =
		selection.end.character === 0 && selection.end.line > selection.start.line
			? selection.end.line - 1
			: selection.end.line;
	return { start, end: lastLineIndex + 1 };
}

/** Selection + `SELECTION_CONTEXT_LINES` of context before/after, real line numbers. */
function collectSelection(
	document: vscode.TextDocument,
	selection: vscode.Selection,
): { text: string; startLine: number; endLine: number } | undefined {
	const { start, end } = selectionLines(selection);
	const contextStart = Math.max(1, start - SELECTION_CONTEXT_LINES);
	const contextEnd = Math.min(document.lineCount, end + SELECTION_CONTEXT_LINES);
	if (contextEnd < contextStart) return undefined;
	const endPosition = document.lineAt(contextEnd - 1).range.end;
	const text = document.getText(new vscode.Range(contextStart - 1, 0, endPosition.line, endPosition.character));
	if (!text.trim()) return undefined;
	return { text, startLine: start, endLine: end };
}

/** Collect the focused editor into a `{ info, blocks }` snapshot. */
export function createAutoContextCollector(options: AutoContextCollectorOptions): AutoContextCollector {
	function buildFromDocument(document: vscode.TextDocument): AutoContextCollection {
		const text = document.getText();
		if (text.includes('\0')) {
			options.log.warn(`自动上下文：跳过二进制文件 ${displayPath(document)}。`);
			return none();
		}
		const { path, outsideWorkspace } = describePath(document, options.workspaceRoot);
		return buildAutoContextBlocks(
			{
				kind: 'file',
				path,
				uri: document.isUntitled ? undefined : document.uri.toString(),
				languageId: document.languageId,
				text,
				totalLines: document.lineCount,
				untitled: document.isUntitled,
				outsideWorkspace,
			},
			{ maxChars: options.maxChars },
		);
	}

	function collect(): AutoContextCollection {
		if (options.mode === 'off') return none();
		const editor = vscode.window.activeTextEditor;
		if (!editor) return none();
		const document = editor.document;
		if (document.uri.scheme !== 'file' && !document.isUntitled) return none();
		try {
			if (options.mode === 'selection-first' && !editor.selection.isEmpty) {
				const context = collectSelection(document, editor.selection);
				if (context) {
					const { path, outsideWorkspace } = describePath(document, options.workspaceRoot);
					return buildAutoContextBlocks(
						{
							kind: 'selection',
							path,
							uri: document.isUntitled ? undefined : document.uri.toString(),
							languageId: document.languageId,
							text: context.text,
							startLine: context.startLine,
							endLine: context.endLine,
							totalLines: document.lineCount,
							untitled: document.isUntitled,
							outsideWorkspace,
						},
						{ maxChars: options.maxChars },
					);
				}
			}
			return buildFromDocument(document);
		} catch (error) {
			options.log.warn(`自动上下文：读取焦点编辑器失败（${String(error)}）。`);
			return none();
		}
	}

	return { collect };
}
