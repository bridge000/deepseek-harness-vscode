/**
 * Markdown 渲染（侧边栏聊天专用）：marked 解析 + DOMPurify 按白名单清洗。
 *
 * 模型输出一律视为不可信内容：原始 HTML、脚本、内联样式、外链锚点都在这里被
 * 剥掉，因此返回值可以安全地写进 `innerHTML`。外链不渲染成可点击元素（侧边栏
 * 里打开网页没有意义），需要跳转时请用工具卡片/findings 的 openFile。
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: true });

/** 只保留 Markdown 会产出的语义标签，`a`/`img` 之外的原始 HTML 一律丢弃。 */
const ALLOWED_TAGS = [
	'p',
	'br',
	'hr',
	'strong',
	'em',
	'del',
	'code',
	'pre',
	'blockquote',
	'ul',
	'ol',
	'li',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'img',
];

/** 只允许 Markdown 自己写得出来的属性；`class` 供语法高亮/样式命名使用。 */
const ALLOWED_ATTR = ['class', 'title', 'alt', 'src', 'start', 'colspan', 'rowspan'];

/** HTML 转义，用于兜底（渲染失败时按纯文本展示）以及按文本拼 DOM 的场景。 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 把一段 Markdown 渲染成可安全写入 DOM 的 HTML。
 * 空输入返回空串；解析/清洗异常时退化为转义后的纯文本。
 */
export function renderMarkdown(source: string): string {
	const text = typeof source === 'string' ? source : '';
	if (!text.trim()) return '';
	let html: string;
	try {
		html = marked.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
	try {
		return DOMPurify.sanitize(html, {
			ALLOWED_TAGS,
			ALLOWED_ATTR,
			// 外链锚点不渲染：点击会试图导航整个 webview，侧边栏不提供该能力。
			FORBID_TAGS: ['a', 'style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'svg', 'math'],
			FORBID_ATTR: ['style', 'srcset', 'href', 'onerror', 'onload', 'onclick'],
			ALLOW_DATA_ATTR: false,
			KEEP_CONTENT: true,
		});
	} catch {
		return escapeHtml(text);
	}
}
