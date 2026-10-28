import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '../src/types';
import { enqueuePending, promotePending, removePending, takeNextPending } from '../src/session/pending';

function message(id: string, mode: PendingMessage['mode'] = 'queue'): PendingMessage {
	return { id, text: `text-${id}`, mode, at: Number(id) };
}

describe('pending queue', () => {
	it('按提交顺序入队（FIFO）', () => {
		let list = enqueuePending([], message('1'));
		list = enqueuePending(list, message('2'));
		expect(list.map((item) => item.id)).toEqual(['1', '2']);
	});

	it('引导项优先于排队项，且同组内保持 FIFO', () => {
		const list = [message('1'), message('2'), message('3', 'steer'), message('4')];
		const first = takeNextPending(list);
		expect(first?.item.id).toBe('3');
		const second = takeNextPending(first!.rest);
		expect(second?.item.id).toBe('1');
	});

	it('promotePending 把排队项升级为引导并稳定插入引导组末尾', () => {
		const list = [message('1'), message('2'), message('3', 'steer'), message('4')];
		const promoted = promotePending(list, '2');
		expect(promoted.map((item) => `${item.id}:${item.mode}`)).toEqual(['3:steer', '2:steer', '1:queue', '4:queue']);
		expect(takeNextPending(promoted)?.item.id).toBe('3');
	});

	it('promote 未知 id 时原样复制', () => {
		const list = [message('1')];
		expect(promotePending(list, 'nope')).toEqual(list);
	});

	it('removePending 只删除目标项', () => {
		const list = [message('1'), message('2')];
		expect(removePending(list, '1').map((item) => item.id)).toEqual(['2']);
	});

	it('空队列返回 undefined', () => {
		expect(takeNextPending([])).toBeUndefined();
	});
});
