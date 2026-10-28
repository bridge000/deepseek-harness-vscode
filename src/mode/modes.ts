/**
 * Client-side collaboration modes: plan / goal.
 *
 * ACP exposes no session-mode surface (only `model` and `reasoning_effort`
 * config options), so the extension cannot switch DeepSeek Harness' native plan
 * or goal modes. Modes are therefore realized the only way an ACP client can:
 *
 * - a prompt section describing the stance (inserted before the user text), and
 * - a client-side permission gate (plan mode rejects writes/commands).
 *
 * Every string and decision here is pure, so `test/modes.test.ts` can cover the
 * matrix without an extension host.
 */
import type { ContentBlock } from '../acp/protocol';
import type { PermissionMode, PermissionRequest, SessionMode } from '../types';

/**
 * Plan-mode guidance. Deliberately does **not** tell the model to call
 * `exit_plan_mode`: the native plan mode is inactive on an ACP session, and the
 * tool fails closed outside it. The plan is delivered as the final message and
 * the user switches the composer mode to execute.
 */
export const PLAN_MODE_SECTION = [
	'## 计划模式（只读，扩展客户端模式）',
	'你现在处于「计划模式」：只做探索、阅读和方案设计，不修改任何文件，也不执行会改变状态的命令。',
	'- 允许：读取文件、搜索、查看 git 历史、静态分析。',
	'- 禁止：写文件、改代码、创建/删除/移动文件、执行安装或构建类命令。',
	'- 输出：用中文给出结构化实施计划（目标、步骤、涉及文件、风险、验证方式），然后停下等待用户确认。',
	'- 本次会话由 VS Code 扩展驱动，DeepSeek Harness 的服务端计划模式未开启，因此不要调用 exit_plan_mode 工具；计划就是你的最终回答。',
	'- 如果用户明确要求“直接改”，提醒对方先把输入区模式切回「自动」。',
].join('\n');

/** Goal-mode guidance: steer the model onto the goal toolchain. */
export const GOAL_MODE_SECTION = [
	'## 目标模式',
	'你现在处于「目标模式」：本次会话有且只有一个跨轮次追踪的完成目标。',
	'- 开始前先 get_goal 读取当前目标；没有目标时用 create_goal 建立（objective 写清可验收的完成标准，max_goal_rounds 按工作量设定）。',
	'- 每完成一个阶段用 update_goal 记录进展；只有验收标准真的全部满足才标 complete。',
	'- 遇到当前轮无法解决、且需要用户或外部条件才能继续的阻塞时，标 blocked 并写清具体原因，不要假装完成。',
	'- 每轮回复末尾用一两行汇报目标状态（目标 / 进度 / 下一步），不要重复整段计划。',
	'- 目标模式不改变写权限：仍按当前权限设置与开关执行。',
].join('\n');

const MODE_SECTIONS: Readonly<Record<Exclude<SessionMode, 'agent'>, string>> = {
	plan: PLAN_MODE_SECTION,
	goal: GOAL_MODE_SECTION,
};

/**
 * Prompt block inserted ahead of every request while a mode is active.
 * Returns `undefined` for the default mode so plain chat stays byte-identical.
 */
export function modePromptBlock(mode: SessionMode): ContentBlock | undefined {
	if (mode === 'agent') return undefined;
	const text = MODE_SECTIONS[mode];
	return text ? { type: 'text', text } : undefined;
}

/** Permission kinds/titles that are safe to allow while planning (read-only). */
const READ_HINTS = [
	'read',
	'view',
	'search',
	'grep',
	'glob',
	'find',
	'list',
	'ls',
	'cat',
	'head',
	'tail',
	'stat',
	'fetch',
	'web',
	'thought',
	'think',
	'get_goal',
	'get',
];

/** Permission kinds/titles that mutate the workspace and must be refused while planning. */
const WRITE_HINTS = [
	'edit',
	'write',
	'patch',
	'create',
	'delete',
	'remove',
	'move',
	'rename',
	'bash',
	'shell',
	'execute',
	'exec',
	'command',
	'cmd',
	'pwsh',
	'powershell',
	'terminal',
	'install',
	'test',
];

function haystack(request: PermissionRequest): string {
	return `${request.toolKind ?? ''} ${request.title ?? ''}`.toLowerCase();
}

function hasHint(text: string, hints: readonly string[]): boolean {
	return hints.some((hint) => text.includes(hint));
}

/**
 * Whether a permission request is read-only enough for plan mode.
 *
 * Fail-closed on purpose: an unknown tool is treated as a potential write, so a
 * plan session cannot mutate the workspace by accident. The escape hatch is the
 * mode selector (the notice tells the user).
 */
export function isPlanSafePermission(request: PermissionRequest): boolean {
	if (request.command) return false;
	const text = haystack(request);
	if (hasHint(text, WRITE_HINTS)) return false;
	return hasHint(text, READ_HINTS);
}

/**
 * The ACP option id that rejects `request`, or `undefined` when the agent
 * offered no reject option (the session layer then answers "cancelled").
 */
export function planModeRejectOption(request: PermissionRequest): string | undefined {
	if (isPlanSafePermission(request)) return undefined;
	return request.options.find((option) => option.kind.startsWith('reject_'))?.optionId;
}

/** Short label used in notices/logs. */
export function modeLabel(mode: SessionMode): string {
	return mode === 'plan' ? '计划' : mode === 'goal' ? '目标' : '自动';
}

/** Permission preset label shared by notices, the diagnose report and logs. */
export function permissionModeLabel(mode: PermissionMode): string {
	return mode === 'read-only' ? '只读' : mode === 'danger-full-access' ? '完全权限' : '工作区内';
}
