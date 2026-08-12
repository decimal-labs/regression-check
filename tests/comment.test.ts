import { describe, it, expect } from 'vitest';
import { formatComment } from '../src/comment';
import { RegressionCheckResponse } from '../src/api';

function makeReport(
  overrides: Partial<RegressionCheckResponse> = {},
): RegressionCheckResponse {
  return {
    id: 'rc_abc',
    agent_name: 'support-agent',
    baseline_manifest_id: 'mfst_baseline',
    candidate_manifest_id: 'mfst_candidate',
    status: 'completed',
    verdict: 'high_risk',
    verdict_message: '247 traces will break.',
    high_risk_count: 247,
    medium_risk_count: 89,
    low_risk_count: 1666,
    total_traces_analyzed: 2002,
    diff_summary: {
      total_changes: 1,
      changes: [
        {
          type: 'tool_removed',
          name: 'compare_competitors',
          severity: 'high',
        },
      ],
    },
    pr_context: null,
    impacts: [],
    created_at: '2026-05-10T12:00:00Z',
    ...overrides,
  };
}

describe('formatComment', () => {
  it('includes the marker for upsert lookup', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).toContain('<!-- decimalai-regression-check-comment -->');
  });

  it('shows agent name and verdict for high_risk', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).toContain('support-agent');
    // Structural verdict wording changed from RISK → IMPACT to
    // disambiguate "the change touched things" from "the change broke
    // things." The eval verdict line below it carries the regression-risk
    // assessment.
    expect(md).toContain('HIGH IMPACT');
    expect(md).toContain('247');
  });

  it('shows manifest changes section', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).toContain('Manifest changes');
    expect(md).toContain('Tool removed');
    expect(md).toContain('compare_competitors');
  });

  it('renders the impact table with all three severity rows', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).toContain('🔴 HIGH IMPACT');
    expect(md).toContain('247');
    expect(md).toContain('🟡 MEDIUM IMPACT');
    expect(md).toContain('89');
    // C9: trace counts are comma-formatted for readability
    expect(md).toContain('🟢 LOW IMPACT');
    expect(md).toContain('1,666');
  });

  it('emits friendly first-run message for first_run verdict', () => {
    const md = formatComment(
      makeReport({
        verdict: 'first_run',
        verdict_message: 'First run. Recorded baseline.',
        diff_summary: { total_changes: 0, changes: [], first_run: true },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('FIRST RUN');
    expect(md).toContain('First run. Recorded baseline.');
    // Should NOT show the impact table on first run
    expect(md).not.toContain('| 🔴 HIGH IMPACT');
  });

  it('renders dashboard link with app subdomain', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).toContain('https://app.decimal.ai/agents/support-agent/regression/rc_abc');
  });

  it('truncates long change lists with a "more" line', () => {
    const manyChanges = Array.from({ length: 10 }, (_, i) => ({
      type: 'tool_removed',
      name: `tool_${i}`,
      severity: 'high' as const,
    }));
    const md = formatComment(
      makeReport({ diff_summary: { total_changes: 10, changes: manyChanges } }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('and 2 more');
  });

  it('renders tool_renamed as "Tool renamed" with MEDIUM severity', () => {
    const md = formatComment(
      makeReport({
        verdict: 'medium_risk',
        diff_summary: {
          total_changes: 1,
          changes: [
            {
              type: 'tool_renamed',
              name: 'find_v1',
              severity: 'medium',
            },
          ],
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('Tool renamed');
    expect(md).toContain('find_v1');
    // Sanity: medium emoji, not high
    expect(md).toContain('🟡');
  });

  it('shows top high-severity impact explanations', () => {
    const md = formatComment(
      makeReport({
        impacts: [
          {
            id: 'imp_1',
            surface_change_type: 'tool_removed',
            surface_name: 'compare_competitors',
            severity: 'high',
            affected_trace_count: 247,
            sample_trace_ids: ['t1', 't2'],
            explanation: '247 traces called the removed tool.',
          },
        ],
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('Top affected');
    expect(md).toContain('247 traces called the removed tool.');
  });

  // ─────────────────────────────────────────────────────────────────
  // Eval-weighted second axis
  // ─────────────────────────────────────────────────────────────────

  it('renders the eval verdict header when present', () => {
    const md = formatComment(
      makeReport({
        eval_verdict: 'regression_likely',
        eval_breakdown: {
          passing_affected: 183,
          failing_affected: 41,
          unscored_affected: 23,
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('REGRESSION LIKELY');
    expect(md).toContain('passing eval');
  });

  it('renders expected_impact when only failing-eval traces are affected', () => {
    const md = formatComment(
      makeReport({
        eval_verdict: 'expected_impact',
        eval_breakdown: {
          passing_affected: 0,
          failing_affected: 41,
          unscored_affected: 5,
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('EXPECTED IMPACT');
  });

  it('renders eval breakdown row in the impact table when present', () => {
    const md = formatComment(
      makeReport({
        eval_verdict: 'regression_likely',
        eval_breakdown: {
          passing_affected: 183,
          failing_affected: 41,
          unscored_affected: 23,
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('Currently passing eval');
    expect(md).toContain('183');
    expect(md).toContain('41');
  });

  it('omits eval block gracefully on older backends', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).not.toContain('REGRESSION LIKELY');
    expect(md).not.toContain('Currently passing eval');
    // structural verdict still rendered
    expect(md).toContain('HIGH IMPACT');
  });

  it('renders per-impact eval split inline when eval_breakdown present', () => {
    const md = formatComment(
      makeReport({
        impacts: [
          {
            id: 'imp_1',
            surface_change_type: 'tool_removed',
            surface_name: 'compare_competitors',
            severity: 'high',
            affected_trace_count: 41,
            sample_trace_ids: ['t1'],
            explanation: '41 traces called the removed tool.',
            eval_breakdown: {
              passing_affected: 5,
              failing_affected: 30,
              unscored_affected: 6,
            },
          },
        ],
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('5 passing');
    expect(md).toContain('30 failing');
    expect(md).toContain('6 unscored');
  });

  it('renders a sampling note when eval_capped is true', () => {
    const md = formatComment(
      makeReport({
        eval_verdict: 'regression_likely',
        eval_breakdown: {
          passing_affected: 800,
          failing_affected: 200,
          unscored_affected: 0,
          eval_capped: true,
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('sampled');
  });

  // ── Downstream impact rows ────────────────────────────────────

  it('omits the downstream-impact block when downstream_impact is undefined (older backend)', () => {
    const md = formatComment(makeReport(), 'https://api.decimal.ai');
    expect(md).not.toContain('Downstream impact');
  });

  it('omits the downstream-impact block when all counts are zero', () => {
    const md = formatComment(
      makeReport({
        downstream_impact: {
          evaluators: { stale_count: 0, sample_evaluator_names: [], surfaces_causing_staleness: [] },
          datasets: { affected_dataset_version_count: 0, sample_dataset_names: [], total_rows_invalidated: 0 },
          subagents: { broken_handoffs: [] },
          skills: { affected_agent_count: 0, sample_agent_names: [], skills_changed: [] },
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).not.toContain('Downstream impact');
  });

  it('renders evaluator + dataset + sub-agent + skill rows when non-zero', () => {
    const md = formatComment(
      makeReport({
        downstream_impact: {
          evaluators: {
            stale_count: 2,
            sample_evaluator_names: ['competitor_check', 'tone_check'],
            surfaces_causing_staleness: ['tool_registry: major'],
          },
          datasets: {
            affected_dataset_version_count: 1,
            sample_dataset_names: ['training-v3'],
            total_rows_invalidated: 847,
          },
          subagents: {
            broken_handoffs: [
              { subagent_name: 'research-bot', surface_diff: 'handoff schema changed' },
            ],
          },
          skills: {
            affected_agent_count: 3,
            sample_agent_names: ['a', 'b', 'c'],
            skills_changed: ['web-search'],
          },
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('Downstream impact');
    expect(md).toContain('Evaluator impact');
    expect(md).toContain('2 stale');
    expect(md).toContain('Dataset impact');
    expect(md).toContain('847');
    expect(md).toContain('Sub-agent impact');
    expect(md).toContain('research-bot');
    expect(md).toContain('Skill impact');
    expect(md).toContain('3 agents');
    expect(md).toContain('web-search');
  });

  it('renders only the non-zero dimensions (partial downstream impact)', () => {
    const md = formatComment(
      makeReport({
        downstream_impact: {
          evaluators: { stale_count: 0, sample_evaluator_names: [], surfaces_causing_staleness: [] },
          datasets: { affected_dataset_version_count: 0, sample_dataset_names: [], total_rows_invalidated: 0 },
          subagents: { broken_handoffs: [] },
          skills: {
            affected_agent_count: 5,
            sample_agent_names: [],
            skills_changed: ['shared-skill'],
          },
        },
      }),
      'https://api.decimal.ai',
    );
    expect(md).toContain('Skill impact');
    expect(md).toContain('5 agents');
    expect(md).not.toContain('Evaluator impact');
    expect(md).not.toContain('Dataset impact');
    expect(md).not.toContain('Sub-agent impact');
  });
});
