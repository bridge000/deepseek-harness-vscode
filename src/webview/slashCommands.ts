/**
 * 输入区斜杠指令表与解析（纯逻辑，无 DOM / 无 vscode 依赖）。
 *
 * 设计目标：
 * - `parseSlashCommand` 只认「精确用法」，用于发送前拦截本地指令；
 * - `matchSlashCommands` 给斜杠面板做前缀过滤；
 * - `shouldShowSlashPalette` 决定是否弹出面板：输入是单个 `/token` 且还没构成一条完整指令。
 *
 * 指令本身不在这里执行，`main.ts` 按 id 分派到 `post(...)` 或本地动作。
 */

export interface SlashCommand {
	id: string;
	usage: string;
	label: string;
	/** 英文小字提示（面板右侧的次要信息）。 */
	hint?: string;
	description: string;
}

/**
 * 指令表。`usage` 里的主命令（第一个空格前）用于前缀匹配，
 * 带参数的形式（`/plan off`、`/goal off`）也各占一行，方便面板直接展示。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		id: 'plan',
		usage: '/plan',
		label: '计划',
		hint: 'plan',
		description: '进入计划模式：只读分析，不修改文件',
	},
	{
		id: 'plan-off',
		usage: '/plan off',
		label: '退出计划',
		hint: 'plan off',
		description: '回到自动模式',
	},
	{
		id: 'goal',
		usage: '/goal',
		label: '目标',
		hint: 'goal',
		description: '进入目标模式：跨轮次追踪完成目标',
	},
	{
		id: 'goal-off',
		usage: '/goal off',
		label: '退出目标',
		hint: 'goal off',
		description: '回到自动模式',
	},
	{
		id: 'auto',
		usage: '/auto',
		label: '自动',
		hint: 'auto',
		description: '退出计划/目标，回到自动模式',
	},
	{
		id: 'new',
		usage: '/new',
		label: '新建会话',
		hint: 'new',
		description: '新建一个 DSH 会话',
	},
	{
		id: 'history',
		usage: '/history',
		label: '会话历史',
		hint: 'history',
		description: '查看并恢复历史会话',
	},
	{
		id: 'review',
		usage: '/review',
		label: '审查当前文件',
		hint: 'review',
		description: '让 DSH 审查当前编辑器里的文件',
	},
	{
		id: 'clear',
		usage: '/clear',
		label: '清除审查结果',
		hint: 'clear',
		description: '清除当前审查发现与编辑器诊断',
	},
	{
		id: 'permission',
		usage: '/permission',
		label: '权限',
		hint: 'permission',
		description: '打开权限菜单',
	},
	{
		id: 'model',
		usage: '/model',
		label: '模型',
		hint: 'model',
		description: '打开模型菜单',
	},
	{
		id: 'diagnose',
		usage: '/diagnose',
		label: '兼容性诊断',
		hint: 'diagnose',
		description: '生成 DSH 兼容性诊断报告',
	},
	{
		id: 'settings',
		usage: '/settings',
		label: '打开设置',
		hint: 'settings',
		description: '打开 DeepSeek Harness 设置',
	},
	{
		id: 'help',
		usage: '/help',
		label: '指令帮助',
		hint: 'help',
		description: '查看全部指令',
	},
];

/** usage 的主命令：`/plan off` → `/plan`。 */
function primaryUsage(command: SlashCommand): string {
	const space = command.usage.indexOf(' ');
	return (space < 0 ? command.usage : command.usage.slice(0, space)).toLowerCase();
}

/** 统一大小写与空白：去掉首尾空白，内部连续空白压成一个空格。 */
function normalizeCommandText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 精确解析一条斜杠指令。
 *
 * - 去首尾空白、大小写不敏感，`/plan off` 允许单个空格（连续空白也会被压缩）；
 * - 带额外正文（`/plan 帮我分析`）、未知指令、非 `/` 开头一律返回 `undefined`；
 * - 返回的 `arg` 目前恒为 `undefined`，保留字段是为了以后支持带参数指令。
 */
export function parseSlashCommand(text: string): { command: SlashCommand; arg?: string } | undefined {
	if (typeof text !== 'string') return undefined;
	const normalized = normalizeCommandText(text);
	if (normalized.length === 0 || !normalized.startsWith('/')) return undefined;
	const command = SLASH_COMMANDS.find((item) => normalizeCommandText(item.usage) === normalized);
	if (!command) return undefined;
	return { command };
}

/**
 * 斜杠面板的前缀过滤：输入以 `/` 开头且不含换行，按 usage 做前缀匹配。
 *
 * `'/'` 返回全部指令；`'/pl'` 返回 `/plan`、`/plan off`；`'/'` 后面带正文时不匹配。
 */
export function matchSlashCommands(text: string): SlashCommand[] {
	if (typeof text !== 'string') return [];
	if (/[\r\n]/.test(text)) return [];
	const source = text.trim();
	if (!source.startsWith('/')) return [];
	const query = source.toLowerCase();
	if (query === '/') return [...SLASH_COMMANDS];
	return SLASH_COMMANDS.filter((command) => {
		const usage = command.usage.toLowerCase();
		return usage.startsWith(query) || primaryUsage(command).startsWith(query);
	});
}

/**
 * 是否应该显示斜杠面板：输入恰好是单个 `/token`（不能有空格/换行），
 * 且尚未构成一条可直接执行的完整指令（避免选中后输入框里还挂着面板）。
 */
export function shouldShowSlashPalette(text: string): boolean {
	if (typeof text !== 'string') return false;
	if (!/^\/\S*$/.test(text)) return false;
	return parseSlashCommand(text) === undefined;
}
