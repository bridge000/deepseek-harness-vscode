/**
 * Image / media attachment helpers shared by the extension host, the prompt
 * builder and the webview. Pure module: no `vscode`, no `node:fs`, no DOM.
 *
 * ACP image prompts accept PNG / JPEG / WebP / GIF raster data; audio and video
 * are outside the advertised capability, so they are recognised only to show a
 * clear "unsupported" hint instead of silently attaching a useless link.
 */

/** Hard cap for one embedded image (raw bytes before base64). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Supported raster image extension → ACP `mimeType`. */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

/** Media the ACP client cannot send as prompt content (only images are supported). */
export const UNSUPPORTED_MEDIA_EXTENSIONS: readonly string[] = [
	'.mp3',
	'.wav',
	'.m4a',
	'.ogg',
	'.flac',
	'.mp4',
	'.mov',
	'.avi',
	'.mkv',
	'.webm',
	'.m4v',
];

/** Lower-case extension including the dot; tolerates URIs, query strings and hashes. */
function extensionOf(pathOrUri: string): string {
	if (typeof pathOrUri !== 'string') return '';
	const withoutQuery = pathOrUri.split(/[?#]/, 1)[0] ?? '';
	const lastSeparator = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
	const name = lastSeparator >= 0 ? withoutQuery.slice(lastSeparator + 1) : withoutQuery;
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** MIME type for a supported image path/URI, or `undefined` for anything else. */
export function imageMimeType(pathOrUri: string): string | undefined {
	if (typeof pathOrUri !== 'string') return undefined;
	return IMAGE_MIME_TYPES[extensionOf(pathOrUri)];
}

/** Whether the path/URI points at a supported raster image. */
export function isImagePath(pathOrUri: string): boolean {
	return imageMimeType(pathOrUri) !== undefined;
}

/** Whether the path/URI is audio/video (recognised, but unsupported as prompt content). */
export function isUnsupportedMediaPath(pathOrUri: string): boolean {
	if (typeof pathOrUri !== 'string') return false;
	return UNSUPPORTED_MEDIA_EXTENSIONS.includes(extensionOf(pathOrUri));
}

/**
 * Display name for a `file:` URI: decoded basename, falling back to the raw URI
 * when it cannot be decoded (e.g. a non-file scheme).
 */
export function refNameFromUri(uri: string): string {
	if (typeof uri !== 'string' || uri.length === 0) return uri;
	const clean = uri.split(/[?#]/, 1)[0] ?? uri;
	const lastSeparator = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
	const name = lastSeparator >= 0 ? clean.slice(lastSeparator + 1) : clean;
	try {
		return decodeURIComponent(name) || uri;
	} catch {
		return name || uri;
	}
}
