/**
 * The CI gate must not return a false green — and must not go red for the
 * wrong reason. Two invariants this suite locks down:
 *
 *  1. `unverified` — a manifest change with no production traces in the window
 *     to measure it against — must not exit 0 the way `no_change` does, and
 *     must not render "✅ safe to merge" above a "🔴 Tool removed" bullet.
 *  2. A failure to RUN the check (quota 429, backend 5xx, network error,
 *     timeout) must not red the customer's job under the default
 *     `on-error: warn`. A transient failure must be classified BEFORE
 *     `shouldFail` runs, so that `on-error: warn` and `fail-on: none` both
 *     keep the check advisory.
 *
 * The tests for (2) drive `main()` end-to-end rather than the pure classifier,
 * because the invariant lives in the WIRING: `isTransientApiFailure` passing
 * on its own does not prove the error path consults it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the vi.mock factories below (which vitest lifts to the top of the
// file) can see them. The Action's entry point calls core.setFailed / getInput
// at module scope, so the mocks have to be in place before `../src/index` is
// ever imported.
const h = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: new Map<string, string>(),
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: (name: string) => h.inputs[name] ?? '',
  setSecret: vi.fn(),
  info: vi.fn(),
  warning: h.warning,
  setFailed: h.setFailed,
  setOutput: (k: string, v: string) => h.outputs.set(k, v),
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'acme', repo: 'agents' },
    sha: 'deadbeef',
  },
  getOctokit: vi.fn(),
}));

import { formatComment, formatUnavailableComment } from '../src/comment';
import {
  ApiHttpError,
  isTransientApiFailure,
  runRegressionCheck,
  RegressionCheckResponse,
} from '../src/api';

const MARKER = '<!-- decimalai-regression-check-comment -->';

function makeUnverifiedReport(
  overrides: Partial<RegressionCheckResponse> = {},
): RegressionCheckResponse {
  return {
    id: 'rc_unverified',
    agent_name: 'support-agent',
    baseline_manifest_id: 'mfst_baseline',
    candidate_manifest_id: 'mfst_candidate',
    status: 'completed',
    verdict: 'unverified',
    verdict_message:
      '2 structural changes (high-severity) with no production traces in the ' +
      'last 30 days to measure blast radius. This change was NOT verified.',
    structural_severity: 'high',
    high_risk_count: 0,
    medium_risk_count: 0,
    low_risk_count: 0,
    total_traces_analyzed: 0,
    diff_summary: {
      total_changes: 2,
      high_severity_changes: 1,
      medium_severity_changes: 1,
      low_severity_changes: 0,
      changes: [
        { type: 'tool_removed', name: 'compare_competitors', severity: 'high' },
        { type: 'model_changed', name: 'gpt-4o', severity: 'medium' },
      ],
    },
    pr_context: null,
    impacts: [],
    created_at: '2026-07-28T12:00:00Z',
    eval_verdict: 'clean',
    ...overrides,
  };
}

// ── (a) gating ────────────────────────────────────────────────────

describe('shouldFail on the unverified verdict', () => {
  it('fails at the DEFAULT fail-on when the diff has a high-severity change', async () => {
    // A PR that deletes a tool on an agent with no traffic: `unverified` must
    // inherit the diff severity, not be treated as `no_change`.
    const { shouldFail } = await import('../src/index');
    expect(shouldFail('unverified', 'high', 'high')).toBe(true);
    expect(shouldFail('unverified', 'medium', 'high')).toBe(true);
  });

  it('only warns at fail-on: high when the diff is medium severity', async () => {
    const { shouldFail } = await import('../src/index');
    expect(shouldFail('unverified', 'high', 'medium')).toBe(false);
    expect(shouldFail('unverified', 'medium', 'medium')).toBe(true);
  });

  it('never fails at fail-on: none — the documented escape hatch still works', async () => {
    const { shouldFail } = await import('../src/index');
    expect(shouldFail('unverified', 'none', 'high')).toBe(false);
  });

  it('falls back to low severity when the backend predates the field', async () => {
    // Never invent a failure the server never claimed.
    const { shouldFail } = await import('../src/index');
    expect(shouldFail('unverified', 'high', undefined)).toBe(false);
    expect(shouldFail('unverified', 'medium', null)).toBe(false);
  });

  it('leaves no_change and first_run exactly as they were', async () => {
    const { shouldFail } = await import('../src/index');
    expect(shouldFail('no_change', 'high')).toBe(false);
    expect(shouldFail('no_change', 'medium')).toBe(false);
    expect(shouldFail('first_run', 'medium')).toBe(false);
  });
});

describe('the unverified PR comment', () => {
  const md = () => formatComment(makeUnverifiedReport(), 'https://api.decimal.ai');

  it('never says safe to merge', () => {
    expect(md().toLowerCase()).not.toContain('safe to merge');
  });

  it('does not render the ✅ NO CHANGE header', () => {
    expect(md()).not.toContain('**NO CHANGE**');
    expect(md()).toContain('**UNVERIFIED**');
  });

  it('still lists the changes that were not verified', () => {
    expect(md()).toContain('Tool removed');
    expect(md()).toContain('compare_competitors');
  });

  it('says why there is no verdict and how to get one', () => {
    const body = md();
    expect(body).toContain('Impact: not measured.');
    expect(body).toContain('decimalai.init()');
    expect(body).toContain('trace-window-days');
  });

  it('suppresses the eval verdict, which reads ✅ CLEAN on zero traces', () => {
    // Rendering "✅ CLEAN — no passing-eval traffic affected" under an
    // UNVERIFIED header would contradict the header itself.
    expect(md()).not.toContain('**CLEAN**');
  });

  it('keeps the marker so it replaces the previous comment in update mode', () => {
    expect(md()).toContain(MARKER);
  });
});

// ── (c) fail-open on availability problems ────────────────────────

describe('isTransientApiFailure', () => {
  it('treats quota/rate-limit and server faults as transient', () => {
    expect(isTransientApiFailure(new ApiHttpError(429, '{}', 'quota'))).toBe(true);
    expect(isTransientApiFailure(new ApiHttpError(500, '{}', 'boom'))).toBe(true);
    expect(isTransientApiFailure(new ApiHttpError(503, '{}', 'boom'))).toBe(true);
  });

  it('treats network errors and timeouts as transient', () => {
    expect(isTransientApiFailure(new Error('fetch failed'))).toBe(true);
    expect(isTransientApiFailure(new Error('timed out after 60000 ms'))).toBe(true);
  });

  it('keeps misconfiguration fatal — it must stay loud', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isTransientApiFailure(new ApiHttpError(status, '{}', 'nope'))).toBe(false);
    }
  });
});

describe('runRegressionCheck error shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a typed ApiHttpError carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":"nope"}', { status: 503 })),
    );
    await expect(
      runRegressionCheck({
        baseUrl: 'https://api.decimal.ai',
        apiKey: 'k',
        agentName: 'a',
        candidateManifestId: 'm',
        traceWindowDays: 30,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('turns a quota 429 into a one-line, actionable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: {
                error: 'limit_exceeded',
                feature: 'regression_checks',
                used: 50,
                limit: 50,
                plan: 'free',
                upgrade_url: 'https://app.decimal.ai/settings/billing',
              },
            }),
            { status: 429 },
          ),
      ),
    );
    const err: ApiHttpError = await runRegressionCheck({
      baseUrl: 'https://api.decimal.ai',
      apiKey: 'k',
      agentName: 'a',
      candidateManifestId: 'm',
      traceWindowDays: 30,
    }).then(
      () => {
        throw new Error('expected a 429 to reject');
      },
      (e) => e as ApiHttpError,
    );
    expect(err.status).toBe(429);
    expect(err.message).toContain('Monthly quota reached');
    expect(err.message).toContain('https://app.decimal.ai/settings/billing');
    // Never dump the raw JSON error body into the comment.
    expect(err.message).not.toContain('limit_exceeded');
  });
});

describe('the job outcome when the check cannot run', () => {
  const { setFailed, warning, outputs } = h;

  beforeEach(() => {
    setFailed.mockClear();
    warning.mockClear();
    outputs.clear();
    // Fresh module registry per test — `../src/index` runs main() on import.
    vi.resetModules();
    for (const k of Object.keys(h.inputs)) delete h.inputs[k];
    Object.assign(h.inputs, {
      'api-key': 'dai_sk_test',
      'agent-name': 'support-agent',
      'candidate-manifest-id': 'mfst_candidate',
      'base-url': 'https://api.decimal.ai',
      'github-token': '', // no comment step
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runMain() {
    const mod = await import('../src/index');
    await mod._completed;
  }

  it('a quota 429 does NOT fail the job under the default on-error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":{"limit":50}}', { status: 429 })),
    );
    await runMain();
    expect(setFailed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(outputs.get('verdict')).toBe('unavailable');
  });

  it('a backend 500 does NOT fail the job under the default on-error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    await runMain();
    expect(setFailed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
  });

  it('a network error does NOT fail the job under the default on-error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await runMain();
    expect(setFailed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
  });

  it('a 401 DOES fail the job — a bad API key must stay loud', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":"bad key"}', { status: 401 })),
    );
    await runMain();
    expect(setFailed).toHaveBeenCalled();
  });

  it('on-error: fail restores the blocking behaviour on a 429', async () => {
    h.inputs['on-error'] = 'fail';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":{"limit":50}}', { status: 429 })),
    );
    await runMain();
    expect(setFailed).toHaveBeenCalled();
  });
});

describe('the degraded PR comment', () => {
  const body = formatUnavailableComment('support-agent', 'Monthly quota reached');

  it('replaces the previous verdict rather than leaving a stale green', () => {
    expect(body).toContain(MARKER);
  });

  it('never implies the change is safe', () => {
    expect(body.toLowerCase()).not.toContain('safe to merge');
    expect(body).toContain('CHECK DID NOT RUN');
    expect(body).toContain('Monthly quota reached');
  });
});
