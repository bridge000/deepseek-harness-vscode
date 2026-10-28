import { describe, expect, it } from 'vitest';
import {
	IMAGE_MIME_TYPES,
	MAX_IMAGE_BYTES,
	imageMimeType,
	isImagePath,
	isUnsupportedMediaPath,
	refNameFromUri,
} from '../src/context/media';

describe('context/media 图片识别', () => {
	it('imageMimeType 识别支持的扩展名（大小写不敏感）', () => {
		expect(imageMimeType('a.PNG')).toBe('image/png');
		expect(imageMimeType('a.jpg')).toBe('image/jpeg');
		expect(imageMimeType('a.jpeg')).toBe('image/jpeg');
		expect(imageMimeType('a.webp')).toBe('image/webp');
		expect(imageMimeType('a.gif')).toBe('image/gif');
		expect(imageMimeType('C:\\shots\\a.Png')).toBe('image/png');
	});

	it('imageMimeType 忽略 query 与 hash', () => {
		expect(imageMimeType('a.png?raw=1')).toBe('image/png');
		expect(imageMimeType('a.png#fragment')).toBe('image/png');
		expect(imageMimeType('https://example.com/a.webp?v=2#x')).toBe('image/webp');
		expect(imageMimeType('file:///C:/x/a.gif?download=1')).toBe('image/gif');
	});

	it('imageMimeType 处理 file URI 与百分号编码', () => {
		expect(imageMimeType('file:///C:/x/a.jpeg')).toBe('image/jpeg');
		expect(imageMimeType('file:///C:/x/%E5%9B%BE.png')).toBe('image/png');
	});

	it('imageMimeType 对非图片返回 undefined', () => {
		expect(imageMimeType('README.md')).toBeUndefined();
		expect(imageMimeType('a')).toBeUndefined();
		expect(imageMimeType('a.png.bak')).toBeUndefined();
		expect(imageMimeType('.png')).toBe('image/png');
		expect(imageMimeType('')).toBeUndefined();
	});

	it('isImagePath 与 imageMimeType 保持一致', () => {
		expect(isImagePath('file:///C:/x/a.png')).toBe(true);
		expect(isImagePath('src/a.jpeg')).toBe(true);
		expect(isImagePath('src/a.txt')).toBe(false);
		expect(isImagePath('src/a')).toBe(false);
	});

	it('isUnsupportedMediaPath 只识别音视频扩展名', () => {
		expect(isUnsupportedMediaPath('.mp4')).toBe(true);
		expect(isUnsupportedMediaPath('clip.MP4')).toBe(true);
		expect(isUnsupportedMediaPath('file:///C:/x/a.wav?x=1')).toBe(true);
		expect(isUnsupportedMediaPath('a.png')).toBe(false);
		expect(isUnsupportedMediaPath('a.md')).toBe(false);
	});

	it('refNameFromUri 返回解码后的文件名', () => {
		expect(refNameFromUri('file:///C:/x/%E5%9B%BE.png')).toBe('图.png');
		expect(refNameFromUri('file:///C:/x/a.jpeg')).toBe('a.jpeg');
		expect(refNameFromUri('file:///C:/x/a.png?x=1#y')).toBe('a.png');
		// 非 file scheme 或无法解码时至少给出可读名字。
		expect(refNameFromUri('untitled:Untitled-1')).toBe('untitled:Untitled-1');
	});

	it('MAX_IMAGE_BYTES 为正数且对应 5MB', () => {
		expect(MAX_IMAGE_BYTES).toBeGreaterThan(0);
		expect(IMAGE_MIME_TYPES['.png']).toBe('image/png');
		expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
	});
});
