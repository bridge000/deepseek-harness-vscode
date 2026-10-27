/**
 * Git helpers for the review pipeline.
 *
 * This module is intentionally vscode-free so it can be unit tested with
 * vitest. Every command goes through `spawn('git', args, { shell: false })`:
 * no shell means paths/commit ids cannot be interpreted by cmd.exe, which
 * matters because some arguments ultimately come from agent output.
 *
 * All failures degrade to empty results (never throw): a missing git binary,
 * a non-repo folder or a timeout must not break the chat flow. Callers show a
 * Chinese hint based on the empty result instead of catching exceptions.
 */
import { spawn } from 'node:child_process';

/** Process level timeout; long enough for big diffs, short enough to stay responsive. */
export const GIT_TIMEOUT_MS = 15_000;

/** Hard cap for captured stdout; anything bigger is truncated by callers anyway. */
const MAX_STDOUT_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

export interface GitRunnerResult {
	/** Exit code; -1 for spawn errors and timeouts. */
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

/**
 * Injection seam for tests: the default runner spawns real git, tests pass a
 * fake runner that returns canned output, so parsing/truncation is tested
 * deterministically and without requiring git on the machine.
 */
export interface GitRunner {
	run(args: readonly string[], cwd: string): Promise<GitRunnerResult>;
}

export interface GitStatusEntry {
	/** Two character porcelain status code, e.g. ` M`, `??`, `R `. */
	code: string;
	/** Original repo-relative path for renames/copies. */
	originalPath?: string;
}

export interface GitDiffResult {
	text: string;
	/** Repo-relative paths parsed from `diff --git` headers. */
	files: string[];
	truncated: boolean;
}

export interface GitLogEntry {
	sha: string;
	subject: string;
}

export interface GitClient {
	isGitRepo(cwd: string): Promise<boolean>;
	/** Repo prefix of `cwd` relative to the repository root, with trailing slash (`''` at the root). */
	repoPrefix(cwd: string): Promise<string>;
	statusPorcelain(cwd: string): Promise<Map<string, GitStatusEntry>>;
	diff(cwd: string, kind: 'working' | 'staged', maxChars: number): Promise<GitDiffResult>;
	showCommit(cwd: string, sha: string, maxChars: number): Promise<GitDiffResult>;
	logOneline(cwd: string, count: number): Promise<GitLogEntry[]>;
	/** Content of `path` at HEAD; `undefined` for new files / not-a-repo. */
	showFileAtHead(cwd: string, path: string): Promise<string | undefined>;
	/**
	 * Revision of a working-tree snapshot created with `git stash create`, or
	 * `undefined` when the working tree is clean or git fails. The returned
	 * object is dangling on purpose: it is never added to the stash list.
	 */
	stashCreate(cwd: string): Promise<string | undefined>;
	/** Content of `path` at `revision` (`HEAD` or a 4-40 char sha); `undefined` when absent. */
	showAtRevision(cwd: string, revision: string, path: string): Promise<string | undefined>;
	/** Whether the HEAD commit contains `path`. */
	headExists(cwd: string, path: string): Promise<boolean>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Real process runner. Uses shell:false; kills the child on timeout. */
function runGitProcess(args: readonly string[], cwd: string, timeoutMs: number): Promise<GitRunnerResult> {
	return new Promise<GitRunnerResult>((resolve) => {
		let child;
		try {
			// shell:false + argument array: the only safe way to pass paths coming
			// from the workspace or from agent output.
			child = spawn('git', [...args], { cwd, shell: false, windowsHide: true });
		} catch (error) {
			resolve({ code: -1, stdout: '', stderr: errorMessage(error) });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};

		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// The process may already be gone; the close event settles the promise.
			}
			finish(-1);
		}, timeoutMs);

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
		});
		child.on('error', (error) => {
			stderr += errorMessage(error);
			finish(-1);
		});
		child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
	});
}

export const defaultGitRunner: GitRunner = {
	run: (args, cwd) => runGitProcess(args, cwd, GIT_TIMEOUT_MS),
};

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 *
 * `-z` is used because it disables path quoting and gives a machine readable
 * separator; renames/copies emit the new path first and the original second.
 * Paths are normalized to POSIX separators so comparisons work on Windows too.
 */
export function parseStatusPorcelain(stdout: string): Map<string, GitStatusEntry> {
	const result = new Map<string, GitStatusEntry>();
	const tokens = stdout.split('\0');
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		// Shortest entry is `XY p` (4 chars): two status chars, a space, a path.
		if (token.length < 4) continue;
		const code = token.slice(0, 2);
		const path = token.slice(3);
		if (!path) continue;
		const entry: GitStatusEntry = { code };
		if (code.includes('R') || code.includes('C')) {
			const original = tokens[i + 1];
			if (original) {
				entry.originalPath = original.replace(/\\/g, '/');
				i += 1;
			}
		}
		result.set(path.replace(/\\/g, '/'), entry);
	}
	return result;
}

/** Parse `git log --pretty=format:%H%x09%s` (also tolerates plain `--oneline`). */
export function parseLogOneline(stdout: string): GitLogEntry[] {
	const entries: GitLogEntry[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const tab = line.indexOf('\t');
		if (tab >= 0) {
			const sha = line.slice(0, tab).trim();
			if (sha) entries.push({ sha, subject: line.slice(tab + 1) });
			continue;
		}
		const match = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(line);
		if (match) entries.push({ sha: match[1], subject: match[2] });
	}
	return entries;
}

function unquoteGitPath(value: string): string {
	return value.replace(/\\(.)/g, '$1').replace(/\\/g, '/');
}

/** Extract the new-file path from one `diff --git a/x b/y` header line. */
function parseDiffHeaderPaths(line: string): string | undefined {
	const match = /^diff --git (.+)$/.exec(line);
	if (!match) return undefined;
	const rest = match[1];
	if (!rest.startsWith('"')) {
		const index = rest.lastIndexOf(' b/');
		if (index < 0) return undefined;
		return rest.slice(index + 3).replace(/\\/g, '/');
	}
	const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
	if (!quoted) return undefined;
	return unquoteGitPath(quoted[2]);
}

/** Repo-relative paths of all files mentioned in a unified diff. */
export function parseDiffFiles(text: string): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith('diff --git ')) continue;
		const file = parseDiffHeaderPaths(line);
		if (!file || seen.has(file)) continue;
		seen.add(file);
		files.push(file);
	}
	return files;
}

/**
 * Truncate git output at the last complete line before `maxChars`. Cutting at
 * a line boundary keeps a unified diff parseable-ish and avoids slicing UTF-16
 * surrogate pairs in filenames.
 */
export function truncateAtLine(text: string, maxChars: number, note?: string): { text: string; truncated: boolean } {
	if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}
	const limit = Math.max(1, Math.floor(maxChars));
	const lineBreak = text.lastIndexOf('\n', limit);
	const head = text.slice(0, lineBreak > 0 ? lineBreak : limit);
	const marker = note ?? `\n…（内容过长已截断：原文共 ${text.length} 字符，仅显示前 ${head.length} 字符）`;
	return { text: head + marker, truncated: true };
}

function toDiffResult(result: GitRunnerResult, maxChars: number): GitDiffResult {
	if (result.code !== 0) return { text: '', files: [], truncated: false };
	const cut = truncateAtLine(result.stdout, maxChars);
	return { text: cut.text, files: parseDiffFiles(cut.text), truncated: cut.truncated };
}

/** Normalize a repo-relative path so `HEAD:<path>` is built consistently on Windows. */
export function normalizeRepoPath(filePath: string): string {
	return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Reject paths that could be read as a git option (`-p`) or escape the
 * repository root. Defence in depth: the shell is already disabled.
 */
function isSafeRepoPath(filePath: string): boolean {
	const normalized = normalizeRepoPath(filePath);
	return (
		Boolean(normalized) &&
		!normalized.startsWith('-') &&
		!normalized.startsWith('/') &&
		!normalized.includes('\0') &&
		!normalized.split('/').includes('..')
	);
}

/** Accept only `HEAD` or a 4-40 char hex object id as a revision. */
function isSafeRevision(revision: string): boolean {
	return /^(HEAD|[0-9a-f]{4,40})$/i.test(revision);
}

/**
 * Create a git client bound to `runner`. Production code uses the default
 * runner; tests inject a fake one so parsing/truncation never needs real git.
 */
export function createGitClient(runner: GitRunner = defaultGitRunner): GitClient {
	const run = async (args: readonly string[], cwd: string): Promise<GitRunnerResult> => {
		try {
			return await runner.run(args, cwd);
		} catch (error) {
			return { code: -1, stdout: '', stderr: errorMessage(error) };
		}
	};

	return {
		async isGitRepo(cwd) {
			if (!cwd) return false;
			const result = await run(['rev-parse', '--is-inside-work-tree'], cwd);
			return result.code === 0 && result.stdout.trim() === 'true';
		},

		async repoPrefix(cwd) {
			const result = await run(['rev-parse', '--show-prefix'], cwd);
			if (result.code !== 0) return '';
			return result.stdout.trim().replace(/\\/g, '/');
		},

		async statusPorcelain(cwd) {
			// `--untracked-files=all` lists new files individually so "本轮改动"
			// can diff them one by one instead of showing a whole directory.
			const result = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
			if (result.code !== 0) return new Map();
			return parseStatusPorcelain(result.stdout);
		},

		async diff(cwd, kind, maxChars) {
			const base = ['--no-color', '--no-ext-diff', '--unified=3'];
			const args = kind === 'staged' ? ['diff', '--cached', ...base] : ['diff', ...base];
			const result = await run(args, cwd);
			return toDiffResult(result, maxChars);
		},

		async showCommit(cwd, sha, maxChars) {
			// Validate before spawning: a value starting with `-` would otherwise be
			// read as a git option (defence in depth, shell is already disabled).
			if (!/^[0-9a-f]{4,40}$/i.test(sha)) return { text: '', files: [], truncated: false };
			const result = await run(['show', '--no-color', '--no-ext-diff', '--format=medium', '-p', sha], cwd);
			return toDiffResult(result, maxChars);
		},

		async logOneline(cwd, count) {
			const limit = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 1), 200) : 20;
			const result = await run(['log', '--no-color', '--pretty=format:%H%x09%s', '-n', String(limit)], cwd);
			if (result.code !== 0) return [];
			return parseLogOneline(result.stdout);
		},

		async showFileAtHead(cwd, filePath) {
			const normalized = normalizeRepoPath(filePath);
			if (!normalized || normalized.startsWith('-') || normalized.startsWith('/') || normalized.includes('\0')) {
				return undefined;
			}
			const result = await run(['show', `HEAD:${normalized}`], cwd);
			return result.code === 0 ? result.stdout : undefined;
		},

		async stashCreate(cwd) {
			if (!cwd) return undefined;
			// `git stash create` prints nothing (exit 0) when the work tree is clean.
			const result = await run(['stash', 'create'], cwd);
			if (result.code !== 0) return undefined;
			const sha = result.stdout.trim();
			return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
		},

		async showAtRevision(cwd, revision, filePath) {
			if (!cwd || !isSafeRevision(revision) || !isSafeRepoPath(filePath)) return undefined;
			const result = await run(['show', `${revision}:${normalizeRepoPath(filePath)}`], cwd);
			return result.code === 0 ? result.stdout : undefined;
		},

		async headExists(cwd, filePath) {
			if (!cwd || !isSafeRepoPath(filePath)) return false;
			const result = await run(['cat-file', '-e', `HEAD:${normalizeRepoPath(filePath)}`], cwd);
			return result.code === 0;
		},
	};
}

const defaultClient = createGitClient();

/**
 * Convenience wrappers over the default (real git) client, used by the
 * extension-side review modules.
 */
export function isGitRepo(cwd: string): Promise<boolean> {
	return defaultClient.isGitRepo(cwd);
}

export function repoPrefix(cwd: string): Promise<string> {
	return defaultClient.repoPrefix(cwd);
}

export function statusPorcelain(cwd: string): Promise<Map<string, GitStatusEntry>> {
	return defaultClient.statusPorcelain(cwd);
}

export function diff(cwd: string, kind: 'working' | 'staged', maxChars: number): Promise<GitDiffResult> {
	return defaultClient.diff(cwd, kind, maxChars);
}

export function showCommit(cwd: string, sha: string, maxChars: number): Promise<GitDiffResult> {
	return defaultClient.showCommit(cwd, sha, maxChars);
}

export function logOneline(cwd: string, count: number): Promise<GitLogEntry[]> {
	return defaultClient.logOneline(cwd, count);
}

export function showFileAtHead(cwd: string, filePath: string): Promise<string | undefined> {
	return defaultClient.showFileAtHead(cwd, filePath);
}

export function stashCreate(cwd: string): Promise<string | undefined> {
	return defaultClient.stashCreate(cwd);
}

export function showAtRevision(cwd: string, revision: string, filePath: string): Promise<string | undefined> {
	return defaultClient.showAtRevision(cwd, revision, filePath);
}

export function headExists(cwd: string, filePath: string): Promise<boolean> {
	return defaultClient.headExists(cwd, filePath);
}
