import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseInputs, resolveCandidateManifestId } from '../src/inputs';

// NOT 'k'. `parseInputs` calls the real `core.setSecret(apiKey)` — this file
// deliberately does not mock @actions/core — and the runner then masks that
// literal everywhere for the rest of the job. A one-character value made the
// runner replace every "k" in the public log of this Marketplace Action:
// `wor***/regression-chec***`, `api-***ey`, `1250***B  dist/index.js`. The log
// a prospective adopter opens to judge whether this Action is maintained was
// unreadable. Any fixture key here must be long and improbable.
const MASKABLE_FIXTURE = 'not-a-real-credential-just-long-enough-to-mask';


describe('resolveCandidateManifestId', () => {
  let tmpDir: string;
  let originalGhOut: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decimal-action-test-'));
    originalGhOut = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
  });

  afterEach(() => {
    if (originalGhOut !== undefined) {
      process.env.GITHUB_OUTPUT = originalGhOut;
    } else {
      delete process.env.GITHUB_OUTPUT;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when nothing is set', () => {
    expect(resolveCandidateManifestId(tmpDir)).toBe('');
  });

  it('reads from $GITHUB_OUTPUT when set', () => {
    const ghOut = path.join(tmpDir, 'github_output');
    fs.writeFileSync(
      ghOut,
      'other_step=foo\ndecimal_manifest_id=mfst_xyz\nanother=bar\n',
    );
    process.env.GITHUB_OUTPUT = ghOut;
    expect(resolveCandidateManifestId(tmpDir)).toBe('mfst_xyz');
  });

  it('reads from local file when $GITHUB_OUTPUT not set', () => {
    fs.writeFileSync(path.join(tmpDir, 'decimal_manifest_id.txt'), 'mfst_local');
    expect(resolveCandidateManifestId(tmpDir)).toBe('mfst_local');
  });

  it('$GITHUB_OUTPUT takes precedence over local file', () => {
    const ghOut = path.join(tmpDir, 'github_output');
    fs.writeFileSync(ghOut, 'decimal_manifest_id=mfst_gh\n');
    fs.writeFileSync(path.join(tmpDir, 'decimal_manifest_id.txt'), 'mfst_local');
    process.env.GITHUB_OUTPUT = ghOut;
    expect(resolveCandidateManifestId(tmpDir)).toBe('mfst_gh');
  });

  it('handles malformed $GITHUB_OUTPUT (no decimal_manifest_id key) by falling through', () => {
    const ghOut = path.join(tmpDir, 'github_output');
    fs.writeFileSync(ghOut, 'other_step=foo\nyet_another=bar\n');
    fs.writeFileSync(path.join(tmpDir, 'decimal_manifest_id.txt'), 'mfst_local');
    process.env.GITHUB_OUTPUT = ghOut;
    expect(resolveCandidateManifestId(tmpDir)).toBe('mfst_local');
  });
});

describe('parseInputs — behavioral-check', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setInput(name: string, val: string) {
    const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = val;
  }

  it('defaults to off', () => {
    setInput('api-key', MASKABLE_FIXTURE);
    setInput('agent-name', 'a');
    setInput('candidate-manifest-id', 'm');
    setInput('behavioral-check', '');
    expect(parseInputs().behavioralCheck).toBe('off');
  });

  it('accepts mock / real', () => {
    setInput('api-key', MASKABLE_FIXTURE);
    setInput('agent-name', 'a');
    setInput('candidate-manifest-id', 'm');
    setInput('behavioral-check', 'real');
    expect(parseInputs().behavioralCheck).toBe('real');
  });

  it('rejects an invalid value', () => {
    setInput('api-key', MASKABLE_FIXTURE);
    setInput('agent-name', 'a');
    setInput('candidate-manifest-id', 'm');
    setInput('behavioral-check', 'bogus');
    expect(() => parseInputs()).toThrow(/behavioral-check/);
  });
});

describe('parseInputs — github-token', () => {
  let saved: Record<string, string | undefined>;
  let savedGithubToken: string | undefined;
  let savedGhToken: string | undefined;

  beforeEach(() => {
    saved = {};
    savedGithubToken = process.env.GITHUB_TOKEN;
    savedGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
  });

  function setInput(name: string, val: string) {
    const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = val;
  }

  function setBaseInputs() {
    setInput('api-key', MASKABLE_FIXTURE);
    setInput('agent-name', 'a');
    setInput('candidate-manifest-id', 'm');
  }

  it('reads the github-token input (the action.yml default path)', () => {
    setBaseInputs();
    setInput('github-token', 'ghs_from_input');
    expect(parseInputs().githubToken).toBe('ghs_from_input');
  });

  it('falls back to GITHUB_TOKEN env when the input is empty (backward-compat)', () => {
    setBaseInputs();
    setInput('github-token', '');
    process.env.GITHUB_TOKEN = 'ghs_from_env';
    expect(parseInputs().githubToken).toBe('ghs_from_env');
  });

  it('falls back to GH_TOKEN env when the input and GITHUB_TOKEN are empty', () => {
    setBaseInputs();
    setInput('github-token', '');
    process.env.GH_TOKEN = 'ghs_from_gh_token';
    expect(parseInputs().githubToken).toBe('ghs_from_gh_token');
  });

  it('prefers the input over the env fallbacks', () => {
    setBaseInputs();
    setInput('github-token', 'ghs_from_input');
    process.env.GITHUB_TOKEN = 'ghs_from_env';
    expect(parseInputs().githubToken).toBe('ghs_from_input');
  });

  it('is empty string when neither input nor env is set', () => {
    setBaseInputs();
    setInput('github-token', '');
    expect(parseInputs().githubToken).toBe('');
  });
});
