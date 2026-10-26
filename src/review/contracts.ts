/**
 * Contracts for the review subsystem (context collection, git diffs, prompt
 * construction, findings parsing, diagnostics and change viewing).
 */
import type * as vscode from 'vscode';
import type { ContextRef, Finding, ReviewReport } from '../types';
import type { ContentBlock } from '../acp/protocol';

export interface ReviewInput {
	/** Short label rendered in the transcript ("审查 src/a.ts"). */
	label: string;
	/** ACP prompt content blocks (prompt text + context resources). */
	blocks: ContentBlock[];
}

export type DiffKind = 'working' | 'staged' | 'commit';
export type ReviewKind = 'review' | 'explain';

export interface ReviewService {
	/** Whether the workspace root is inside a git repository. */
	isGit(): Promise<boolean>;
	collectFile(uri?: vscode.Uri, kind?: ReviewKind): Promise<ReviewInput | undefined>;
	collectSelection(kind: ReviewKind): Promise<ReviewInput | undefined>;
	collectDiff(kind: DiffKind): Promise<ReviewInput | undefined>;
	/** Quick pick over workspace files, returns context refs for the composer. */
	pickContextFiles(): Promise<ContextRef[]>;
	/** Parse the agent's findings JSON contract and publish VS Code diagnostics. */
	publishFindings(label: string, markdown: string): Promise<Finding[]>;
	clearFindings(): void;
	latest(): ReviewReport | undefined;
	/** Snapshot git status before a prompt that may modify files. */
	beginChanges(): Promise<void>;
	/** Files changed since `beginChanges()` (repo-relative paths). */
	endChanges(): Promise<string[]>;
	/** Native diff view for files changed in the last turn. */
	showChanges(files: string[]): Promise<void>;
}

export interface ReviewServiceDeps {
	/** Directory for temporary originals shown in native diffs. */
	storageDir: string;
	maxReviewChars: number;
	log: {
		info(message: string): void;
		warn(message: string): void;
		error(message: string): void;
	};
}
