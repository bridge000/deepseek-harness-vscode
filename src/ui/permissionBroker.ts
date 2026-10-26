/**
 * Permission broker: routes ACP `session/request_permission` requests to the
 * sidebar card when it is visible, and to the VS Code modal picker otherwise.
 *
 * Kept free of `vscode` imports so the routing/timeout/cancel behaviour can be
 * unit tested with fake timers.
 */
import type { PermissionRequest } from '../types';

export interface PermissionBrokerDeps {
	/** Sidebar visibility; when false the modal picker is used instead. */
	isViewVisible(): boolean;
	/** Push the permission card to the webview. */
	postPermission(request: PermissionRequest): void;
	/** VS Code modal fallback. */
	modalPick(request: PermissionRequest): Promise<string | undefined>;
	/** Config: auto approve every request (dangerous, opt-in). */
	autoApprove(): boolean;
	log(message: string): void;
	/** How long a sidebar card may stay pending before it is auto-cancelled. */
	timeoutMs?: number;
}

export interface PermissionBroker {
	pick(request: PermissionRequest): Promise<string | undefined>;
	respond(requestId: string, optionId?: string): void;
	cancelAll(reason?: string): void;
	pending(): number;
}

interface PendingPermission {
	request: PermissionRequest;
	resolve: (optionId: string | undefined) => void;
	timer?: NodeJS.Timeout;
	settled: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
	const timeoutMs = Math.max(1000, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const pending = new Map<string, PendingPermission>();

	const settle = (requestId: string, optionId: string | undefined, reason: string): void => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled) return;
		entry.settled = true;
		if (entry.timer) clearTimeout(entry.timer);
		pending.delete(requestId);
		deps.log(`[permission] ${reason}：${entry.request.title} -> ${optionId ?? 'cancelled'}`);
		entry.resolve(optionId);
	};

	const pick = async (request: PermissionRequest): Promise<string | undefined> => {
		if (deps.autoApprove()) {
			const allow = request.options.find((option) => option.kind.startsWith('allow_'));
			if (allow) {
				deps.log(`[permission] autoApprove 自动允许：${request.title}`);
				return allow.optionId;
			}
			deps.log('[permission] autoApprove 已开启，但该请求没有 allow 选项，交由用户决定');
		}
		if (!deps.isViewVisible()) {
			deps.log(`[permission] 侧边栏隐藏，使用模态弹窗：${request.title}`);
			return deps.modalPick(request);
		}
		return new Promise<string | undefined>((resolve) => {
			if (pending.has(request.id)) {
				// Defensive: duplicate request ids are never expected, resolve the old one.
				settle(request.id, undefined, '重复的权限请求，旧的按取消处理');
			}
			const entry: PendingPermission = { request, resolve, settled: false };
			pending.set(request.id, entry);
			try {
				deps.postPermission(request);
			} catch (error) {
				pending.delete(request.id);
				deps.log(`[permission] 推送权限卡片失败，改用模态弹窗：${String(error)}`);
				resolve(deps.modalPick(request));
				return;
			}
			entry.timer = setTimeout(() => {
				if (!pending.has(request.id)) return;
				if (!deps.isViewVisible()) {
					deps.log(`[permission] 权限卡片超时且侧边栏已隐藏，回退模态弹窗：${request.title}`);
					void deps.modalPick(request).then((optionId) => settle(request.id, optionId, '弹窗回退结果'));
					return;
				}
				settle(request.id, undefined, '权限卡片超时，按取消处理');
			}, timeoutMs);
		});
	};

	const respond = (requestId: string, optionId?: string): void => {
		if (!pending.has(requestId)) {
			deps.log(`[permission] 忽略未知或已过期的权限响应：${requestId}`);
			return;
		}
		settle(requestId, optionId, '用户在侧边栏选择');
	};

	const cancelAll = (reason = '运行时/会话变化'): void => {
		for (const requestId of [...pending.keys()]) settle(requestId, undefined, `取消全部（${reason}）`);
	};

	return {
		pick,
		respond,
		cancelAll,
		pending: () => pending.size,
	};
}
