/**
 * Pure (vscode-free) construction of the automatic focus context that the
 * extension attaches to chat messages and review prompts.
 *
 * The block embeds the focused file / selection with real 1-based line numbers
 * so the agent can work from the inline content and never has to scan the
 * workspace. It deliberately emits no `resource_link` blocks: the content is
 * already inline, and a link would tempt the agent to read other files.
 *
 * Formatting mirrors review/prompts.ts (`numberLines` / `fitNumberedLines`) but
 * is kept local so this module stays independent of the review subsystem.
 */
import type { ContentBlock } from '../acp/protocol';
import type { AutoContextInfo } from '../types';

/** Lines of surrounding context kept before/after the selected lines. */
export const SELECTION_CONTEXT_LINES = 20;

/**
 * One focused-editor snapshot to embed.
 *
 * For `selection`, `startLine`/`endLine` are the *selected* real document lines
 * while `text` is expected to start `SELECTION_CONTEXT_LINES` lines earlier
 * (clamped to line 1), exactly what `autoContext.ts` collects.
 */
export interface AutoContextInput {
	kind: 'file' | 'selection';
	/** Workspace-relative POSIX path, or the absolute path when outside. */
	path: string;
	/** `file:` URI string; omitted for unsaved (untitled) documents. */
	uri?: string;
	languageId?: string;
	/** Text to embed: the whole file, or the selection plus surrounding lines. */
	text: string;
	/** 1-based real line where the selection starts (selection only). */
	startLine?: number;
	/** 1-based real line where the selection ends, inclusive (selection only). */
	endLine?: number;
	/** Total document lines, for the range description. */
	totalLines: number;
	/** The document has never been saved to disk. */
	untitled?: boolean;
	/** The document lives outside the workspace root. */
	outsideWorkspace?: boolean;
}

export interface AutoContextBuildOptions {
	/** Hard upper bound for the attached text (config `autoContextMaxChars`). */
	maxChars: number;
}

export interface AutoContextBlocks {
	info: AutoContextInfo;
	blocks: ContentBlock[];
}

const FALLBACK_MAX_CHARS = 2000;
/** Room reserved for the `…（已截断…）` marker so the total stays in budget. */
const TRUNCATION_MARKER_RESERVE = 64;
/** Minimum body budget so tiny limits still render something useful. */
const MIN_BODY_BUDGET = 80;
const EMPTY_TEXT_NOTE = '当前文件为空，未附带内容';

function lineNumber(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	const line = Math.floor(value);
	return line < 1 ? 1 : line;
}

/** 1-based line numbers prefixed to every line, as `   1| code`. */
export function numberLines(text: string, startLine = 1): string {
	const lines = text.split(/\r?\n/);
	const first = lineNumber(startLine, 1);
	const width = String(first + Math.max(lines.length, 1) - 1).length;
	return lines.map((line, index) => `${String(first + index).padStart(width, ' ')}| ${line}`).join('\n');
}

/**
 * Fit numbered lines into `budget` characters, cutting at a line boundary and
 * appending a Chinese truncation marker (same style as review/prompts.ts).
 * Numbering uses real line numbers so findings stay correct after truncation.
 */
function fitNumberedLines(text: string, startLine: number, budget: number): { text: string; truncated: boolean } {
	const lines = text.split(/\r?\n/);
	const first = lineNumber(startLine, 1);
	const width = String(first + Math.max(lines.length, 1) - 1).length;
	const output: string[] = [];
	let used = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const entry = `${String(first + index).padStart(width, ' ')}| ${lines[index]}`;
		if (used + entry.length + 1 > budget) break;
		output.push(entry);
		used += entry.length + 1;
	}
	const truncated = output.length < lines.length;
	if (truncated) {
		output.push(`…（已截断：仅显示前 ${output.length} 行，共 ${lines.length} 行）`);
	}
	return { text: output.join('\n'), truncated };
}

function sanitizeLanguage(languageId: string | undefined): string {
	if (!languageId) return '';
	return /^[A-Za-z0-9_+#.-]+$/.test(languageId) ? languageId : '';
}

function selectionRange(input: AutoContextInput): { start: number; end: number } {
	const start = lineNumber(input.startLine, 1);
	const end = Math.max(start, lineNumber(input.endLine, start));
	return { start, end };
}

/** First real document line covered by `text` (selection context included). */
function textStartLine(input: AutoContextInput): number {
	if (input.kind !== 'selection') return 1;
	return Math.max(1, selectionRange(input).start - SELECTION_CONTEXT_LINES);
}

function scopeLines(input: AutoContextInput, startLine: number): string[] {
	const total = Math.max(1, Math.floor(input.totalLines) || 1);
	const lines: string[] = ['## 自动附带的焦点上下文', `- 文件：${input.path}`];
	if (input.languageId) lines.push(`- 语言：${input.languageId}`);
	if (input.kind === 'selection') {
		const { start, end } = selectionRange(input);
		const contextEnd = Math.min(total, end + SELECTION_CONTEXT_LINES);
		lines.push(`- 选中范围：第 ${start}-${end} 行（文件共 ${total} 行）。`);
		lines.push(
			`- 下文是第 ${startLine}-${contextEnd} 行（选中行前后各约 ${SELECTION_CONTEXT_LINES} 行为上下文），每行前缀是真实行号。`,
		);
		lines.push('- 本次只分析选中范围内的代码，上下文仅供理解。');
	} else {
		lines.push(`- 范围：整个文件（共 ${total} 行）。`);
		lines.push('- 每行前缀是该文件的真实行号（从 1 开始）。');
	}
	lines.push('- 内容已内嵌在下方，无需再读取该文件。');
	if (input.untitled) lines.push('- 未保存文件：内容取自编辑器缓冲区，尚未写入磁盘。');
	if (input.outsideWorkspace) lines.push('- 注意：该文件在工作区之外，路径为绝对路径。');
	lines.push('- 本次只分析内嵌内容，不要读取或遍历项目中的其它文件。');
	return lines;
}

function noteFor(input: AutoContextInput, truncated: boolean): string | undefined {
	const notes: string[] = [];
	if (input.untitled) notes.push('未保存文件');
	if (input.outsideWorkspace) notes.push('工作区外');
	if (truncated) notes.push('已截断');
	return notes.length > 0 ? notes.join('；') : undefined;
}

function buildAttachedText(input: AutoContextInput, maxChars: number): { text: string; truncated: boolean } {
	const language = sanitizeLanguage(input.languageId);
	const fenceOpen = `\`\`\`${language}`;
	const fenceClose = '```';
	const startLine = textStartLine(input);
	const header = scopeLines(input, startLine).join('\n');
	// header + 2 newlines + opening fence + newline + body + newline + closing fence
	const overhead = header.length + fenceOpen.length + fenceClose.length + 8;
	const bodyBudget = Math.max(MIN_BODY_BUDGET, maxChars - overhead - TRUNCATION_MARKER_RESERVE);
	const fitted = fitNumberedLines(input.text, startLine, bodyBudget);
	const text = `${header}\n\n${fenceOpen}\n${fitted.text}\n${fenceClose}`;
	return { text, truncated: fitted.truncated };
}

/**
 * Build the auto-context info + a single inline text block for one focused
 * editor snapshot. Returns `kind: 'none'` without blocks when there is nothing
 * meaningful to attach (empty document).
 */
export function buildAutoContextBlocks(input: AutoContextInput, options: AutoContextBuildOptions): AutoContextBlocks {
	if (!input.text.trim()) {
		return { info: { kind: 'none', note: EMPTY_TEXT_NOTE }, blocks: [] };
	}
	const maxChars = Number.isFinite(options.maxChars)
		? Math.max(MIN_BODY_BUDGET, Math.floor(options.maxChars))
		: FALLBACK_MAX_CHARS;
	const { text, truncated } = buildAttachedText(input, maxChars);
	const info: AutoContextInfo = {
		kind: input.kind,
		path: input.path,
		languageId: input.languageId,
		chars: text.length,
	};
	if (input.uri) info.uri = input.uri;
	if (input.kind === 'selection') {
		const { start, end } = selectionRange(input);
		info.startLine = start;
		info.endLine = end;
	}
	const note = noteFor(input, truncated);
	if (note) info.note = note;
	return { info, blocks: [{ type: 'text', text }] };
}
