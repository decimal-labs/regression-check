/**
 * Visual regression for the PR-comment markdown.
 *
 * A pixel-diff approach (Playwright rendering GitHub markdown) was considered
 * and rejected as needless: GitHub's renderer is deterministic given the input markdown,
 * so locking the markdown bytes catches the same regressions at ~0% of the
 * cost. The existing 26 tests in comment.test.ts use `toContain(...)` on
 * individual sections — a refactor that, e.g., reorders the impact-table
 * columns or drops the "View full report" link would pass every one of
 * those and still ship a broken comment. This file locks the WHOLE shape
 * for all 5 verdicts.
 *
 * If a snapshot needs to change intentionally, run:
 *   `pnpm vitest -u tests/comment_snapshot.test.ts`
 * The diff in the PR shows reviewers exactly what changed in the comment.
 */

import { describe, it, expect } from 'vitest';
import { formatComment } from '../src/comment';
import { RegressionCheckResponse } from '../src/api';


// One pinned fixture per verdict — deliberately distinct counts so each
// snapshot is unambiguous to read and clearly distinguishes verdict paths.

const BASE_URL = 'https://api.decimal.ai';

function fixture(overrides: Partial<RegressionCheckResponse> = {}): RegressionCheckResponse {
  return {
    id: 'rc_snapshot',
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
      changes: [{ type: 'tool_removed', name: 'compare_competitors', severity: 'high' }],
    },
    pr_context: null,
    impacts: [],
    created_at: '2026-05-10T12:00:00Z',
    ...overrides,
  };
}


describe('full-markdown snapshots (one per verdict)', () => {
  it('high_risk: tool removed → 247 high-risk traces', () => {
    expect(formatComment(fixture(), BASE_URL)).toMatchInlineSnapshot(`
      "<!-- decimalai-regression-check-comment -->
      ### 🔍 Decimal Manifest Impact — \`support-agent\`

      **Manifest changes:**
      - 🔴 **Tool removed** — \`compare_competitors\`

      **Impact on last 2,002 production traces:**

      | Severity | Traces |
      |---|---|
      | 🔴 HIGH IMPACT | 247 |
      | 🟡 MEDIUM IMPACT | 89 |
      | 🟢 LOW IMPACT | 1,666 |

      ---

      🔴 **HIGH IMPACT** — review before merging

      [View full report →](https://app.decimal.ai/agents/support-agent/regression/rc_snapshot)"
    `);
  });

  it('medium_risk: tool_renamed → 0 high, 25 medium, 100 low', () => {
    const md = formatComment(
      fixture({
        verdict: 'medium_risk',
        verdict_message: '25 traces may behave differently.',
        high_risk_count: 0,
        medium_risk_count: 25,
        low_risk_count: 100,
        total_traces_analyzed: 125,
        diff_summary: {
          total_changes: 1,
          changes: [{ type: 'tool_renamed', name: 'search_v2', severity: 'medium' }],
        },
      }),
      BASE_URL,
    );
    expect(md).toMatchInlineSnapshot(`
      "<!-- decimalai-regression-check-comment -->
      ### 🔍 Decimal Manifest Impact — \`support-agent\`

      **Manifest changes:**
      - 🟡 **Tool renamed** — \`search_v2\`

      **Impact on last 125 production traces:**

      | Severity | Traces |
      |---|---|
      | 🔴 HIGH IMPACT | 0 |
      | 🟡 MEDIUM IMPACT | 25 |
      | 🟢 LOW IMPACT | 100 |

      ---

      🟡 **MEDIUM IMPACT** — review affected traces

      [View full report →](https://app.decimal.ai/agents/support-agent/regression/rc_snapshot)"
    `);
  });

  it('low_risk: optional param added → mostly low', () => {
    const md = formatComment(
      fixture({
        verdict: 'low_risk',
        verdict_message: '500 traces unaffected.',
        high_risk_count: 0,
        medium_risk_count: 0,
        low_risk_count: 500,
        total_traces_analyzed: 500,
        diff_summary: {
          total_changes: 1,
          changes: [{ type: 'tool_schema_optional_param_added', name: 'find_orders', severity: 'low' }],
        },
      }),
      BASE_URL,
    );
    expect(md).toMatchInlineSnapshot(`
      "<!-- decimalai-regression-check-comment -->
      ### 🔍 Decimal Manifest Impact — \`support-agent\`

      **Manifest changes:**
      - 🟢 **Optional param added** — \`find_orders\`

      **Impact on last 500 production traces:**

      | Severity | Traces |
      |---|---|
      | 🔴 HIGH IMPACT | 0 |
      | 🟡 MEDIUM IMPACT | 0 |
      | 🟢 LOW IMPACT | 500 |

      ---

      🟢 **LOW IMPACT** — likely safe to merge

      [View full report →](https://app.decimal.ai/agents/support-agent/regression/rc_snapshot)"
    `);
  });

  it('no_change: zero diffs', () => {
    const md = formatComment(
      fixture({
        verdict: 'no_change',
        verdict_message: 'Manifest unchanged.',
        high_risk_count: 0,
        medium_risk_count: 0,
        low_risk_count: 0,
        total_traces_analyzed: 1000,
        diff_summary: { total_changes: 0, changes: [] },
      }),
      BASE_URL,
    );
    expect(md).toMatchInlineSnapshot(`
      "<!-- decimalai-regression-check-comment -->
      ### 🔍 Decimal Manifest Impact — \`support-agent\`

      **Impact on last 1,000 production traces:**

      | Severity | Traces |
      |---|---|
      | 🔴 HIGH IMPACT | 0 |
      | 🟡 MEDIUM IMPACT | 0 |
      | 🟢 LOW IMPACT | 0 |

      ---

      ✅ **NO CHANGE** — safe to merge

      [View full report →](https://app.decimal.ai/agents/support-agent/regression/rc_snapshot)"
    `);
  });

  it('first_run: baseline recorded path — no impact table', () => {
    const md = formatComment(
      fixture({
        verdict: 'first_run',
        verdict_message: 'First run for this agent. Baseline recorded.',
        diff_summary: { total_changes: 0, changes: [], first_run: true },
      }),
      BASE_URL,
    );
    expect(md).toMatchInlineSnapshot(`
      "<!-- decimalai-regression-check-comment -->
      ### 🔍 Decimal Manifest Impact — \`support-agent\`

      ✓ **FIRST RUN** — baseline recorded

      First run for this agent. Baseline recorded.

      _Future PRs will diff against this manifest._"
    `);
  });
});
