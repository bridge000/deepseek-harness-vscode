import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../src/types';
import { formatDuration, groupThoughtEntries, thoughtHeader } from '../src/webview/thought';

function thought(
	id: string,
	text: string,
	extra: { messageId?: string; streaming?: boolean; at?: number } = {},
): TranscriptEntry {
	return { id, kind: 'thought', text, at: extra.at ?? 0, ...extra };
}

describe('formatDuration', () => {
	it('不足 1 秒按 1 秒显示', () => {
		expect(formatDuration(0)).toBe('1 秒');
		expect(formatDuration(400)).toBe('1 秒');
		expect(formatDuration(999)).toBe('1 秒');
	});

	it('按秒取整', () => {
		expect(formatDuration(1000)).toBe('1 秒');
		expect(formatDuration(3000)).toBe('3 秒');
		expect(formatDuration(2600)).toBe('3 秒');
	});

	it('超过 1 分钟时补零秒', () => {
		expect(formatDuration(65_000)).toBe('1 分 05 秒');
		expect(formatDuration(120_000)).toBe('2 分 00 秒');
		expect(formatDuration(59_000)).toBe('59 秒');
	});

	it('负数与 NaN 退化为 1 秒', () => {
		expect(formatDuration(-5000)).toBe('1 秒');
		expect(formatDuration(Number.NaN)).toBe('1 秒');
	});
});

describe('thoughtHeader', () => {
	it('流式中显示「思考中…」', () => {
		expect(thoughtHeader({ streaming: true, hasBody: true })).toEqual({ label: '思考中…' });
		// 流式中即使已有计时也按「思考中…」显示，避免时长跳动。
		expect(thoughtHeader({ streaming: true, durationMs: 3000, hasBody: true }).label).toBe('思考中…');
	});

	it('完成后显示「已思考 N 秒」', () => {
		expect(thoughtHeader({ streaming: false, durationMs: 4200, hasBody: true }).label).toBe('已思考 4 秒');
		expect(thoughtHeader({ streaming: false, durationMs: 0, hasBody: true }).label).toBe('已思考 1 秒');
		expect(thoughtHeader({ streaming: false, durationMs: 65_000, hasBody: true }).label).toBe(
			'已思考 1 分 05 秒',
		);
	});

	it('历史恢复（无计时）显示「思考过程」', () => {
		expect(thoughtHeader({ streaming: false, hasBody: true })).toEqual({ label: '思考过程' });
	});

	it('历史恢复且没有正文时提示「无内容」', () => {
		expect(thoughtHeader({ streaming: false, hasBody: false })).toEqual({
			label: '思考过程',
			detail: '无内容',
		});
	});
});

describe('groupThoughtEntries', () => {
	it('空数组返回空分组', () => {
		expect(groupThoughtEntries([])).toEqual([]);
	});

	it('相邻且 messageId 相同的条目合并', () => {
		const groups = groupThoughtEntries([
			thought('t1', '先看看 ', { messageId: 'm1', streaming: true, at: 10 }),
			thought('t2', '入口文件', { messageId: 'm1', at: 20 }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].id).toBe('t1');
		expect(groups[0].messageId).toBe('m1');
		expect(groups[0].text).toBe('先看看 入口文件');
		expect(groups[0].entries.map((entry) => entry.id)).toEqual(['t1', 't2']);
		expect(groups[0].streaming).toBe(true);
		expect(groups[0].at).toBe(10);
	});

	it('messageId 不同不合并', () => {
		const groups = groupThoughtEntries([
			thought('t1', '第一段', { messageId: 'm1' }),
			thought('t2', '第二段', { messageId: 'm2' }),
		]);
		expect(groups).toHaveLength(2);
		expect(groups[1].text).toBe('第二段');
		expect(groups[1].streaming).toBe(false);
	});

	it('缺少 messageId 时按相邻合并', () => {
		const groups = groupThoughtEntries([thought('t1', '甲'), thought('t2', '乙')]);
		expect(groups).toHaveLength(1);
		expect(groups[0].text).toBe('甲乙');
		expect(groups[0].messageId).toBeUndefined();
	});

	it('非 thought 条目会打断相邻关系', () => {
		const user: TranscriptEntry = { id: 'u1', kind: 'user', text: '继续', at: 5 };
		const groups = groupThoughtEntries([
			thought('t1', '甲', { messageId: 'm1' }),
			user,
			thought('t2', '乙', { messageId: 'm1' }),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.entries.map((entry) => entry.id))).toEqual([['t1'], ['t2']]);
	});

	it('保持原顺序并跳过非 thought 条目', () => {
		const assistant: TranscriptEntry = {
			id: 'a1',
			kind: 'assistant',
			text: '好的',
			messageId: 'm1',
			at: 30,
		};
		const groups = groupThoughtEntries([
			thought('t1', '甲', { messageId: 'm1', at: 1 }),
			assistant,
			thought('t2', '乙', { messageId: 'm2', at: 2 }),
			thought('t3', '丙', { messageId: 'm2', at: 3 }),
		]);
		expect(groups.map((group) => group.id)).toEqual(['t1', 't2']);
		expect(groups.map((group) => group.text)).toEqual(['甲', '乙丙']);
	});
});
