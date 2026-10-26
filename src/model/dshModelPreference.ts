/**
 * Read the user's DSH default model without pulling in a YAML dependency.
 *
 * A DSH profile is a stack of layers; the user patch file
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` is a small YAML subset:
 *
 * ```yaml
 * - id: agent-default-model
 *   name: "@deepseek-ai/dsh-agent-default-model"
 *   config:
 *     provider: deepseek-official
 *     model: deepseek-flash
 * ```
 *
 * Only the `agent-default-model` entry's `config.provider` / `config.model` are
 * needed, so this module parses that block line by line (quotes, trailing
 * comments and CRLF tolerated) instead of adding a parser. Anything unexpected
 * degrades to `undefined`, which lets the extension keep the ACP reported
 * default instead of guessing.
 *
 * This module is vscode-free so it can be unit tested with vitest.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelRef } from './legacyModels';

/** Profile patch files consulted in priority order (web wins over desktop). */
export const DSH_PROFILE_PREFERENCE_FILES: readonly string[] = [
	'profiles/web/cordis.patch.yml',
	'profiles/desktop/cordis.patch.yml',
];

/** Loader entry id that stores the user's default model. */
export const AGENT_DEFAULT_MODEL_ID = 'agent-default-model';

/** `$DSH_HOME` when set, otherwise `~/.dsh`. */
export function defaultDshHome(): string {
	const fromEnv = (process.env.DSH_HOME ?? '').trim();
	return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

/** Strip a trailing YAML comment, leaving `#` inside quoted scalars alone. */
function stripComment(line: string): string {
	let quote: string | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
	}
	return line;
}

function countIndent(line: string): number {
	let indent = 0;
	while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) indent += 1;
	return indent;
}

function parseKeyValue(text: string): { key: string; value: string } | undefined {
	const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(text);
	if (!match) return undefined;
	return { key: match[1], value: match[2] };
}

/** Read a scalar from the text after `key:` (quoted or plain). */
function readScalarValue(raw: string): string | undefined {
	const text = stripComment(raw).trim();
	if (text.length === 0) return undefined;
	const quote = text[0];
	if (quote === '"' || quote === "'") {
		const end = text.indexOf(quote, 1);
		return end > 1 ? text.slice(1, end) : undefined;
	}
	return text;
}

/**
 * Parse one `cordis.patch.yml` text and return the default model, if any.
 *
 * The parser is intentionally narrow: it finds the top-level
 * `- id: agent-default-model` entry, then the keys directly below its
 * `config:` block, and stops when that block ends. Later entries, comments and
 * unrelated provider/model pairs are ignored.
 */
export function parseAgentDefaultModelPatch(text: string): ModelRef | undefined {
	let inTarget = false;
	let configIndent: number | undefined;
	let provider: string | undefined;
	let model: string | undefined;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripComment(rawLine).trimEnd();
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const indent = countIndent(line);

		if (indent === 0 && trimmed.startsWith('-')) {
			if (inTarget) break; // Next top-level entry: this target block ended.
			const entry = parseKeyValue(trimmed.replace(/^-\s*/, ''));
			if (entry && entry.key === 'id' && readScalarValue(entry.value) === AGENT_DEFAULT_MODEL_ID) {
				inTarget = true;
			}
			continue;
		}
		if (!inTarget) continue;

		const entry = parseKeyValue(trimmed);
		if (!entry) continue;
		if (configIndent === undefined) {
			if (entry.key === 'config' && entry.value.trim().length === 0) configIndent = indent;
			continue;
		}
		if (indent <= configIndent) break; // Back to a sibling of `config:`.
		if (entry.key === 'provider' && provider === undefined) {
			provider = readScalarValue(entry.value);
		} else if (entry.key === 'model' && model === undefined) {
			model = readScalarValue(entry.value);
		}
	}

	if (!provider || !model) return undefined;
	return { provider, model };
}

/** Parse one patch file; missing/unreadable files return `undefined`. */
export function readPreferredModelFromPatchFile(filePath: string): ModelRef | undefined {
	let text: string;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
	return parseAgentDefaultModelPatch(text);
}

/**
 * Resolve the user's default model from DSH settings.
 *
 * @param dshHome DSH home directory; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns `undefined` when no profile declares `agent-default-model`.
 */
export function readDshPreferredModel(dshHome?: string): ModelRef | undefined {
	const trimmed = (dshHome ?? '').trim();
	const home = trimmed.length > 0 ? trimmed : defaultDshHome();
	for (const relative of DSH_PROFILE_PREFERENCE_FILES) {
		const ref = readPreferredModelFromPatchFile(join(home, relative));
		if (ref) return ref;
	}
	return undefined;
}
