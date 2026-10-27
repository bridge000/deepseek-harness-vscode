/**
 * Editor lightbulb (Quick Fix) integration for reviewed findings.
 *
 * The matching rules live in `findingMatch.ts` (vscode-free, unit tested); this
 * file only adapts the plain descriptors onto VS Code's CodeAction API and
 * registers the provider. The fix command itself is registered by the
 * extension controller (`extension.ts`), not here.
 */
import * as vscode from 'vscode';
import type { Finding } from '../types';
import { buildQuickFixActions, type QuickFixAction } from './findingMatch';

export interface QuickFixDeps {
	/** Latest reviewed findings (getter: the list is replaced after each review). */
	findings: () => readonly Finding[];
	/** Current workspace root (getter: the folder can change at runtime). */
	workspaceRoot: () => string;
	log: { warn(message: string): void };
}

/** `source` of the diagnostics published by `diagnostics.ts`. */
const DIAGNOSTIC_SOURCE = 'DSH';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 0-based range of the finding inside `document` (same clamp as the diagnostics). */
function findingCodeRange(document: vscode.TextDocument, descriptor: QuickFixAction): vscode.Range {
	const lastLineIndex = Math.max(0, Math.min(descriptor.endLine, document.lineCount) - 1);
	const endCharacter = document.lineAt(lastLineIndex).range.end.character;
	return new vscode.Range(descriptor.startLine - 1, 0, lastLineIndex, endCharacter);
}

/**
 * The published diagnostic this action fixes, when the provider was invoked on
 * it. Attaching it anchors the lightbulb (and the Problems view entry) to the
 * finding's range; `CodeAction` has no range property of its own.
 */
function matchingDiagnostic(
	document: vscode.TextDocument,
	descriptor: QuickFixAction,
	context: vscode.CodeActionContext,
): vscode.Diagnostic | undefined {
	if (!context.diagnostics || context.diagnostics.length === 0) return undefined;
	const expected = findingCodeRange(document, descriptor);
	for (const diagnostic of context.diagnostics) {
		if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
		if (!diagnostic.message.startsWith(descriptor.finding.title)) continue;
		if (!diagnostic.range.intersection(expected)) continue;
		return diagnostic;
	}
	return undefined;
}

function toCodeAction(
	document: vscode.TextDocument,
	descriptor: QuickFixAction,
	context: vscode.CodeActionContext,
): vscode.CodeAction {
	const action = new vscode.CodeAction(descriptor.title, vscode.CodeActionKind.QuickFix);
	action.command = {
		command: descriptor.command.command,
		title: descriptor.command.title,
		arguments: [...descriptor.command.arguments],
	};
	const diagnostic = matchingDiagnostic(document, descriptor, context);
	if (diagnostic) action.diagnostics = [diagnostic];
	return action;
}

/**
 * Register the findings Quick Fix provider for file documents.
 *
 * @param deps Live accessors for findings/workspace root; resolved lazily so a
 * new review or a workspace switch is picked up without re-registering.
 */
export function registerFixCodeActions(deps: QuickFixDeps): vscode.Disposable {
	const provider: vscode.CodeActionProvider = {
		provideCodeActions(document, _range, context): vscode.CodeAction[] {
			try {
				if (document.uri.scheme !== 'file') return [];
				const actions = buildQuickFixActions(
					document.uri.fsPath,
					document.lineCount,
					deps.findings(),
					deps.workspaceRoot(),
				);
				return actions.map((descriptor) => toCodeAction(document, descriptor, context));
			} catch (error) {
				// A malformed finding must never break the editor's lightbulb.
				deps.log.warn(`生成修复快速操作失败：${errorMessage(error)}`);
				return [];
			}
		},
	};
	return vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, provider, {
		providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
	});
}
