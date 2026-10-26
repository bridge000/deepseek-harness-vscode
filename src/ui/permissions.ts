/**
 * 权限选择器：把 ACP `session/request_permission` 变成 VS Code 模态弹窗。
 *
 * 弹窗按钮使用 ACP 返回的选项 name（如“允许一次”“一直允许”），返回值是对应
 * optionId；用户关闭弹窗时返回 undefined，由调用方按取消处理。
 */
import * as vscode from 'vscode';
import type { PermissionRequest } from '../types';

export interface PermissionPickerOptions {
	/** 为 true 时自动选择第一个 allow_* 选项（配合 extension 的 autoApprove 配置）。 */
	autoApprove?: () => boolean;
	log?: (line: string) => void;
}

const MAX_DETAIL_CHARS = 1200;
const MAX_PATH_ITEMS = 5;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 拼出弹窗 detail：工具名/类型/涉及路径/命令摘要，全部截断避免撑爆弹窗。 */
export function formatPermissionDetail(request: PermissionRequest): string {
	const lines: string[] = [];
	lines.push(`工具：${request.title}`);
	if (request.toolKind) lines.push(`类型：${request.toolKind}`);
	if (request.locations.length > 0) {
		const shown = request.locations.slice(0, MAX_PATH_ITEMS).map((location) => {
			const suffix = location.line === undefined ? '' : `:${location.line}`;
			return `${location.path}${suffix}`;
		});
		const more = request.locations.length > shown.length ? `（另有 ${request.locations.length - shown.length} 个）` : '';
		lines.push(`路径：${shown.join('、')}${more}`);
	}
	if (request.command) lines.push(`命令：${request.command}`);
	return truncate(lines.join('\n'), MAX_DETAIL_CHARS);
}

export function createPermissionPicker(options: PermissionPickerOptions = {}): (request: PermissionRequest) => Promise<string | undefined> {
	const log = options.log ?? (() => undefined);
	return async (request: PermissionRequest): Promise<string | undefined> => {
		if (options.autoApprove?.()) {
			const allow = request.options.find((option) => option.kind.startsWith('allow_'));
			if (allow) {
				log(`[permission] autoApprove 自动允许：${request.title}`);
				return allow.optionId;
			}
		}
		const buttons = request.options.map((option) => option.name);
		const picked = await vscode.window.showWarningMessage(
			`DSH 请求权限：${request.title}`,
			{ modal: true, detail: formatPermissionDetail(request) },
			...buttons,
		);
		if (typeof picked !== 'string') {
			log('[permission] 用户关闭了权限弹窗，按取消处理');
			return undefined;
		}
		const index = buttons.indexOf(picked);
		const optionId = index >= 0 ? request.options[index]?.optionId : undefined;
		log(`[permission] 用户选择 ${optionId ?? '取消'}：${request.title}`);
		return optionId;
	};
}
