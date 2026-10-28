/**
 * Guard for the official brand artwork extracted from
 * `@deepseek-ai/dsh-client-ui-primitives` (fish logo + BrandWordmark).
 *
 * These are long single-line path strings; a truncated extraction would still
 * type-check, so the test asserts shape/length instead of exact data.
 */
import { describe, expect, it } from 'vitest';
import {
	FISH_LOGO_PATH,
	FISH_LOGO_VIEWBOX,
	WORDMARK_BADGE,
	WORDMARK_BADGE_CLIP,
	WORDMARK_BADGE_LETTERS,
	WORDMARK_LETTERS,
	WORDMARK_TEXT_VIEWBOX,
	WORDMARK_VIEWBOX,
} from '../src/webview/brand';

describe('brand artwork', () => {
	it('鲸鱼路径完整且比例正确', () => {
		expect(FISH_LOGO_PATH.startsWith('M')).toBe(true);
		expect(FISH_LOGO_PATH.length).toBeGreaterThan(3000);
		expect(FISH_LOGO_PATH).not.toContain('\n');
		expect(FISH_LOGO_VIEWBOX.width / FISH_LOGO_VIEWBOX.height).toBeCloseTo(23.16 / 17.04, 6);
	});

	it('wordmark 包含 deepseek 九个字形与 HARNESS 七个字形', () => {
		expect(WORDMARK_LETTERS).toHaveLength(9);
		expect(WORDMARK_BADGE_LETTERS).toHaveLength(7);
		for (const path of [...WORDMARK_LETTERS, ...WORDMARK_BADGE_LETTERS]) {
			expect(path.startsWith('M')).toBe(true);
			expect(path).not.toContain('\n');
		}
	});

	it('只显示文字的裁剪 viewBox 与徽标尺寸', () => {
		expect(WORDMARK_VIEWBOX).toBe('0 0 182 24');
		expect(WORDMARK_TEXT_VIEWBOX).toBe('26 0 156 24');
		expect(WORDMARK_BADGE.x).toBeCloseTo(129.348, 3);
		expect(WORDMARK_BADGE.width).toBe(52);
		expect(WORDMARK_BADGE_CLIP.translateX).toBeCloseTo(132.348, 3);
	});
});
