/**
 * 思考链（thought）的纯逻辑：折叠行标题、时长格式化、相邻条目分组。
 *
 * 这里不碰 DOM、也不 import vscode，方便 vitest 直接覆盖；`main.ts` 只负责
 * 把结果渲染成节点。
 */
import type { TranscriptEntry } from '../types';

/** 只保留 `kind: 'thought'` 的条目类型。 */
export type ThoughtEntry = Extract<TranscriptEntry, { kind: 'thought' }>;

export interface ThoughtHeaderInput {
	/** 该组思考是否仍在接收 chunk。 */
	streaming: boolean;
	/** 从首条 thought chunk 到 `streaming: false` 的毫秒数；历史恢复的条目没有。 */
	durationMs?: number;
	/** 是否有可展开的正文。 */
	hasBody: boolean;
}

export interface ThoughtHeader {
	/** 折叠行主文案。 */
	label: string;
	/** 可选补充文案（例如无正文时提示）。 */
	detail?: string;
}

/** 一组在视觉上合并展示的思考条目（相邻、messageId 相同）。 */
export interface ThoughtGroup {
	/** 组 id = 首条 thought 条目的 id，展开状态按它保存。 */
	id: string;
	messageId?: string;
	entries: ThoughtEntry[];
	/** 合并后的正文（chunk 直接拼接，保持原始顺序）。 */
	text: string;
	/** 组内任一条目仍在流式。 */
	streaming: boolean;
	/** 首条条目的时间戳。 */
	at: number;
}

/**
 * 把毫秒格式化成中文时长：`1 秒`、`3 秒`、`1 分 05 秒`。
 * 不足 1 秒按 1 秒显示（「已思考 0 秒」没有意义）；非法值同样退化为 1 秒。
 */
export function formatDuration(ms: number): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	const totalSeconds = Math.max(1, Math.round(safe / 1000));
	if (totalSeconds < 60) return `${totalSeconds} 秒`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

/**
 * 折叠行文案：
 * - 流式中 → `思考中…`；
 * - 已结束且有计时 → `已思考 N 秒`；
 * - 历史恢复（没有计时信息） → `思考过程`。
 */
export function thoughtHeader(input: ThoughtHeaderInput): ThoughtHeader {
	if (input.streaming) return { label: '思考中…' };
	if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
		return { label: `已思考 ${formatDuration(input.durationMs)}` };
	}
	return input.hasBody ? { label: '思考过程' } : { label: '思考过程', detail: '无内容' };
}

/**
 * 把相邻的 thought 条目合并成组：相邻、且 messageId 相同（任一方缺 messageId 时
 * 按相邻合并）。非 thought 条目会打断相邻关系，并保持原顺序。
 */
export function groupThoughtEntries(entries: readonly TranscriptEntry[]): ThoughtGroup[] {
	const groups: ThoughtGroup[] = [];
	let current: ThoughtGroup | undefined;
	for (const entry of entries) {
		if (entry.kind !== 'thought') {
			// 其它条目在视觉上隔开了思考，不能跨过去合并。
			current = undefined;
			continue;
		}
		if (current && sameMessage(current.messageId, entry.messageId)) {
			current.entries.push(entry);
			current.text += entry.text;
			current.streaming = current.streaming || entry.streaming === true;
			continue;
		}
		current = {
			id: entry.id,
			messageId: entry.messageId,
			entries: [entry],
			text: entry.text,
			streaming: entry.streaming === true,
			at: entry.at,
		};
		groups.push(current);
	}
	return groups;
}

/** messageId 相同，或任一缺失时都无法区分，按相邻合并。 */
function sameMessage(a: string | undefined, b: string | undefined): boolean {
	return a === undefined || b === undefined || a === b;
}
