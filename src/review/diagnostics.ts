/**
 * Publish review findings as native VS Code diagnostics.
 *
 * vscode module: pure parsing lives in findings.ts; this file only maps the
 * parsed model onto the `DiagnosticCollection` API (and remembers the latest
 * report for the sidebar).
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { Finding, ReviewReport, Severity } from '../types';

export interface ReviewLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface FindingsDiagnostics {
	/** Owned collection, surfaced for tests/diagnostics commands. */
	readonly collection: vscode.DiagnosticCollection;
	/** Replace all published findings with `findings`; returns the stored report. */
	publish(label: string, findings: readonly Finding[]): Promise<ReviewReport>;
	/** Remove every diagnostic and forget the latest report. */
	clear(): void;
	latest(): ReviewReport | undefined;
	dispose(): void;
}

const DIAGNOSTIC_SOURCE = 'DSH';
const DIAGNOSTIC_CODE = 'review';
/** Fallback clamp when the target document cannot be opened (deleted/binary). */
const FALLBACK_MAX_LINE = 100_000;

function isAbsoluteFilePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

/** Convert a finding path (workspace-relative or absolute) into a file Uri. */
function findingUri(workspaceRoot: string, file: string): vscode.Uri {
	const normalized = file.replace(/\\/g, '/');
	if (isAbsoluteFilePath(normalized)) return vscode.Uri.file(normalized);
	return vscode.Uri.file(path.join(workspaceRoot, normalized));
}

function toDiagnosticSeverity(severity: Severity): vscode.DiagnosticSeverity {
	if (severity === 'error') return vscode.DiagnosticSeverity.Error;
	if (severity === 'info') return vscode.DiagnosticSeverity.Information;
	return vscode.DiagnosticSeverity.Warning;
}

function toDiagnostic(finding: Finding, document: vscode.TextDocument | undefined): vscode.Diagnostic {
	// Clamp again here: the parser may not have had a line-count callback, and
	// documents can change between parsing and publishing.
	const maxLine = document ? Math.max(1, document.lineCount) : FALLBACK_MAX_LINE;
	const startLine = Math.min(Math.max(1, finding.line), maxLine);
	const endLine = Math.min(Math.max(finding.endLine ?? startLine, startLine), maxLine);
	const startIndex = startLine - 1;
	const endIndex = endLine - 1;
	const endCharacter = document ? document.lineAt(endIndex).range.end.character : 0;
	const range = new vscode.Range(startIndex, 0, endIndex, endCharacter);
	const message = finding.detail ? `${finding.title}\n\n${finding.detail}` : finding.title;
	const diagnostic = new vscode.Diagnostic(range, message, toDiagnosticSeverity(finding.severity));
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE;
	return diagnostic;
}

/**
 * @param workspaceRoot Getter (not a snapshot) because the root can change when
 * the user switches workspace folders; findings are resolved lazily.
 */
export function createFindingsDiagnostics(workspaceRoot: () => string, log?: ReviewLog): FindingsDiagnostics {
	const collection = vscode.languages.createDiagnosticCollection('dsh-review');
	let current: ReviewReport | undefined;

	async function publish(label: string, findings: readonly Finding[]): Promise<ReviewReport> {
		const root = workspaceRoot();
		const grouped = new Map<string, { uri: vscode.Uri; findings: Finding[] }>();
		for (const finding of findings) {
			const uri = findingUri(root, finding.file);
			const key = uri.toString();
			const group = grouped.get(key);
			if (group) {
				group.findings.push(finding);
			} else {
				grouped.set(key, { uri, findings: [finding] });
			}
		}

		const entries: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];
		for (const group of grouped.values()) {
			let document: vscode.TextDocument | undefined;
			try {
				document = await vscode.workspace.openTextDocument(group.uri);
			} catch {
				// Deleted or non-text file: VS Code cannot show diagnostics there.
				log?.warn(`无法打开文件以发布诊断：${group.uri.fsPath}`);
				continue;
			}
			entries.push([group.uri, group.findings.map((finding) => toDiagnostic(finding, document))]);
		}

		collection.clear();
		collection.set(entries);
		current = { label, findings: [...findings], at: Date.now() };
		if (findings.length > 0) {
			log?.info(`审查诊断已发布：${findings.length} 条，涉及 ${entries.length} 个文件（${label}）`);
		}
		return current;
	}

	return {
		collection,
		publish,
		clear() {
			collection.clear();
			current = undefined;
		},
		latest() {
			return current;
		},
		dispose() {
			collection.dispose();
		},
	};
}
