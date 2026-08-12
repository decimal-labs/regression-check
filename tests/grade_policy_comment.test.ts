import { describe, it, expect } from 'vitest';
import { formatComment } from '../src/comment';

const base: any = {
  id: 'rc_1',
  agent_name: 'support-agent',
  baseline_manifest_id: 'm1',
  candidate_manifest_id: 'm2',
  status: 'completed',
  verdict_message: 'review',
  total_traces_analyzed: 2002,
  pr_context: null,
  created_at: '2026-06-02T00:00:00Z',
};

function modelSwap(): any {
  return {
    ...base,
    verdict: 'high_risk',
    high_risk_count: 2002,
    medium_risk_count: 0,
    low_risk_count: 0,
    diff_summary: {
      total_changes: 1,
      changes: [
        {
          type: 'model_changed',
          name: null,
          severity: 'high',
          detail: {
            grade: 'major',
            change_kind: 'provider_change',
            old_model: 'gpt-4o',
            new_model: 'claude-3-5-sonnet',
            policy: { name: 'default', disposition: 'drop', implies: 'block' },
          },
        },
      ],
    },
    impacts: [
      {
        id: 'i1',
        surface_change_type: 'model_changed',
        surface_name: null,
        severity: 'high',
        affected_trace_count: 2002,
        sample_trace_ids: null,
        explanation: 'Model provider change — major.',
      },
    ],
  };
}

describe('graded comment + training-data policy block', () => {
  it('model swap: grade inline, HIGH gate, separate policy block, superset preserved', () => {
    const out = formatComment(modelSwap(), 'https://api.decimal.ai');
    // grade inline on the change line
    expect(out).toContain('**major** (provider change)');
    expect(out).toContain('gpt-4o → claude-3-5-sonnet');
    // the gate (unchanged)
    expect(out).toContain('HIGH IMPACT');
    // the separate, labeled training-data block
    expect(out).toContain('**Training-data policy** (`default`)');
    expect(out).toContain('→ **drop**');
    expect(out).toContain('excluded from training');
    // superset: existing sections all still present
    expect(out).toContain('**Manifest changes:**');
    expect(out).toContain('Impact on last 2,002 production traces');
    expect(out).toContain('View full report');
  });

  it('prompt rewrite: MEDIUM gate (warns, no block), replay disposition', () => {
    const r = modelSwap();
    r.verdict = 'medium_risk';
    r.high_risk_count = 0;
    r.medium_risk_count = 2002;
    r.diff_summary.changes = [
      {
        type: 'prompt_section_rewritten',
        name: 'system',
        severity: 'medium',
        detail: {
          grade: 'major',
          diff_pct: 67.0,
          policy: { name: 'default', disposition: 'replay', implies: 'warn' },
        },
      },
    ];
    r.impacts = [];
    const out = formatComment(r, 'https://api.decimal.ai');
    expect(out).toContain('**major** (67% changed)');
    expect(out).toContain('MEDIUM IMPACT');
    expect(out).toContain('→ **replay**');
    expect(out).toContain('need re-running first');
  });

  it('old backend (no grade/policy detail): comment unchanged — no block, no grade suffix', () => {
    const r = modelSwap();
    r.verdict = 'medium_risk';
    r.high_risk_count = 0;
    r.medium_risk_count = 2002;
    r.diff_summary.changes = [{ type: 'model_changed', name: null, severity: 'medium' }];
    r.impacts = [];
    const out = formatComment(r, 'https://api.decimal.ai');
    expect(out).not.toContain('Training-data policy');
    expect(out).not.toContain('major');
    expect(out).toContain('Model changed'); // base label still present
  });
});
