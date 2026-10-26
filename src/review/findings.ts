/**
 * Parse the agent's findings JSON contract out of its markdown reply.
 *
 * Pure node module (no vscode import) so the strictly synchronous parsing can
 * be unit tested; everything filesystem-ish is injected through
 * `ParseFindingsOptions` instead of importing `fs`.
 */
import path from 'node:path';
import type { Finding, Severity } from '../types';

export interface ParseFindingsOptions {
	/** Absolute workspace root; relative finding paths are resolved against it. */
	workspaceRoot: string;
	/**
	 * Known workspace-relative POSIX paths. Used to resolve a bare basename
	 * (`a.ts`) to its unique workspace path when the agent omits directories.
	 */
	workspaceFiles?: readonly string[];
	/**
	 * 1-based line count of the target document, or `undefined` when unknown.
	 * Kept as a callback so this module stays a pure function (no fs / vscode).
	 * Receives the resolved workspace-relative path (POSIX separators).
	 */
	lineCount?: (file: string) => number | undefined;
	/** Hard cap on returned findings (default 200). */
	maxFindings?: number;
}

export const DEFAULT_MAX_FINDINGS = 200;

/** Maximum detail length; diagnostics stay readable and the webview payload small. */
const MAX_DETAIL_CHARS = 4000;
const MAX_TITLE_CHARS = 200;

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

interface FencedBlock {
	language: string;
	body: string;
}

function collectFencedBlocks(markdown: string): FencedBlock[] {
	const blocks: FencedBlock[] = [];
	FENCE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FENCE_PATTERN.exec(markdown)) !== null) {
		blocks.push({ language: match[1].trim(), body: match[2] });
	}
	return blocks;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** Normalize one parsed JSON payload into a raw findings array, if it is one. */
function findingsArrayOf(payload: unknown): unknown[] | undefined {
	if (Array.isArray(payload)) return payload;
	const record = asRecord(payload);
	if (!record) return undefined;
	return Array.isArray(record.findings) ? record.findings : undefined;
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Locate the last object literal that follows `"findings"` and parse it.
 *
 * This is the fallback used when the reply has no closed ```json fence (the
 * model streamed the block but forgot the closing fence, or wrapped it in
 * prose). A brace scanner that understands strings/escapes is used instead of
 * a greedy regex so `]`/`}` inside detail strings do not cut the payload.
 */
function scanForFindingsObject(markdown: string): unknown {
	const keyPattern = /["']findings["']\s*:/g;
	let last: unknown;
	let match: RegExpExecArray | null;
	while ((match = keyPattern.exec(markdown)) !== null) {
		const keyIndex = match.index;
		const openIndex = markdown.lastIndexOf('{', keyIndex);
		if (openIndex < 0) continue;
		const endIndex = findBalancedObjectEnd(markdown, openIndex);
		if (endIndex < 0) continue;
		const parsed = tryParseJson(markdown.slice(openIndex, endIndex + 1));
		if (findingsArrayOf(parsed)) {
			// Keep scanning: the contract says the *last* valid block wins.
			last = parsed;
		}
	}
	return last;
}

/** Index of the `}` matching the `{` at `start`, respecting JSON strings. */
function findBalancedObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth += 1;
		} else if (char === '}') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Extract the raw findings payload from a markdown reply.
 *
 * Priority: last parseable fenced code block tagged `json` (or untagged) wins;
 * if it does not contain a findings array, fall back to scanning the whole
 * markdown for an object with a `findings` key.
 */
export function extractFindingsPayload(markdown: string): unknown {
	const blocks = collectFencedBlocks(markdown);
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		const language = blocks[i].language.toLowerCase();
		// `jsonc` is tolerated because some models tag it that way.
		if (language && language !== 'json' && language !== 'jsonc') continue;
		const parsed = tryParseJson(blocks[i].body);
		if (parsed === undefined) continue;
		if (findingsArrayOf(parsed)) return parsed;
		// The last fence was JSON but unrelated to findings; the contract lives
		// elsewhere in the reply, so stop here and use the fallback scan.
		break;
	}
	return scanForFindingsObject(markdown);
}

function clampText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return undefined;
}

function toPositiveInt(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const rounded = Math.floor(value);
		return rounded >= 1 ? rounded : undefined;
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 1) return parsed;
	}
	return undefined;
}

/**
 * Normalize the many spellings a model may use for a severity into the three
 * VS Code levels. Chinese words are accepted because prompts are Chinese and
 * models occasionally mirror them.
 */
export function normalizeSeverity(value: unknown): Severity {
	if (typeof value !== 'string') return 'warning';
	const key = value.trim().toLowerCase();
	if (key.includes('error') || key.includes('critical') || key.includes('fatal') || key.includes('high')) return 'error';
	if (key.includes('warn') || key.includes('medium') || key.includes('minor') || key.includes('warning')) return 'warning';
	if (
		key.includes('info') ||
		key.includes('suggestion') ||
		key.includes('note') ||
		key.includes('low') ||
		key.includes('hint')
	) {
		return 'info';
	}
	if (key === '严重' || key === '错误' || key === '致命' || key === '高') return 'error';
	if (key === '警告' || key === '一般' || key === '中' || key === '中等') return 'warning';
	if (key === '提示' || key === '建议' || key === '信息' || key === '低') return 'info';
	return 'warning';
}

function stripLeadingDotSlash(value: string): string {
	let result = value.trim();
	while (result.startsWith('./')) result = result.slice(2);
	return result;
}

function isAbsoluteFilePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function normalizeWorkspaceRoot(root: string): string {
	return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Resolve a raw finding path to a workspace-relative POSIX path (absolute when outside). */
export function resolveFindingPath(rawPath: string, options: ParseFindingsOptions): string {
	const root = normalizeWorkspaceRoot(options.workspaceRoot);
	let candidate = stripLeadingDotSlash(rawPath).replace(/\\/g, '/');

	if (isAbsoluteFilePath(candidate)) {
		// Case-insensitive prefix check: Windows workspace roots commonly differ in case.
		const lowerCandidate = candidate.toLowerCase();
		const lowerRoot = root.toLowerCase();
		if (lowerRoot && lowerCandidate === lowerRoot) return '';
		if (lowerRoot && lowerCandidate.startsWith(`${lowerRoot}/`)) {
			return candidate.slice(root.length + 1);
		}
		return candidate;
	}

	candidate = path.posix.normalize(candidate);
	if (candidate.startsWith('../')) {
		// Do not escape the workspace through `../`; degrade to a basename lookup.
		candidate = path.posix.basename(candidate);
	}
	if (candidate === '.' || candidate === '') return '';

	// Unified diffs show `a/<path>` / `b/<path>`; models sometimes copy that
	// prefix into the findings JSON. Strip it only when the stripped path is a
	// known workspace file, so a real top-level `a/` or `b/` folder still works.
	const diffPrefixed = /^[ab]\/(.+)$/.exec(candidate);
	if (diffPrefixed && options.workspaceFiles && options.workspaceFiles.length > 0) {
		const knownFiles = options.workspaceFiles.map((file) => file.replace(/\\/g, '/'));
		const stripped = diffPrefixed[1];
		if (knownFiles.includes(stripped) && !knownFiles.includes(candidate)) return stripped;
	}

	if (!candidate.includes('/')) {
		// Bare basename: only resolve when it is unique among known workspace files.
		const matches = uniqueBasenameMatches(candidate, options.workspaceFiles);
		if (matches) return matches;
	}
	return candidate;
}

function uniqueBasenameMatches(fileName: string, workspaceFiles: readonly string[] | undefined): string | undefined {
	if (!workspaceFiles || workspaceFiles.length === 0) return undefined;
	const matches: string[] = [];
	for (const file of workspaceFiles) {
		const normalized = file.replace(/\\/g, '/');
		if (path.posix.basename(normalized) === fileName) matches.push(normalized);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

function clampLineToDocument(
	line: number,
	endLine: number | undefined,
	options: ParseFindingsOptions,
	file: string,
): { line: number; endLine: number | undefined } {
	const count = options.lineCount?.(file);
	if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
		return { line, endLine };
	}
	const maxLine = Math.floor(count);
	const clampedLine = Math.min(line, maxLine);
	let clampedEnd = endLine === undefined ? undefined : Math.min(endLine, maxLine);
	if (clampedEnd !== undefined && clampedEnd < clampedLine) clampedEnd = clampedLine;
	return { line: clampedLine, endLine: clampedEnd };
}

function normalizeFinding(entry: unknown, options: ParseFindingsOptions): Finding | undefined {
	const record = asRecord(entry);
	if (!record) return undefined;
	const rawFile = pickString(record, ['file', 'path', 'filePath', 'filename']);
	if (!rawFile) return undefined;
	const file = resolveFindingPath(rawFile, options);
	if (!file) return undefined;

	const rawLine = toPositiveInt(record.line ?? record.startLine ?? record.start);
	const rawEndLine = toPositiveInt(record.endLine ?? record.end ?? record.endLineNumber);
	const clamped = clampLineToDocument(rawLine ?? 1, rawEndLine, options, file);

	const title = pickString(record, ['title', 'message', 'summary', 'issue']);
	const detail = pickString(record, ['detail', 'details', 'description', 'body', 'explanation', 'suggestion']);
	if (!title && !detail) return undefined;

	return {
		file,
		line: clamped.line,
		endLine: clamped.endLine,
		severity: normalizeSeverity(record.severity ?? record.level),
		title: clampText(title ?? '审查发现', MAX_TITLE_CHARS),
		detail: detail === undefined ? undefined : clampText(detail, MAX_DETAIL_CHARS),
	};
}

/**
 * Parse findings from the agent reply.
 *
 * Contract (fixed in prompts.ts): the reply ends with one ```json block
 * `{"findings":[{file,line,endLine,severity,title,detail}]}`; an empty array
 * means "no problems found". Invalid entries are dropped instead of throwing:
 * a malformed reply should degrade to "no findings", not crash the extension.
 */
export function parseFindings(markdown: string, options: ParseFindingsOptions): Finding[] {
	if (typeof markdown !== 'string' || !markdown.trim()) return [];
	const payload = extractFindingsPayload(markdown);
	const rawFindings = findingsArrayOf(payload);
	if (!rawFindings) return [];

	const limit = Math.max(1, Math.floor(options.maxFindings ?? DEFAULT_MAX_FINDINGS));
	const findings: Finding[] = [];
	const seen = new Set<string>();
	for (const raw of rawFindings) {
		const finding = normalizeFinding(raw, options);
		if (!finding) continue;
		// Deduplicate identical entries: the model sometimes repeats a problem.
		const key = `${finding.file}\0${finding.line}\0${finding.endLine ?? ''}\0${finding.title}`;
		if (seen.has(key)) continue;
		seen.add(key);
		findings.push(finding);
		if (findings.length >= limit) break;
	}
	return findings;
}
