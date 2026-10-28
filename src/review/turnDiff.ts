/**
 * "Review this turn's changes" helpers.
 *
 * Pure module (no vscode, no node:fs) so the partitioning of the turn's
 * changed paths and the prompt assembly are unit-testable: the extension-side
 * service only reads file contents and git output and hands the results here.
 *
 * The flow is: `partitionTurnPaths` splits the turn's repo-relative paths into
 * tracked changes (a real diff exists) and untracked ones (new files whose
 * content must be embedded), `toPathspecs` turns the tracked paths into
 * cwd-relative git pathspecs, and `buildTurnDiffPrompt` produces the review
 * prompt that combines both halves.
 */
import type { ReviewInput } from './contracts';
import { buildReviewPrompt, type PromptFileRef, type PromptNewFile } from './prompts';

export interface TurnPathsPartition {
	/** Repo-relative paths with a diff against HEAD. */
	tracked: string[];
	/** Repo-relative paths not in the index yet (porcelain `??`). */
	untracked: string[];
	/** Paths intentionally left out of the review, with a user-facing reason. */
	skipped: Array<{ path: string; reason: string }>;
}

/** Normalize a repo-relative path to POSIX separators and strip a leading `./`. */
function normalizeRepoRelative(repoPath: string): string {
	return repoPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Normalize the workspace prefix; git reports it with a trailing slash. */
function normalizePrefix(repoPrefix: string): string {
	const normalized = repoPrefix.replace(/\\/g, '/');
	if (!normalized) return '';
	return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/**
 * Turn repo-relative paths into git pathspecs relative to the workspace root
 * (the cwd of git commands): the repo prefix is stripped when the workspace is
 * a sub-directory of the repository. Paths outside the workspace are skipped
 * and duplicates are collapsed.
 */
export function toPathspecs(repoPrefix: string, repoPaths: readonly string[]): string[] {
	const prefix = normalizePrefix(repoPrefix);
	const specs: string[] = [];
	const seen = new Set<string>();
	for (const repoPath of repoPaths) {
		const normalized = normalizeRepoRelative(repoPath);
		if (!normalized) continue;
		if (prefix && !normalized.startsWith(prefix)) continue;
		const relative = prefix ? normalized.slice(prefix.length) : normalized;
		if (!relative || seen.has(relative)) continue;
		seen.add(relative);
		specs.push(relative);
	}
	return specs;
}

/**
 * Split this turn's repo-relative paths into tracked / untracked according to
 * the porcelain status, and record paths outside the workspace (a multi-root
 * or sub-directory workspace can see changes in sibling folders).
 */
export function partitionTurnPaths(
	status: ReadonlyMap<string, { code: string }>,
	repoPaths: readonly string[],
	repoPrefix: string,
): TurnPathsPartition {
	const prefix = normalizePrefix(repoPrefix);
	const partition: TurnPathsPartition = { tracked: [], untracked: [], skipped: [] };
	const seen = new Set<string>();
	for (const repoPath of repoPaths) {
		const normalized = normalizeRepoRelative(repoPath);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		if (prefix && !normalized.startsWith(prefix)) {
			partition.skipped.push({ path: normalized, reason: '工作区外' });
			continue;
		}
		if (status.get(normalized)?.code === '??') {
			partition.untracked.push(normalized);
		} else {
			partition.tracked.push(normalized);
		}
	}
	return partition;
}

export interface TurnDiffPromptInput {
	/** Diff of the tracked changes (already truncated to the char budget). */
	diffText: string;
	/** Workspace-relative refs of the diffed files. */
	files: readonly PromptFileRef[];
	/** Untracked files whose content is embedded after the diff. */
	newFiles: readonly PromptNewFile[];
	truncated: boolean;
	maxChars: number;
}

/**
 * Build the review prompt for one turn's changes. Returns `undefined` when the
 * turn changed nothing worth reviewing (silent no-op for the caller).
 */
export function buildTurnDiffPrompt(input: TurnDiffPromptInput): ReviewInput | undefined {
	if (!input.diffText.trim() && input.newFiles.length === 0) return undefined;
	return buildReviewPrompt(
		{
			kind: 'diff',
			diffKind: 'working',
			text: input.diffText,
			files: input.files,
			newFiles: input.newFiles,
			truncated: input.truncated,
		},
		{ maxChars: input.maxChars },
	);
}
