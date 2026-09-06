/**
 * The self-check must never red the job because DecimalAI was unreachable.
 *
 * The step that resolves a candidate manifest runs before the Action does, so
 * the Action's own `on-error: warn` cannot protect it. As first merged it ran
 * `curl -sf` under `set -e`, which exits non-zero on any 5xx, 429 or network
 * error — a DecimalAI blip turned a red X onto a pull request that had nothing
 * to do with DecimalAI. The workflow's own header says a self-check that does
 * that is one people learn to ignore.
 *
 * This extracts the real step body out of the real workflow file and runs it
 * against a stub `curl`, so it grades the shipped script rather than a copy.
 * Deleting the `|| RESP=''` guard turns the first case red.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'self-check.yml');

/** Placeholder handed to the stub curl. Nothing here ever reaches a network. */
const STUB_CREDENTIAL = ['stub', 'value', 'not', 'real'].join('-');

/** Pull one step's `run:` block out of the workflow, dedented. */
function stepBody(stepName: string): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (at < 0) throw new Error(`step not found: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  if (runAt < 0) throw new Error(`no run block under: ${stepName}`);
  const indent = lines[runAt].search(/\S/) + 2;
  const out: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    out.push(line.slice(indent));
  }
  return out.join('\n');
}

/** Run the step with a stub curl that returns `body` and exits `code`. */
function runStep(body: string, code: number, payload: string) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'curl');
  writeFileSync(stub, `#!/bin/bash\ncat <<'PAYLOAD'\n${payload}\nPAYLOAD\nexit ${code}\n`);
  chmodSync(stub, 0o755);

  const script = join(dir, 'step.sh');
  writeFileSync(script, body);
  const ghOutput = join(dir, 'gh_output');
  writeFileSync(ghOutput, '');

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: ghOutput,
        DECIMAL_API_KEY: STUB_CREDENTIAL,
        AGENT_NAME: '[Demo] support-agent',
      },
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = String(e.stdout ?? '');
  }
  return { status, stdout, outputs: readFileSync(ghOutput, 'utf8') };
}

describe('self-check: resolving a manifest never fails the job', () => {
  const body = stepBody('Resolve a candidate manifest');

  it('an API outage is a skip, not a failure', () => {
    // curl -f exits 22 on any HTTP >= 400 — 500, 502, and the 429 the docs
    // call out as the plan's monthly regression-check quota.
    const r = runStep(body, 22, '');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('found=false');
    expect(r.outputs).not.toContain('id=');
    expect(r.stdout).toContain('::warning::');
  });

  it('an unparseable body is a skip, not a failure', () => {
    const r = runStep(body, 0, 'not json at all');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('found=false');
  });

  it('an agent with no manifests is a skip, not a failure', () => {
    const r = runStep(body, 0, '{"manifests":[]}');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('found=false');
  });

  it('resolves the newest manifest id when the API answers', () => {
    const r = runStep(body, 0, '{"manifests":[{"id":"abc-123"},{"id":"older"}]}');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('found=true');
    expect(r.outputs).toContain('id=abc-123');
  });
});

describe('self-check: the key is never pasted into a script body', () => {
  it('every secrets.* reference sits on an env: or with: line', () => {
    // `${{ }}` is substituted into the shell text before bash parses it, so a
    // secret in a run: body has to be shell-safe for the script to even parse.
    const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
    const offenders = lines.filter(
      (l) => l.includes('secrets.') && !/^\s*[\w-]+:\s*\$\{\{\s*secrets\./.test(l),
    );
    expect(offenders).toEqual([]);
  });

  it('asks the API to filter by agent instead of paging the org', () => {
    // The endpoint defaults to 20 rows and orders newest-first. Filtering
    // client-side finds nothing once 20 newer manifests exist in the org — and
    // reports that as a green run.
    const text = readFileSync(WORKFLOW, 'utf8');
    expect(text).toContain('agent_name=${AGENT_NAME}');
    expect(text).toContain('limit=1');
  });
});
