import { describe, expect, it } from 'vitest';

import type { PermissionOptionInfo, PermissionRequest } from '../src/types';
import {
	GOAL_MODE_SECTION,
	PLAN_MODE_SECTION,
	isPlanSafePermission,
	modeLabel,
	modePromptBlock,
	planModeRejectOption,
} from '../src/mode/modes';

const ALLOW: PermissionOptionInfo = { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' };
const REJECT: PermissionOptionInfo = { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' };

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
	return {
		id: 'perm-1',
		sessionId: 'session-1',
		title: '读取文件',
		options: [ALLOW, REJECT],
		locations: [],
		...overrides,
	};
}

describe('modePromptBlock', () => {
	it('默认模式不注入任何块', () => {
		expect(modePromptBlock('agent')).toBeUndefined();
	});

	it('计划模式注入只读指导，且明确禁止调用 exit_plan_mode', () => {
		const block = modePromptBlock('plan');
		expect(block).toBeDefined();
		expect(block?.type).toBe('text');
		const text = String((block as { text?: unknown }).text ?? '');
		expect(text).toBe(PLAN_MODE_SECTION);
		expect(text).toContain('计划模式');
		expect(text).toContain('不修改任何文件');
		expect(text).toContain('不要调用 exit_plan_mode');
		// 不能把服务端不可用的工具说成可用动作。
		expect(text).not.toContain('调用 exit_plan_mode 提交计划');
	});

	it('目标模式注入目标工具链指导', () => {
		const block = modePromptBlock('goal');
		expect(block).toBeDefined();
		const text = String((block as { text?: unknown }).text ?? '');
		expect(text).toBe(GOAL_MODE_SECTION);
		expect(text).toContain('目标模式');
		expect(text).toContain('create_goal');
		expect(text).toContain('update_goal');
		expect(text).toContain('blocked');
	});
});

describe('modeLabel', () => {
	it('三种模式的短文案', () => {
		expect(modeLabel('agent')).toBe('自动');
		expect(modeLabel('plan')).toBe('计划');
		expect(modeLabel('goal')).toBe('目标');
	});
});

describe('planModeRejectOption', () => {
	it('读类工具放行（返回 undefined）', () => {
		expect(isPlanSafePermission(request({ toolKind: 'read', title: '读取 src/a.ts' }))).toBe(true);
		expect(planModeRejectOption(request({ toolKind: 'search', title: '搜索' }))).toBeUndefined();
		expect(planModeRejectOption(request({ toolKind: 'fetch', title: '抓取网页' }))).toBeUndefined();
	});

	it('写类工具返回 reject 选项', () => {
		expect(planModeRejectOption(request({ toolKind: 'edit', title: '修改 src/a.ts' }))).toBe(REJECT.optionId);
		expect(planModeRejectOption(request({ toolKind: 'write', title: '写入文件' }))).toBe(REJECT.optionId);
		expect(planModeRejectOption(request({ toolKind: 'execute', title: '运行命令' }))).toBe(REJECT.optionId);
	});

	it('带命令行的请求一律拒绝（即使工具名像读取）', () => {
		expect(isPlanSafePermission(request({ toolKind: 'read', command: 'pwsh -c "rm x"' }))).toBe(false);
		expect(planModeRejectOption(request({ toolKind: 'read', command: 'echo hi' }))).toBe(REJECT.optionId);
	});

	it('未知工具 fail-closed', () => {
		expect(isPlanSafePermission(request({ toolKind: 'mcp_thing', title: '某个 MCP 工具' }))).toBe(false);
		expect(planModeRejectOption(request({ toolKind: 'mcp_thing', title: '某个 MCP 工具' }))).toBe(REJECT.optionId);
	});

	it('没有 reject 选项时返回 undefined（由会话层按取消处理）', () => {
		expect(planModeRejectOption(request({ toolKind: 'edit', options: [ALLOW] }))).toBeUndefined();
	});

	it('title 与 kind 都为空的请求按未知处理', () => {
		expect(isPlanSafePermission(request({ toolKind: undefined, title: '' }))).toBe(false);
	});
});
