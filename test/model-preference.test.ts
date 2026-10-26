import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	parseAgentDefaultModelPatch,
	readDshPreferredModel,
	readPreferredModelFromPatchFile,
} from '../src/model/dshModelPreference';

const created: string[] = [];

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-model-pref-'));
	created.push(dir);
	return dir;
}

function writePatch(home: string, profile: string, text: string): void {
	const dir = join(home, 'profiles', profile);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'cordis.patch.yml'), text, 'utf8');
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Mirrors the real `~/.dsh/profiles/web/cordis.patch.yml` shape. */
const WEB_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: "deepseek-official"
    model: 'deepseek-flash' # keep in sync with the DSH default
    reasoningEffort: high

# dsh-vscode-bridge: begin
- insert:
    - id: dsh-vscode-bridge
      name: dsh-vscode-bridge
# dsh-vscode-bridge: end
`;

const DESKTOP_PATCH = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-v4-pro
`;

describe('parseAgentDefaultModelPatch', () => {
	it('reads provider/model from the agent-default-model config block', () => {
		expect(parseAgentDefaultModelPatch(WEB_PATCH)).toEqual({
			provider: 'deepseek-official',
			model: 'deepseek-flash',
		});
	});

	it('ignores decoy config blocks before the target entry', () => {
		const text = `- id: some-other-agent
  config:
    provider: deepseek-account
    model: deepseek-v4-pro
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
`;
		expect(parseAgentDefaultModelPatch(text)).toEqual({
			provider: 'deepseek-official',
			model: 'deepseek-flash',
		});
	});

	it('handles CRLF files', () => {
		const text = [
			'- id: agent-default-model',
			'  config:',
			'    provider: deepseek-official',
			'    model: deepseek-flash',
		].join('\r\n');
		expect(parseAgentDefaultModelPatch(text)).toEqual({
			provider: 'deepseek-official',
			model: 'deepseek-flash',
		});
	});

	it('stops at the end of the config block', () => {
		const text = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
  enabled: true
- id: after-target
  config:
    provider: deepseek-account
    model: deepseek-v4-pro
`;
		expect(parseAgentDefaultModelPatch(text)).toEqual({
			provider: 'deepseek-official',
			model: 'deepseek-flash',
		});
	});

	it('ignores provider/model keys outside the target entry', () => {
		const text = `- id: unrelated
  config:
    provider: deepseek-account
    model: deepseek-v4-pro
`;
		expect(parseAgentDefaultModelPatch(text)).toBeUndefined();
	});

	it('returns undefined when a required field is missing', () => {
		expect(parseAgentDefaultModelPatch('- id: agent-default-model\n  config:\n    model: deepseek-flash\n')).toBeUndefined();
		expect(
			parseAgentDefaultModelPatch('- id: agent-default-model\n  config:\n    provider: deepseek-official\n'),
		).toBeUndefined();
		expect(parseAgentDefaultModelPatch('- id: agent-default-model\n  name: x\n')).toBeUndefined();
		expect(parseAgentDefaultModelPatch('')).toBeUndefined();
		expect(parseAgentDefaultModelPatch('not: yaml: at: all')).toBeUndefined();
	});

	it('returns undefined for an empty or commented out config block', () => {
		const text = `- id: agent-default-model
  config:
- id: next
`;
		expect(parseAgentDefaultModelPatch(text)).toBeUndefined();
	});
});

describe('readDshPreferredModel', () => {
	it('prefers the web profile over the desktop profile', () => {
		const home = tempHome();
		writePatch(home, 'web', WEB_PATCH);
		writePatch(home, 'desktop', DESKTOP_PATCH);
		expect(readDshPreferredModel(home)).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
	});

	it('falls back to the desktop profile when web is missing', () => {
		const home = tempHome();
		writePatch(home, 'desktop', DESKTOP_PATCH);
		expect(readDshPreferredModel(home)).toEqual({ provider: 'deepseek-account', model: 'deepseek-v4-pro' });
	});

	it('falls back to desktop when the web patch has no agent-default-model entry', () => {
		const home = tempHome();
		writePatch(home, 'web', '- id: ui-theme\n  config:\n    fontSize: 17\n');
		writePatch(home, 'desktop', DESKTOP_PATCH);
		expect(readDshPreferredModel(home)).toEqual({ provider: 'deepseek-account', model: 'deepseek-v4-pro' });
	});

	it('returns undefined when no profile patch exists', () => {
		const home = tempHome();
		expect(readDshPreferredModel(home)).toBeUndefined();
	});

	it('returns undefined for unreadable or missing patch files', () => {
		const home = tempHome();
		expect(readPreferredModelFromPatchFile(join(home, 'profiles', 'web', 'cordis.patch.yml'))).toBeUndefined();
		expect(readPreferredModelFromPatchFile('')).toBeUndefined();
	});

	it('uses $DSH_HOME when no directory is passed', () => {
		const home = tempHome();
		writePatch(home, 'web', WEB_PATCH);
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			expect(readDshPreferredModel()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previous;
		}
	});

	it('tolerates malformed YAML instead of throwing', () => {
		const home = tempHome();
		writePatch(
			home,
			'web',
			`- id: agent-default-model
  config:
    provider: "unterminated
    model: deepseek-flash
`,
		);
		// Unterminated quotes are not guessed at: the preference is ignored.
		expect(readDshPreferredModel(home)).toBeUndefined();
	});
});
