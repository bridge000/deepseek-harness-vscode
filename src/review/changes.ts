/**
 * "本轮改动" support: snapshot git status before an agent turn, then offer a
 * native diff (HEAD ↔ working tree) for the files it touched.
 *
 * vscode module: git access is delegated to git.ts, this file only handles the
 * baseline bookkeeping, QuickPick and `vscode.diff`.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import * as git from './git';
import type { RevertResult } from './contracts';
import type { ReviewLog } from './diagnostics';
import {
	applyRevert,
	captureBeginState,
	collectPreImages,
	planRevert,
	recordPostState,
	type RevertBeginState,
	type RevertPostFileState,
} from './revert';

export interface ChangeTrackerOptions {
	/** Getter, so a workspace folder switch is picked up on the next turn. */
	workspaceRoot: () => string;
	/** Directory for the temporary "HEAD" side of native diffs. */
	storageDir: string;
	log: ReviewLog;
}

export interface ChangeTracker {
	/** Record the current `git status` as the baseline for this turn. */
	begin(): Promise<void>;
	/** Repo-relative paths created/modified/deleted since `begin()`. */
	end(): Promise<string[]>;
	/** QuickPick over `files`, then open a native `vscode.diff` for the selection. */
	show(files: readonly string[]): Promise<void>;
	/** Whether the latest turn can be reverted (git repo + complete baseline + post-turn state). */
	canRevert(): boolean;
	/** Revert the latest turn as a unit; clears the baseline on success. */
	revertLastTurn(): Promise<RevertResult>;
}

interface BaselineEntry {
	code: string;
	/** Original path when the entry was already a rename/copy before the turn. */
	originalPath?: string;
	/** Used to detect further edits to files that were already dirty before the turn. */
	mtimeMs: number;
	size: number;
}

/** Text diffs above this size are noisy and slow; skip with a hint instead. */
const MAX_DIFF_FILE_CHARS = 2 * 1024 * 1024;

interface StatInfo {
	mtimeMs: number;
	size: number;
}

async function statSafe(filePath: string): Promise<StatInfo | undefined> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
	} catch {
		return undefined;
	}
}

/** Strip the repo prefix so repo-relative paths can be joined onto the workspace root. */
function toWorkspaceRelative(repoPath: string, repoPrefix: string): string | undefined {
	if (!repoPrefix) return repoPath;
	if (!repoPath.startsWith(repoPrefix)) return undefined;
	return repoPath.slice(repoPrefix.length);
}

function workspaceFilePath(workspaceRoot: string, repoPath: string, repoPrefix: string): string | undefined {
	const relative = toWorkspaceRelative(repoPath, repoPrefix);
	if (!relative) return undefined;
	const absolute = nodePath.join(workspaceRoot, relative);
	// Defence in depth: never open a path that escaped the workspace.
	const normalizedRoot = nodePath.resolve(workspaceRoot);
	const normalizedFile = nodePath.resolve(absolute);
	if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(normalizedRoot + nodePath.sep)) return undefined;
	return absolute;
}

function tempFileName(repoPath: string): string {
	// Stable, collision-free temp name that keeps the extension for highlighting.
	const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 10);
	const safe = repoPath.replace(/[\\/:*?"<>|\s]+/g, '_');
	return `${hash}-${safe}`;
}

/**
 * Repository root derived from the workspace root and `git rev-parse
 * --show-prefix` (the prefix is the workspace root relative to the repo root).
 * `git status` paths are repo-relative, so revert has to touch files from there.
 */
function repoRootPath(workspaceRoot: string, repoPrefix: string): string {
	if (!repoPrefix) return workspaceRoot;
	const depth = repoPrefix.split('/').filter(Boolean).length;
	return nodePath.resolve(workspaceRoot, ...Array.from({ length: depth }, () => '..'));
}

export function createChangeTracker(options: ChangeTrackerOptions): ChangeTracker {
	let baseline: Map<string, BaselineEntry> | undefined;
	/** Pre-turn snapshot used by revert (stash revision + untracked file contents). */
	let beginState: RevertBeginState | undefined;
	/** Per-file on-disk state recorded right after the turn. */
	let postState: Map<string, RevertPostFileState> | undefined;
	/** Workspace root the baseline was captured in, so a folder switch cannot mix snapshots. */
	let baselineRoot: string | undefined;

	function resetRevertState(): void {
		beginState = undefined;
		postState = undefined;
		baselineRoot = undefined;
	}

	async function captureBaseline(workspaceRoot: string, repoPrefix: string): Promise<Map<string, BaselineEntry>> {
		const status = await git.statusPorcelain(workspaceRoot);
		const snapshot = new Map<string, BaselineEntry>();
		for (const [repoPath, entry] of status) {
			const absolute = workspaceFilePath(workspaceRoot, repoPath, repoPrefix);
			const stat = absolute ? await statSafe(absolute) : undefined;
			snapshot.set(repoPath, {
				code: entry.code,
				originalPath: entry.originalPath,
				mtimeMs: stat?.mtimeMs ?? 0,
				size: stat?.size ?? -1,
			});
		}
		return snapshot;
	}

	async function revealDiff(workspaceRoot: string, repoPath: string, repoPrefix: string): Promise<void> {
		const workspaceRelative = toWorkspaceRelative(repoPath, repoPrefix);
		if (workspaceRelative === undefined) {
			void vscode.window.showWarningMessage('该文件位于工作区之外，暂不支持对比。');
			return;
		}

		const headContent = (await git.showFileAtHead(workspaceRoot, repoPath)) ?? '';
		if (headContent.length > MAX_DIFF_FILE_CHARS) {
			void vscode.window.showWarningMessage('文件过大，跳过「本轮改动」的文本对比。');
			return;
		}
		if (headContent.includes('\0')) {
			void vscode.window.showWarningMessage('二进制文件无法以文本方式对比。');
			return;
		}

		const workspaceFile = workspaceFilePath(workspaceRoot, repoPath, repoPrefix);
		const existsOnDisk = workspaceFile ? (await statSafe(workspaceFile)) !== undefined : false;
		const tempDir = nodePath.join(options.storageDir, 'turn-diff');
		const leftPath = nodePath.join(tempDir, tempFileName(repoPath));
		const rightPath = existsOnDisk && workspaceFile ? workspaceFile : nodePath.join(tempDir, 'empty.txt');

		try {
			await fs.mkdir(tempDir, { recursive: true });
			await fs.writeFile(leftPath, headContent, 'utf8');
			if (!(existsOnDisk && workspaceFile)) await fs.writeFile(rightPath, '', 'utf8');
		} catch (error) {
			options.log.error(`写入「本轮改动」临时文件失败：${String(error)}`);
			void vscode.window.showErrorMessage('无法打开 diff：写入临时文件失败。');
			return;
		}

		const side = existsOnDisk ? 'HEAD ↔ 工作区' : 'HEAD ↔ 已删除';
		const title = `本轮改动：${workspaceRelative}（${side}）`;
		try {
			await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(leftPath), vscode.Uri.file(rightPath), title, {
				preview: true,
			});
		} catch (error) {
			options.log.error(`打开 diff 失败：${String(error)}`);
			void vscode.window.showErrorMessage('打开 diff 失败，请查看输出面板。');
		}
	}

	return {
		async begin() {
			const workspaceRoot = options.workspaceRoot();
			baseline = undefined;
			resetRevertState();
			if (!workspaceRoot) return;
			if (!(await git.isGitRepo(workspaceRoot))) {
				options.log.info('工作区不是 Git 仓库，跳过「本轮改动」基线。');
				return;
			}
			try {
				const repoPrefix = await git.repoPrefix(workspaceRoot);
				baseline = await captureBaseline(workspaceRoot, repoPrefix);
				baselineRoot = workspaceRoot;
				beginState = await captureBeginState(repoRootPath(workspaceRoot, repoPrefix));
				if (beginState.reason) {
					options.log.warn(`本轮改动基线不完整，撤销不可用：${beginState.reason}`);
				} else {
					options.log.info(`已记录本轮改动基线：${baseline.size} 个待提交文件。`);
				}
			} catch (error) {
				options.log.warn(`记录本轮改动基线失败：${String(error)}`);
			}
		},

		async end() {
			const workspaceRoot = options.workspaceRoot();
			if (!workspaceRoot || !baseline) return [];
			if (baselineRoot !== workspaceRoot) {
				options.log.warn('工作区已切换，忽略上一轮改动基线。');
				resetRevertState();
				baseline = undefined;
				return [];
			}
			const previous = baseline;
			try {
				const repoPrefix = await git.repoPrefix(workspaceRoot);
				const status = await git.statusPorcelain(workspaceRoot);
				const changed: string[] = [];
				const extra: string[] = [];
				for (const [repoPath, entry] of status) {
					const absolute = workspaceFilePath(workspaceRoot, repoPath, repoPrefix);
					const stat = absolute ? await statSafe(absolute) : undefined;
					const before = previous.get(repoPath);
					const changedSinceBaseline =
						!before ||
						before.code !== entry.code ||
						before.mtimeMs !== (stat?.mtimeMs ?? 0) ||
						before.size !== (stat?.size ?? -1);
					if (!changedSinceBaseline) continue;
					changed.push(repoPath);
					// A rename that did not exist at begin() also removes the original
					// path; revert has to recreate it. Copies keep the original file.
					if (entry.originalPath && entry.originalPath !== before?.originalPath) extra.push(entry.originalPath);
				}
				// Pre-existing untracked files that vanished (deleted or renamed away)
				// never show up in `git status`; remember them for revert.
				for (const [repoPath, before] of previous) {
					if (before.code === '??' && !status.has(repoPath)) extra.push(repoPath);
				}
				changed.sort();
				// Paths that only revert cares about (rename originals / vanished
				// untracked files) are recorded next to the visible change list.
				const extraRevertPaths = [...new Set(extra.filter((repoPath) => !changed.includes(repoPath)))].sort();
				const recordedPaths = [...changed, ...extraRevertPaths];
				postState =
					recordedPaths.length > 0
						? await recordPostState(repoRootPath(workspaceRoot, repoPrefix), recordedPaths)
						: new Map();
				options.log.info(`本轮改动文件：${changed.length} 个。`);
				return changed;
			} catch (error) {
				options.log.warn(`计算本轮改动失败：${String(error)}`);
				resetRevertState();
				return [];
			}
		},

		canRevert() {
			return Boolean(
				baseline &&
					baselineRoot === options.workspaceRoot() &&
					beginState &&
					!beginState.reason &&
					postState &&
					postState.size > 0,
			);
		},

		async revertLastTurn(): Promise<RevertResult> {
			const refuse = (error: string): RevertResult => ({ ok: false, reverted: [], skipped: [], error });
			const workspaceRoot = options.workspaceRoot();
			if (!workspaceRoot) return refuse('未打开工作区文件夹，无法撤销本轮修改。');
			if (!baseline || !beginState || !postState || postState.size === 0) {
				return refuse('没有可撤销的本轮改动。');
			}
			if (baselineRoot !== workspaceRoot) return refuse('工作区已切换，无法撤销上一轮的修改。');
			if (beginState.reason) return refuse(beginState.reason);

			try {
				if (!(await git.isGitRepo(workspaceRoot))) return refuse('当前工作区不是 Git 仓库，无法撤销本轮修改。');
				const repoPrefix = await git.repoPrefix(workspaceRoot);
				const repoRoot = repoRootPath(workspaceRoot, repoPrefix);
				const changed = [...postState.keys()];
				const recorded = postState;
				// 重新读取当前状态做哈希校验：本轮结束后被手动修改过就整体拒绝。
				const current = await recordPostState(repoRoot, changed);
				const beginStatus = new Map<string, { code: string }>();
				for (const [repoPath, entry] of baseline) beginStatus.set(repoPath, { code: entry.code });
				const preImages = await collectPreImages(repoRoot, { changed, begin: beginState, beginStatus });
				const plan = planRevert({ changed, preImages, recorded, current });
				if (plan.error) return { ok: false, reverted: [], skipped: plan.skipped, error: plan.error };

				const applied = await applyRevert(repoRoot, plan.actions);
				if (applied.errors.length > 0) {
					return {
						ok: false,
						reverted: applied.reverted,
						skipped: plan.skipped,
						error: `撤销过程中部分文件失败：${applied.errors.join('；')}`,
					};
				}

				// 成功后清空基线，防止对同一轮重复撤销。
				baseline = undefined;
				resetRevertState();
				options.log.info(`已撤销本轮修改：${applied.reverted.length} 个文件。`);
				return { ok: true, reverted: applied.reverted, skipped: plan.skipped };
			} catch (error) {
				options.log.warn(`撤销本轮修改失败：${String(error)}`);
				return refuse(`撤销本轮修改失败：${String(error)}`);
			}
		},

		async show(files) {
			const workspaceRoot = options.workspaceRoot();
			if (!workspaceRoot) {
				void vscode.window.showWarningMessage('未打开工作区文件夹，无法查看本轮改动。');
				return;
			}
			if (!(await git.isGitRepo(workspaceRoot))) {
				void vscode.window.showWarningMessage('当前工作区不是 Git 仓库，无法显示「本轮改动」的原生 diff。');
				return;
			}
			if (files.length === 0) {
				void vscode.window.showInformationMessage('本轮没有检测到文件改动。');
				return;
			}

			const repoPrefix = await git.repoPrefix(workspaceRoot);
			let selected: string | undefined;
			if (files.length === 1) {
				selected = files[0];
			} else {
				const items = files.map((repoPath) => ({
					label: toWorkspaceRelative(repoPath, repoPrefix) ?? repoPath,
					description: repoPath,
					repoPath,
				}));
				const picked = await vscode.window.showQuickPick(items, {
					title: '本轮改动',
					placeHolder: '选择要查看的文件（HEAD ↔ 工作区）',
				});
				selected = picked?.repoPath;
			}
			if (!selected) return;
			await revealDiff(workspaceRoot, selected, repoPrefix);
		},
	};
}
