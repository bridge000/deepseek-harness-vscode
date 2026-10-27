/**
 * "撤销本轮修改"（undo the latest agent turn）support.
 *
 * The design is deliberately conservative: the whole turn is either reverted
 * as a unit or refused as a unit. Nothing is written before every changed file
 * has been verified, so a user edit made after the turn can never be silently
 * overwritten.
 *
 * Baseline model:
 * - `captureBeginState()` runs before an agent turn. `git stash create` gives
 *   us the pre-turn content of tracked files (as a dangling commit, never a
 *   stash-list entry) and untracked pre-existing files are snapshotted in
 *   memory because git does not know about them.
 * - `recordPostState()` runs right after the turn and records the on-disk
 *   hash/size/existence of every changed file.
 * - `planRevert()` is a pure decision function: it applies the hash guard
 *   (post-turn record vs. freshly read current state) and decides, per path,
 *   whether to restore the begin content or delete a file created by the turn.
 * - `applyRevert()` validates every path first, then writes atomically
 *   (temp file + rename in the same directory) or deletes.
 *
 * This module is vscode-free and takes an injected `GitRunner` so the whole
 * chain can be unit tested without a real repository.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { createGitClient, normalizeRepoPath, type GitRunner } from './git';

/** Baseline snapshots cap: number of pre-existing untracked files. */
export const MAX_UNTRACKED_FILES = 200;
/** Baseline snapshots cap: total bytes of pre-existing untracked files (4MB). */
export const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;
/** A single pre-existing untracked file above this size is skipped, not copied. */
export const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
/** Changed files above this size are never read/restored as text. */
export const MAX_RESTORE_BYTES = 2 * 1024 * 1024;

export interface RevertUntrackedSnapshot {
	content: string;
	sha256: string;
}

/** Everything captured before the turn that revert needs. */
export interface RevertBeginState {
	/** Dangling commit from `git stash create`; empty when the work tree was clean (HEAD is the baseline). */
	stashRevision?: string;
	/** Content of files that already existed as untracked before the turn. */
	untracked: Map<string, RevertUntrackedSnapshot>;
	/** Set when the untracked baseline hit its count/size cap. */
	truncated: boolean;
	/** When set, the baseline is incomplete/untrusted and revert must be refused. */
	reason?: string;
	/** Untracked files skipped while snapshotting (binary / not a regular file / too big). */
	skipped: Array<{ path: string; reason: string }>;
}

/** On-disk state of one repo-relative path at a point in time. */
export interface RevertPostFileState {
	exists: boolean;
	sha256?: string;
	bytes?: number;
	binary?: boolean;
}

/** Where the pre-turn content of one path can be found. */
export interface RevertPreImage {
	/** Whether the path existed in the work tree before the turn. */
	exists: boolean;
	/** Begin snapshot content of a pre-existing untracked file. */
	untrackedContent?: string;
	/** Content from `git show <stashRevision>:<path>` (preferred over HEAD). */
	stashContent?: string;
	/** Content from `git show HEAD:<path>`. */
	headContent?: string;
}

export interface RevertAction {
	path: string;
	kind: 'restore' | 'delete';
	/** Required for `restore`; written back verbatim as UTF-8. */
	content?: string;
}

export interface RevertPlan {
	actions: RevertAction[];
	skipped: Array<{ path: string; reason: string }>;
	/** Set when the whole turn must be refused (actions is then empty). */
	error?: string;
}

export interface RevertPreImageInput {
	/** Repo-relative (POSIX) paths changed by the turn. */
	changed: readonly string[];
	begin: RevertBeginState;
	/** `git status` codes captured at begin() time; decides untracked/deleted-before-turn. */
	beginStatus?: ReadonlyMap<string, { code: string }>;
}

export interface RevertPlanInput {
	/** Repo-relative (POSIX) paths changed by the turn. */
	changed: readonly string[];
	/** Begin-time content sources per changed path; a missing entry is treated as a missing snapshot. */
	preImages: ReadonlyMap<string, RevertPreImage>;
	/** State recorded right after the turn. */
	recorded: ReadonlyMap<string, RevertPostFileState>;
	/** State read right before reverting (hash guard). */
	current: ReadonlyMap<string, RevertPostFileState>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sha256OfBuffer(buffer: Uint8Array): string {
	return createHash('sha256').update(buffer).digest('hex');
}

/** Resolve `repoPath` below `root`, or `undefined` when it would escape the root. */
function resolveInside(root: string, repoPath: string): string | undefined {
	const normalizedRoot = nodePath.resolve(root);
	const absolute = nodePath.resolve(normalizedRoot, repoPath);
	if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + nodePath.sep)) return undefined;
	return absolute;
}

function isTrackedDeletion(code: string | undefined): boolean {
	// Porcelain v1 is `XY path`; a `D` in the work-tree column means the file
	// was already gone before the turn.
	return Boolean(code && code.length >= 2 && code[1] === 'D');
}

/**
 * Snapshot the pre-turn work tree: `git stash create` plus in-memory copies of
 * pre-existing untracked files. Never throws; failures surface as `reason` so
 * the caller can disable revert instead of risking data loss.
 */
export async function captureBeginState(cwd: string, runner?: GitRunner): Promise<RevertBeginState> {
	const state: RevertBeginState = { untracked: new Map(), truncated: false, skipped: [] };
	if (!cwd) {
		state.reason = '未打开工作区，无法记录本轮开始前的状态，撤销不可用。';
		return state;
	}

	const client = createGitClient(runner);
	try {
		const status = await client.statusPorcelain(cwd);
		const stashRevision = await client.stashCreate(cwd);
		if (stashRevision) state.stashRevision = stashRevision;

		const trackedChanges = [...status.values()].filter((entry) => entry.code !== '??');
		if (!stashRevision && trackedChanges.length > 0) {
			// We cannot tell a clean tree from a failed `git stash create` here
			// except through the status map: tracked changes + no snapshot means
			// the baseline is unusable.
			state.reason = '无法记录本轮开始前的 Git 快照（git stash create 失败），本轮无法撤销。';
			return state;
		}

		const untrackedPaths = [...status.entries()]
			.filter(([, entry]) => entry.code === '??')
			.map(([repoPath]) => repoPath)
			.sort();
		if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
			state.truncated = true;
			state.reason = `本轮开始前的未跟踪文件超过 ${MAX_UNTRACKED_FILES} 个，无法完整记录基线，本轮无法撤销。`;
			return state;
		}

		let usedBytes = 0;
		for (const rawPath of untrackedPaths) {
			const repoPath = normalizeRepoPath(rawPath);
			if (!repoPath) continue;
			const absolute = resolveInside(cwd, repoPath);
			if (!absolute) {
				state.skipped.push({ path: repoPath, reason: '路径超出仓库根目录，已跳过快照' });
				continue;
			}

			let stat;
			try {
				stat = await fs.lstat(absolute);
			} catch (error) {
				state.skipped.push({ path: repoPath, reason: `无法读取文件信息：${errorMessage(error)}` });
				continue;
			}
			if (!stat.isFile()) {
				state.skipped.push({ path: repoPath, reason: '不是普通文件，未记录快照' });
				continue;
			}
			if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
				state.skipped.push({ path: repoPath, reason: '文件过大（超过 1MB），未记录快照' });
				continue;
			}
			if (usedBytes + stat.size > MAX_UNTRACKED_TOTAL_BYTES) {
				state.truncated = true;
				state.reason = '本轮开始前的未跟踪文件总量超过 4MB，无法完整记录基线，本轮无法撤销。';
				return state;
			}

			let buffer: Buffer;
			try {
				buffer = await fs.readFile(absolute);
			} catch (error) {
				state.skipped.push({ path: repoPath, reason: `无法读取文件内容：${errorMessage(error)}` });
				continue;
			}
			if (buffer.includes(0)) {
				state.skipped.push({ path: repoPath, reason: '二进制文件，未记录文本快照' });
				continue;
			}
			if (usedBytes + buffer.length > MAX_UNTRACKED_TOTAL_BYTES) {
				state.truncated = true;
				state.reason = '本轮开始前的未跟踪文件总量超过 4MB，无法完整记录基线，本轮无法撤销。';
				return state;
			}

			usedBytes += buffer.length;
			state.untracked.set(repoPath, {
				content: buffer.toString('utf8'),
				sha256: sha256OfBuffer(buffer),
			});
		}
	} catch (error) {
		state.reason = `记录本轮开始前的状态失败：${errorMessage(error)}`;
	}
	return state;
}

/**
 * Read the on-disk state of every changed path (used both right after the turn
 * and right before reverting). Oversized files are recorded without content;
 * files containing NUL bytes are flagged as binary. Never throws.
 */
export async function recordPostState(
	cwd: string,
	repoPaths: readonly string[],
): Promise<Map<string, RevertPostFileState>> {
	const result = new Map<string, RevertPostFileState>();
	for (const rawPath of repoPaths) {
		const repoPath = normalizeRepoPath(rawPath);
		if (!repoPath || result.has(repoPath)) continue;
		const absolute = resolveInside(cwd, repoPath);
		if (!absolute) {
			result.set(repoPath, { exists: false });
			continue;
		}

		let stat;
		try {
			stat = await fs.stat(absolute);
		} catch {
			result.set(repoPath, { exists: false });
			continue;
		}
		if (!stat.isFile()) {
			// Directories/special files cannot be described or restored as text.
			result.set(repoPath, { exists: true, bytes: stat.size, binary: true });
			continue;
		}
		if (stat.size > MAX_RESTORE_BYTES) {
			result.set(repoPath, { exists: true, bytes: stat.size });
			continue;
		}

		let buffer: Buffer;
		try {
			buffer = await fs.readFile(absolute);
		} catch {
			// Keep exists=true with no hash: the hash guard treats it as unverifiable.
			result.set(repoPath, { exists: true, bytes: stat.size });
			continue;
		}
		if (buffer.includes(0)) {
			result.set(repoPath, { exists: true, bytes: buffer.length, binary: true, sha256: sha256OfBuffer(buffer) });
			continue;
		}
		result.set(repoPath, { exists: true, bytes: buffer.length, binary: false, sha256: sha256OfBuffer(buffer) });
	}
	return result;
}

/**
 * Gather the pre-turn content sources for every changed path: untracked files
 * come from the begin snapshot, tracked ones from the stash commit (preferred)
 * or HEAD. Files deleted before the turn are treated as absent.
 */
export async function collectPreImages(
	cwd: string,
	input: RevertPreImageInput,
	runner?: GitRunner,
): Promise<Map<string, RevertPreImage>> {
	const client = createGitClient(runner);
	const result = new Map<string, RevertPreImage>();

	for (const rawPath of input.changed) {
		const repoPath = normalizeRepoPath(rawPath);
		if (!repoPath || result.has(repoPath)) continue;

		const statusEntry = input.beginStatus?.get(repoPath);
		const snapshot = input.begin.untracked.get(repoPath);
		const image: RevertPreImage = { exists: false };

		if (snapshot || statusEntry?.code === '??') {
			// Pre-existing untracked file: only the begin snapshot can restore it.
			image.exists = true;
			if (snapshot) image.untrackedContent = snapshot.content;
			result.set(repoPath, image);
			continue;
		}
		if (isTrackedDeletion(statusEntry?.code)) {
			// The user had already deleted it before the turn; absence is the baseline.
			result.set(repoPath, image);
			continue;
		}

		if (input.begin.stashRevision) {
			const stashContent = await client.showAtRevision(cwd, input.begin.stashRevision, repoPath);
			if (stashContent !== undefined) image.stashContent = stashContent;
		}
		if (image.stashContent === undefined && (await client.headExists(cwd, repoPath))) {
			const headContent = await client.showAtRevision(cwd, 'HEAD', repoPath);
			if (headContent !== undefined) image.headContent = headContent;
		}
		// A path present in the begin status existed before the turn even if we
		// could not read its content (the plan then reports a missing snapshot).
		image.exists = Boolean(statusEntry) || image.stashContent !== undefined || image.headContent !== undefined;
		result.set(repoPath, image);
	}
	return result;
}

function isUnverifiable(state: RevertPostFileState): boolean {
	return state.exists && !state.sha256;
}

/**
 * Pure decision function: no filesystem access, no git. Returns the full set of
 * actions to apply, or `error` when any path cannot be restored safely (the
 * whole turn is then refused, so `actions` stays empty).
 */
export function planRevert(input: RevertPlanInput): RevertPlan {
	const actions: RevertAction[] = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	let refusals = 0;

	const refuse = (path: string, reason: string): void => {
		refusals += 1;
		skipped.push({ path, reason });
	};

	for (const rawPath of input.changed) {
		const repoPath = normalizeRepoPath(rawPath);
		if (!repoPath) continue;

		const recorded = input.recorded.get(repoPath);
		const current = input.current.get(repoPath);
		const pre = input.preImages.get(repoPath);

		if (!recorded) {
			refuse(repoPath, '缺少本轮结束时记录的文件状态，无法校验');
			continue;
		}
		if (!current) {
			refuse(repoPath, '无法读取文件当前状态，无法校验');
			continue;
		}
		if (!pre) {
			refuse(repoPath, '缺少本轮开始前的文件信息，无法判断如何恢复');
			continue;
		}

		if (recorded.binary || current.binary) {
			refuse(repoPath, '二进制或非普通文件，无法安全撤销');
			continue;
		}
		const bytes = Math.max(recorded.bytes ?? 0, current.bytes ?? 0);
		if (bytes > MAX_RESTORE_BYTES) {
			refuse(repoPath, '文件超过 2MB，无法安全撤销');
			continue;
		}

		// Hash guard: any edit/creation/deletion after the turn refuses the whole revert.
		if (recorded.exists !== current.exists) {
			refuse(repoPath, '本轮结束后文件被创建或删除，无法安全撤销');
			continue;
		}
		if (recorded.exists) {
			if (isUnverifiable(recorded) || isUnverifiable(current)) {
				refuse(repoPath, '无法校验文件内容（读取失败），无法安全撤销');
				continue;
			}
			if (recorded.sha256 !== current.sha256) {
				refuse(repoPath, '本轮结束后文件又被修改，无法安全撤销');
				continue;
			}
		}

		if (!pre.exists) {
			if (recorded.exists) {
				// Created by the turn: delete it.
				actions.push({ path: repoPath, kind: 'delete' });
			} else {
				skipped.push({ path: repoPath, reason: '本轮新建后又删除，无需撤销' });
			}
			continue;
		}

		// Existed before the turn: restore it (also covers files deleted by the turn).
		const content = pre.untrackedContent ?? pre.stashContent ?? pre.headContent;
		if (content === undefined) {
			refuse(repoPath, '缺少本轮开始前的文件内容，无法恢复');
			continue;
		}
		if (content.includes('\0')) {
			refuse(repoPath, '本轮开始前的文件是二进制内容，无法安全恢复');
			continue;
		}
		if (Buffer.byteLength(content, 'utf8') > MAX_RESTORE_BYTES) {
			refuse(repoPath, '本轮开始前的文件超过 2MB，无法安全恢复');
			continue;
		}
		actions.push({ path: repoPath, kind: 'restore', content });
	}

	if (refusals > 0) {
		return {
			actions: [],
			skipped,
			error: `检测到 ${refusals} 处无法安全撤销的情况，已整体拒绝本次撤销（未修改任何文件）。`,
		};
	}
	return { actions, skipped };
}

/**
 * Apply a plan: validate every path first (so an invalid plan writes nothing),
 * then restore via a same-directory temp file + rename, or delete. Errors are
 * collected instead of thrown so the caller can report partial state.
 */
export async function applyRevert(
	cwd: string,
	actions: readonly RevertAction[],
): Promise<{ reverted: string[]; errors: string[] }> {
	const errors: string[] = [];
	const reverted: string[] = [];
	const prepared: Array<{ action: RevertAction; absolute: string }> = [];

	for (const action of actions) {
		const repoPath = normalizeRepoPath(action.path);
		const absolute = repoPath ? resolveInside(cwd, repoPath) : undefined;
		if (!absolute) {
			errors.push(`${repoPath || action.path}: 路径超出仓库根目录，已拒绝写入`);
			continue;
		}
		if (action.kind === 'restore' && typeof action.content !== 'string') {
			errors.push(`${repoPath}: 缺少恢复内容`);
			continue;
		}
		prepared.push({ action: { ...action, path: repoPath }, absolute });
	}
	// 先校验后写：整个计划不合法时一个文件也不动，避免半途状态。
	if (errors.length > 0) return { reverted: [], errors };

	for (const [index, item] of prepared.entries()) {
		const { action, absolute } = item;
		try {
			if (action.kind === 'delete') {
				await fs.rm(absolute, { force: true });
				reverted.push(action.path);
				continue;
			}

			const directory = nodePath.dirname(absolute);
			await fs.mkdir(directory, { recursive: true });
			const tempPath = nodePath.join(directory, `.${nodePath.basename(absolute)}.dsh-revert-${process.pid}-${index}.tmp`);
			try {
				await fs.writeFile(tempPath, action.content ?? '', 'utf8');
				await fs.rename(tempPath, absolute);
			} catch (error) {
				try {
					await fs.rm(tempPath, { force: true });
				} catch {
					// Leftover temp file is harmless; the real error is reported below.
				}
				throw error;
			}
			reverted.push(action.path);
		} catch (error) {
			errors.push(`${action.path}: ${errorMessage(error)}`);
		}
	}
	return { reverted, errors };
}
