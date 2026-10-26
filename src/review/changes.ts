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
import type { ReviewLog } from './diagnostics';

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
}

interface BaselineEntry {
	code: string;
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

export function createChangeTracker(options: ChangeTrackerOptions): ChangeTracker {
	let baseline: Map<string, BaselineEntry> | undefined;

	async function captureBaseline(workspaceRoot: string): Promise<Map<string, BaselineEntry>> {
		const repoPrefix = await git.repoPrefix(workspaceRoot);
		const status = await git.statusPorcelain(workspaceRoot);
		const snapshot = new Map<string, BaselineEntry>();
		for (const [repoPath, entry] of status) {
			const absolute = workspaceFilePath(workspaceRoot, repoPath, repoPrefix);
			const stat = absolute ? await statSafe(absolute) : undefined;
			snapshot.set(repoPath, {
				code: entry.code,
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
			if (!workspaceRoot) return;
			if (!(await git.isGitRepo(workspaceRoot))) {
				options.log.info('工作区不是 Git 仓库，跳过「本轮改动」基线。');
				return;
			}
			try {
				baseline = await captureBaseline(workspaceRoot);
				options.log.info(`已记录本轮改动基线：${baseline.size} 个待提交文件。`);
			} catch (error) {
				options.log.warn(`记录本轮改动基线失败：${String(error)}`);
			}
		},

		async end() {
			const workspaceRoot = options.workspaceRoot();
			if (!workspaceRoot || !baseline) return [];
			const previous = baseline;
			try {
				const repoPrefix = await git.repoPrefix(workspaceRoot);
				const status = await git.statusPorcelain(workspaceRoot);
				const changed: string[] = [];
				for (const [repoPath, entry] of status) {
					const absolute = workspaceFilePath(workspaceRoot, repoPath, repoPrefix);
					const stat = absolute ? await statSafe(absolute) : undefined;
					const before = previous.get(repoPath);
					const changedSinceBaseline =
						!before ||
						before.code !== entry.code ||
						before.mtimeMs !== (stat?.mtimeMs ?? 0) ||
						before.size !== (stat?.size ?? -1);
					if (changedSinceBaseline) changed.push(repoPath);
				}
				changed.sort();
				options.log.info(`本轮改动文件：${changed.length} 个。`);
				return changed;
			} catch (error) {
				options.log.warn(`计算本轮改动失败：${String(error)}`);
				return [];
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
