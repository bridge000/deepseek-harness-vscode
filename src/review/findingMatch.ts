/**
 * Pure matching helpers between reviewed findings and the file currently open
 * in the editor, plus the vscode-free description of Quick Fix actions.
 *
 * Kept free of any `vscode` import so the matching rules can be unit tested;
 * `quickFix.ts` only maps these plain objects onto `CodeAction` instances.
 */
import path from 'node:path';
import type { Finding } from '../types';

/** Command registered by the extension that fixes exactly one finding. */
export const FIX_FINDING_COMMAND = 'deepseekHarness.fixFinding';

/** Prefix of the CodeAction title (user visible, Chinese). */
export const QUICK_FIX_TITLE_PREFIX = '用 DeepSeek Harness 修复：';

/** One finding mapped to an editor range plus the command that fixes it. */
export interface QuickFixAction {
	title: string;
	/** 1-based inclusive start line, already clamped to the document. */
	startLine: number;
	/** 1-based inclusive end line, already clamped to the document. */
	endLine: number;
	/** The original finding, handed to the command as its only argument. */
	finding: Finding;
	/** Plain command descriptor; `quickFix.ts` copies it onto `CodeAction.command`. */
	command: {
		command: typeof FIX_FINDING_COMMAND;
		title: string;
		arguments: [Finding];
	};
}

/** Editor line range for one finding (1-based, inclusive). */
export interface FindingRange {
	startLine: number;
	endLine: number;
}

const WINDOWS = process.platform === 'win32';

/** Windows paths are case-insensitive; POSIX paths are not. */
function isAbsoluteFindingPath(value: string): boolean {
	return /^[A-Za-z]:\//.test(value) || value.startsWith('/');
}

/** Normalize a finding/document path to a POSIX absolute or workspace-relative path. */
export function normalizeFindingPath(input: string): string {
	if (typeof input !== 'string') return '';
	let value = input.trim().replace(/\\/g, '/');
	if (!value) return '';
	// Preserve a leading `//` (UNC) while folding every other separator run.
	const unc = value.startsWith('//');
	value = value.replace(/\/+/g, '/');
	if (unc) value = `/${value}`;
	value = path.posix.normalize(value);
	if (unc && !value.startsWith('//')) value = `/${value}`;
	// `path.posix.normalize` keeps a trailing separator; a finding points at a file
	// (drive roots such as `C:/` must keep theirs).
	if (value.length > 1 && value.endsWith('/') && !/^[A-Za-z]:\/$/.test(value)) value = value.slice(0, -1);
	if (value === '.') return '';
	return value;
}

function normalizeWorkspaceRoot(root: string): string {
	return normalizeFindingPath(root);
}

function samePath(left: string, right: string): boolean {
	return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Whether `candidate` lives inside `root` (or is the root itself). */
function isWithinRoot(root: string, candidate: string): boolean {
	if (!root) return false;
	if (root === '/') return candidate.startsWith('/');
	if (samePath(root, candidate)) return true;
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return WINDOWS ? candidate.toLowerCase().startsWith(prefix.toLowerCase()) : candidate.startsWith(prefix);
}

/** Resolve a finding path to an absolute POSIX path, or `undefined` when unusable. */
function resolveFindingPath(root: string, file: string): string | undefined {
	const normalized = normalizeFindingPath(file);
	if (!normalized) return undefined;
	if (isAbsoluteFindingPath(normalized)) return normalized;
	// Relative paths are resolved against the workspace root; `../` escapes are
	// rejected instead of silently matching some file outside the workspace.
	if (!root) return undefined;
	const joined = path.posix.normalize(`${root}/${normalized}`);
	if (!isWithinRoot(root, joined)) return undefined;
	return joined;
}

/** Resolve the edited document path the same way findings are resolved. */
function resolveTargetPath(root: string, filePath: string): string | undefined {
	return resolveFindingPath(root, filePath);
}

/** Identity of a finding used to drop duplicates from the action list. */
function findingKey(finding: Finding): string {
	return `${finding.line}\0${finding.endLine ?? ''}\0${finding.severity}\0${finding.title}`;
}

/**
 * Findings that belong to `filePath`.
 *
 * Relative finding paths are resolved against `workspaceRoot`; absolute ones are
 * compared directly. Windows comparisons are case-insensitive, POSIX ones are
 * not. Findings escaping the workspace root never match, and duplicate entries
 * are collapsed so the lightbulb does not show the same fix twice.
 */
export function findingsForFile(
	findings: readonly Finding[],
	workspaceRoot: string,
	filePath: string,
): Finding[] {
	const root = normalizeWorkspaceRoot(workspaceRoot);
	const target = resolveTargetPath(root, filePath);
	if (!target) return [];

	const seen = new Set<string>();
	const matched: Finding[] = [];
	for (const finding of findings) {
		const resolved = resolveFindingPath(root, finding.file);
		if (!resolved || !samePath(resolved, target)) continue;
		const key = findingKey(finding);
		if (seen.has(key)) continue;
		seen.add(key);
		matched.push(finding);
	}
	return matched;
}

function toLine(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 1 ? floored : fallback;
}

/**
 * Clamp a finding's line range to the document (1-based, inclusive).
 *
 * The parser optimistically accepts arbitrary line numbers (the target document
 * may not have been readable yet), so CodeAction construction re-clamps here.
 */
export function findingRange(finding: Pick<Finding, 'line' | 'endLine'>, lineCount: number): FindingRange {
	const maxLine = Math.max(1, typeof lineCount === 'number' && Number.isFinite(lineCount) ? Math.floor(lineCount) : 1);
	const startLine = Math.min(toLine(finding.line, 1), maxLine);
	const requestedEnd = finding.endLine === undefined ? startLine : toLine(finding.endLine, startLine);
	const endLine = Math.min(Math.max(requestedEnd, startLine), maxLine);
	return { startLine, endLine };
}

/**
 * Map the findings of one document to plain Quick Fix descriptors.
 *
 * vscode-free on purpose: `quickFix.ts` wraps the result into `CodeAction`s and
 * tests can validate titles, ranges and command arguments without the extension
 * host. Order follows the findings list (i.e. severity order from the review).
 */
export function buildQuickFixActions(
	docPath: string,
	lineCount: number,
	findings: readonly Finding[],
	workspaceRoot: string,
): QuickFixAction[] {
	const matched = findingsForFile(findings, workspaceRoot, docPath);
	const actions: QuickFixAction[] = [];
	for (const finding of matched) {
		const { startLine, endLine } = findingRange(finding, lineCount);
		const title = `${QUICK_FIX_TITLE_PREFIX}${finding.title}`;
		actions.push({
			title,
			startLine,
			endLine,
			finding,
			command: { command: FIX_FINDING_COMMAND, title, arguments: [finding] },
		});
	}
	return actions;
}
