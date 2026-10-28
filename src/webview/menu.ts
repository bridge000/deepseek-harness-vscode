/**
 * 统一 popover 菜单（DSH Web 风格的二级菜单）。
 *
 * - 单例：同一时刻只允许一个 popover；
 * - 挂在 `#app` 下，`position: fixed`，按 anchor 的 `getBoundingClientRect()` 定位，
 *   输入区在底部，所以优先向上展开，上方不够时翻到下方，并做左右夹紧；
 * - 两种键盘模式：
 *   - `menu`：打开时把焦点移到第一个可操作项，方向键循环、Enter/Space 触发、Esc 还焦 anchor；
 *   - `anchor`：焦点留在 textarea（斜杠面板），方向键/Enter 由 main.ts 处理，
 *     菜单只负责渲染 / `highlightPopoverItem()` 高亮 / 滚动到可见。
 *
 * 只使用内联 SVG 图标与 VS Code 主题变量，不引外部资源。
 */

export interface MenuItemModel {
	kind?: 'item';
	id: string;
	label: string;
	/** 英文小字提示（label 右侧）。 */
	hint?: string;
	/** 右侧灰色说明。 */
	description?: string;
	checked?: boolean;
	disabled?: boolean;
	/** 危险动作（完全权限等）用 warning 色。 */
	danger?: boolean;
}

export interface MenuSection {
	kind: 'section';
	label: string;
	items: MenuItemModel[];
}

export interface MenuSlider {
	kind: 'slider';
	id: string;
	label: string;
	ticks: string[];
	value: number;
	onChange: (index: number) => void;
}

export type MenuEntry = MenuSection | MenuSlider;

export interface OpenPopoverOptions {
	title?: string;
	align?: 'left' | 'right';
	keyboard?: 'menu' | 'anchor';
	onPick?: (id: string) => void;
	onClose?: () => void;
}

export type MenuIconName =
	| 'plus'
	| 'file'
	| 'plan'
	| 'goal'
	| 'shield'
	| 'review'
	| 'model'
	| 'history'
	| 'gear'
	| 'check'
	| 'terminal'
	| 'slash'
	| 'auto';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 内联 SVG 图标（stroke 用 currentColor，由 CSS 控制颜色与尺寸）。 */
const ICON_PATHS: Readonly<Record<MenuIconName, readonly string[]>> = {
	plus: ['M12 5v14', 'M5 12h14'],
	file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
	plan: [
		'M8.5 6h11',
		'M8.5 12h11',
		'M8.5 18h8',
		'M4.5 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
		'M4.5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
		'M4.5 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
	],
	goal: [
		'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
		'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
		'M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
	],
	shield: ['M12 3l7 3v5.5c0 4.4-2.9 7.6-7 9.5-4.1-1.9-7-5.1-7-9.5V6z', 'M9 11.5l2 2 4-4.5'],
	review: [
		'M11 3l1.7 4.8 4.8 1.7-4.8 1.7L11 16l-1.7-4.8L4.5 9.5l4.8-1.7z',
		'M18 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
	],
	model: [
		'M8 8h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z',
		'M9 5v3',
		'M15 5v3',
		'M9 16v3',
		'M15 16v3',
		'M5 10h3',
		'M5 14h3',
		'M16 10h3',
		'M16 14h3',
	],
	history: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5l3.5 2'],
	gear: [
		'M3 6h18',
		'M3 12h18',
		'M3 18h18',
		'M8 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3',
		'M16 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3',
		'M10 16.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3',
	],
	check: ['M5 12.5l4.5 4.5L19 7'],
	terminal: [
		'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
		'M7 9l3 3-3 3',
		'M13 15h4',
	],
	slash: ['M15 4L9 20'],
	auto: ['M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z'],
};

/** id → 图标：先按固定表，再按形状兜底（模型值是 JSON 数组、斜杠指令以 `/` 开头）。 */
const ICON_BY_ID: Readonly<Record<string, MenuIconName>> = {
	attach: 'file',
	file: 'file',
	agent: 'auto',
	plan: 'plan',
	'plan-off': 'plan',
	goal: 'goal',
	'goal-off': 'goal',
	auto: 'auto',
	'mode:agent': 'auto',
	'mode:plan': 'plan',
	'mode:goal': 'goal',
	'review-file': 'review',
	'review-changes': 'review',
	'explain-selection': 'file',
	review: 'review',
	new: 'plus',
	'new-session': 'plus',
	history: 'history',
	'turn-changes': 'history',
	clear: 'check',
	'clear-findings': 'check',
	diagnose: 'terminal',
	settings: 'gear',
	restart: 'auto',
	permission: 'shield',
	'workspace-write': 'shield',
	'read-only': 'shield',
	'danger-full-access': 'shield',
	'auto-review': 'review',
	model: 'model',
	reasoning: 'auto',
	help: 'slash',
	__empty: 'model',
};

function iconNameForItem(item: MenuItemModel): MenuIconName {
	const mapped = ICON_BY_ID[item.id];
	if (mapped) return mapped;
	if (item.id.startsWith('/')) return 'slash';
	if (item.id.startsWith('[')) return 'model';
	return 'auto';
}

function createElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** 内联 SVG 图标（16 × 16），`name` 见 `MenuIconName`。 */
export function icon(name: MenuIconName, size = 16): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.7');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	for (const data of ICON_PATHS[name]) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', data);
		svg.append(path);
	}
	return svg;
}

interface ActivePopover {
	root: HTMLDivElement;
	anchor: HTMLElement;
	options: OpenPopoverOptions;
	keyboard: 'menu' | 'anchor';
}

let active: ActivePopover | undefined;

function popoverHost(): HTMLElement {
	return document.getElementById('app') ?? document.body;
}

function enabledItems(root: HTMLElement): HTMLButtonElement[] {
	return Array.from(root.querySelectorAll<HTMLButtonElement>('.popover-item:not(.disabled)'));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(min, value), Math.max(min, max));
}

/** 按 anchor 矩形定位：优先向上，空间不足翻到下方，左右夹紧 8px。 */
function positionPopover(root: HTMLElement, anchor: HTMLElement, align: 'left' | 'right'): void {
	const rect = anchor.getBoundingClientRect();
	const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
	const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
	const margin = 8;
	const gap = 6;
	const width = root.offsetWidth;
	const height = root.offsetHeight;

	let left = align === 'right' ? rect.right - width : rect.left;
	left = clamp(left, margin, viewportWidth - width - margin);

	let top = rect.top - height - gap;
	if (top < margin) top = rect.bottom + gap;
	if (top + height > viewportHeight - margin) {
		top = Math.max(margin, viewportHeight - height - margin);
	}

	root.style.left = `${Math.round(left)}px`;
	root.style.top = `${Math.round(top)}px`;
}

function buildItem(item: MenuItemModel): HTMLButtonElement {
	const node = createElement('button', 'popover-item');
	node.type = 'button';
	node.dataset.id = item.id;
	if (item.checked !== undefined) {
		node.setAttribute('role', 'menuitemcheckbox');
		node.setAttribute('aria-checked', item.checked ? 'true' : 'false');
	} else {
		node.setAttribute('role', 'menuitem');
	}
	if (item.disabled) {
		node.disabled = true;
		node.classList.add('disabled');
		node.setAttribute('aria-disabled', 'true');
	}
	if (item.danger) node.classList.add('danger');

	const iconWrap = createElement('span', 'popover-item-icon');
	iconWrap.append(icon(iconNameForItem(item)));
	const label = createElement('span', 'popover-item-label', item.label);
	node.append(iconWrap, label);
	if (item.hint) node.append(createElement('span', 'popover-item-hint', item.hint));
	if (item.description) node.append(createElement('span', 'popover-item-desc', item.description));
	if (item.checked) {
		const check = createElement('span', 'popover-item-check');
		check.append(icon('check', 14));
		node.append(check);
	}
	return node;
}

function buildSlider(slider: MenuSlider): HTMLElement {
	const wrap = createElement('div', 'popover-slider');
	wrap.append(createElement('div', 'popover-slider-label', slider.label));

	const max = Math.max(0, slider.ticks.length - 1);
	const range = createElement('input', 'popover-range');
	range.type = 'range';
	range.min = '0';
	range.max = String(max);
	range.step = '1';
	const current = clamp(slider.value, 0, max);
	range.value = String(current);
	range.setAttribute('aria-label', slider.label);

	const ticks = createElement('div', 'popover-slider-ticks');
	const tickNodes = slider.ticks.map((tick, index) => {
		const node = createElement('span', 'popover-slider-tick', tick);
		node.classList.toggle('is-active', index === current);
		ticks.append(node);
		return node;
	});
	const paint = (index: number): void => {
		tickNodes.forEach((node, nodeIndex) => node.classList.toggle('is-active', nodeIndex === index));
	};
	range.addEventListener('input', () => {
		const index = Number(range.value);
		if (Number.isInteger(index)) paint(index);
	});
	// `input` 只做预览，`change`（松手/键盘确认）才提交一次 setConfig。
	range.addEventListener('change', () => {
		const index = Number(range.value);
		if (!Number.isInteger(index)) return;
		paint(index);
		slider.onChange(index);
	});

	wrap.append(range, ticks);
	return wrap;
}

function focusRelative(root: HTMLElement, direction: 1 | -1): void {
	const items = enabledItems(root);
	if (items.length === 0) return;
	const currentIndex = items.findIndex((node) => node === document.activeElement);
	let next: number;
	if (currentIndex < 0) next = direction > 0 ? 0 : items.length - 1;
	else next = (currentIndex + direction + items.length) % items.length;
	items[next]?.focus();
}

function onMenuKeyDown(event: KeyboardEvent): void {
	if (!active || active.keyboard === 'anchor') return;
	switch (event.key) {
		case 'Escape': {
			event.preventDefault();
			event.stopPropagation();
			const anchor = active.anchor;
			closePopoverMenu();
			anchor.focus();
			return;
		}
		case 'Tab': {
			event.preventDefault();
			const anchor = active.anchor;
			closePopoverMenu();
			anchor.focus();
			return;
		}
		case 'ArrowDown': {
			event.preventDefault();
			focusRelative(active.root, 1);
			return;
		}
		case 'ArrowUp': {
			event.preventDefault();
			focusRelative(active.root, -1);
			return;
		}
		case 'Home': {
			event.preventDefault();
			enabledItems(active.root)[0]?.focus();
			return;
		}
		case 'End': {
			event.preventDefault();
			const items = enabledItems(active.root);
			items[items.length - 1]?.focus();
			return;
		}
		default:
			return;
	}
}

function onDocumentPointerDown(event: Event): void {
	if (!active) return;
	const target = event.target as Node | null;
	if (!target) return;
	if (active.root.contains(target) || active.anchor.contains(target)) return;
	closePopoverMenu();
}

function onWindowResize(): void {
	closePopoverMenu();
}

/**
 * 打开统一 popover 菜单。同一时刻只有一个 popover，重复调用会先关掉上一个。
 * `entries` 每次打开时由调用方按最新 state 重建，保证勾选状态是最新的。
 */
export function openPopoverMenu(
	anchor: HTMLElement,
	entries: MenuEntry[],
	options: OpenPopoverOptions = {},
): void {
	closePopoverMenu();

	const keyboard = options.keyboard ?? 'menu';
	const align = options.align ?? 'left';
	const root = createElement('div', 'popover');
	root.setAttribute('role', 'menu');
	root.style.visibility = 'hidden';

	if (options.title) root.append(createElement('div', 'popover-title', options.title));

	for (const entry of entries) {
		if (entry.kind === 'slider') {
			root.append(buildSlider(entry));
			continue;
		}
		const section = createElement('div', 'popover-section');
		if (entry.label) section.append(createElement('div', 'popover-section-label', entry.label));
		for (const item of entry.items) {
			const node = buildItem(item);
			node.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				if (item.disabled) return;
				const onPick = options.onPick;
				closePopoverMenu();
				onPick?.(item.id);
			});
			section.append(node);
		}
		root.append(section);
	}

	popoverHost().append(root);
	positionPopover(root, anchor, align);
	root.style.visibility = '';

	active = { root, anchor, options, keyboard };
	anchor.setAttribute('aria-expanded', 'true');
	anchor.setAttribute('aria-haspopup', 'menu');

	if (keyboard === 'menu') {
		root.addEventListener('keydown', onMenuKeyDown);
		enabledItems(root)[0]?.focus();
	}
	document.addEventListener('pointerdown', onDocumentPointerDown, true);
	window.addEventListener('resize', onWindowResize);
}

/** 关闭当前 popover（若存在）并触发 `onClose`。 */
export function closePopoverMenu(): void {
	const current = active;
	if (!current) return;
	active = undefined;
	current.anchor.setAttribute('aria-expanded', 'false');
	document.removeEventListener('pointerdown', onDocumentPointerDown, true);
	window.removeEventListener('resize', onWindowResize);
	current.root.remove();
	current.options.onClose?.();
}

export function isPopoverMenuOpen(): boolean {
	return active !== undefined;
}

/**
 * 高亮指定条目（anchor 键盘模式下由 main.ts 的 textarea 方向键调用），并滚动到可见。
 * `menu` 模式下同时把焦点移过去。
 */
export function highlightPopoverItem(id: string): void {
	if (!active) return;
	const items = Array.from(active.root.querySelectorAll<HTMLButtonElement>('.popover-item'));
	let target: HTMLButtonElement | undefined;
	for (const node of items) {
		const match = node.dataset.id === id;
		node.classList.toggle('is-highlighted', match);
		if (match) target = node;
	}
	if (!target) return;
	target.scrollIntoView({ block: 'nearest' });
	if (active.keyboard === 'menu' && !target.disabled) target.focus();
}
