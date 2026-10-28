/**
 * Pure helpers for the composer's "排队插话" queue.
 *
 * While the agent is busy a submitted message is stored here instead of being
 * sent: `queue` items run in FIFO order once the current turn settles, and
 * `steer` items jump ahead of every queued item. Steering never cancels the
 * running turn — ACP allows only one in-flight prompt per session, so "insert
 * immediately" means "send first as soon as the runtime is idle again".
 */
import type { PendingMessage } from '../types';

/** Append a message to the end of the queue (stable order). */
export function enqueuePending(list: readonly PendingMessage[], item: PendingMessage): PendingMessage[] {
	return [...list, item];
}

/** Upgrade one queued message to `steer` and move it to the front of the steer group. */
export function promotePending(list: readonly PendingMessage[], id: string): PendingMessage[] {
	const index = list.findIndex((item) => item.id === id);
	if (index < 0) return [...list];
	const target: PendingMessage = { ...list[index], mode: 'steer' };
	const rest = list.filter((item) => item.id !== id);
	const steerItems = rest.filter((item) => item.mode === 'steer');
	const queueItems = rest.filter((item) => item.mode !== 'steer');
	return [...steerItems, target, ...queueItems];
}

/** Remove one pending message (cancel), keeping the order of the others. */
export function removePending(list: readonly PendingMessage[], id: string): PendingMessage[] {
	return list.filter((item) => item.id !== id);
}

/**
 * Take the next message to send: the oldest `steer` item when present, else the
 * oldest `queue` item. Returns `undefined` for an empty queue.
 */
export function takeNextPending(
	list: readonly PendingMessage[],
): { item: PendingMessage; rest: PendingMessage[] } | undefined {
	if (list.length === 0) return undefined;
	const steerIndex = list.findIndex((item) => item.mode === 'steer');
	const index = steerIndex >= 0 ? steerIndex : 0;
	const item = list[index];
	if (!item) return undefined;
	return { item, rest: [...list.slice(0, index), ...list.slice(index + 1)] };
}
