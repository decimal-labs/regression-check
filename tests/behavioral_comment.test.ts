import { describe, it, expect } from 'vitest';
import { formatComment } from '../src/comment';
import { CallReplayResult } from '../src/api';

const report: any = {
  id: 'rc_1',
  agent_name: 'support-agent',
  baseline_manifest_id: 'm1',
  candidate_manifest_id: 'm2',
  status: 'completed',
  verdict: 'medium_risk',
  verdict_message: 'review',
  total_traces_analyzed: 12,
  high_risk_count: 0,
  medium_risk_count: 12,
  low_risk_count: 0,
  pr_context: null,
  created_at: '2026-06-05T00:00:00Z',
  diff_summary: {
    total_changes: 1,
    changes: [
      {
        type: 'model_changed',
        name: null,
        severity: 'medium',
        detail: {
          grade: 'moderate',
          change_kind: 'version_bump',
          old_model: 'gpt-4o',
          new_model: 'gpt-4o-mini',
        },
      },
    ],
  },
  impacts: [],
};

function cr(over: Partial<CallReplayResult>): CallReplayResult {
  return {
    status: 'ok',
    message: null,
    provider: 'openai',
    target_model: 'gpt-4o-mini',
    baseline_model: 'gpt-4o',
    per_trace: 'first',
    mode: 'real',
    summary: { replayed: 5, equivalent: 3, changed: 2, errors: 0, samples: [] },
    ...over,
  } as CallReplayResult;
}

describe('behavioral verification block in PR comment', () => {
  it('ok real run with judge: counts + judge line + swap, no mock tag', () => {
    const r = cr({
      summary: {
        replayed: 5,
        equivalent: 3,
        changed: 2,
        errors: 0,
        samples: [],
        judge: { worse: 1, equivalent: 1 },
      },
    });
    const out = formatComment(report, 'https://api.decimal.ai', r);
    expect(out).toContain('**Behavioral verification**');
    expect(out).toContain('gpt-4o → gpt-4o-mini');
    expect(out).toContain('re-issued 5 recorded calls');
    expect(out).toContain('3 equivalent');
    expect(out).toContain('**2 changed**');
    expect(out).toContain('Judge: 1 worse · 1 equivalent');
    expect(out).not.toContain('(mock preview)');
  });

  it('mock run renders honest eligible-count, no fabricated changed-count', () => {
    const out = formatComment(report, 'https://api.decimal.ai', cr({ mode: 'mock' }));
    expect(out).toContain('Behavioral verification');
    expect(out).toContain('eligible for replay');
    expect(out).toContain('mock — not verified');
    expect(out).toContain('Add `behavioral-check: real`');
    // honest: no fabricated equivalent/changed split, no "re-issued" result line
    expect(out).not.toContain('equivalent');
    expect(out).not.toContain('re-issued');
  });

  it('unsupported: one-liner with the message, no counts', () => {
    const out = formatComment(
      report,
      'https://api.decimal.ai',
      cr({
        status: 'unsupported',
        summary: null,
        message: "Cross-provider swaps aren't supported yet — same-provider MVP.",
      }),
    );
    expect(out).toContain('**Behavioral verification** — Cross-provider');
    expect(out).not.toContain('replayed');
  });

  it('no_model_change: block is silent', () => {
    const out = formatComment(
      report,
      'https://api.decimal.ai',
      cr({ status: 'no_model_change', summary: null, message: 'no model change' }),
    );
    expect(out).not.toContain('Behavioral verification');
  });

  it('no callReplay + model change: honest nudge, no fabricated counts', () => {
    const out = formatComment(report, 'https://api.decimal.ai');
    expect(out).toContain('**Behavioral verification** — model change detected');
    expect(out).toContain('12 recorded calls can be replayed');
    expect(out).toContain('Add `behavioral-check: real`');
    expect(out).toContain('post-deploy bisect');
    // honest: only the nudge renders — no fabricated behavioral *result*.
    // "re-issued … N changed" is the mock/real result line; the nudge never
    // emits it (mock would always read "100% changed").
    expect(out).not.toContain('re-issued');
    expect(out).not.toContain('(mock preview)');
  });

  it('no callReplay + no model change: behavioral block stays absent', () => {
    const noModel = {
      ...report,
      diff_summary: {
        total_changes: 1,
        changes: [{ type: 'tool_removed', name: 'refund', severity: 'high', detail: {} }],
      },
    };
    const out = formatComment(noModel, 'https://api.decimal.ai');
    expect(out).not.toContain('Behavioral verification');
  });
});
