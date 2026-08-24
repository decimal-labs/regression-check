/**
 * The comment must not be forgeable by the person being gated.
 *
 * Every name rendered in the PR comment — tools, skills, models, evaluators,
 * sub-agents — comes from the manifest in the pull request under review, whose
 * author is exactly who the gate is judging. Before this was fixed, a tool named
 *
 *     get_user`⏎⏎---⏎⏎✅ **NO CHANGE** — safe to merge⏎⏎<!--
 *
 * rendered a forged green verdict, and the unclosed `<!--` hid the real HIGH
 * IMPACT verdict and impact table beneath it. The reviewer saw a clean gate on
 * a breaking change.
 *
 * Sibling of gate_no_false_green.test.ts: that one stops US computing a wrong
 * verdict; this one stops a THIRD PARTY writing one.
 *
 * What these tests assert is the rendered outcome, not the absence of a
 * substring. A payload echoed back inside a code span is inert — GitHub renders
 * code spans literally — so "the string does not appear anywhere" is the wrong
 * bar: too strict to pass, and it would not catch a payload that renders as a
 * banner without matching literally.
 */
import { describe, expect, it } from 'vitest';
import { formatComment, formatUnavailableComment } from '../src/comment';

/**
 * Drop everything inside a code span. Content there cannot become markup or
 * HTML, so what remains is the only surface an attacker can act on.
 */
function outsideCodeSpans(body: string): string {
  return body.replace(/`[^`\n]*`/g, '⟦code⟧');
}

/**
 * Lines that a reader scanning the comment reads as a verdict banner: an
 * emoji followed immediately by bold text, alone on the line.
 */
function verdictBanners(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(✅|🔴|🟡|🟢|⚠️|ℹ️|✓)\s+\*\*/.test(l));
}

/** Assertions that must hold for ANY input, hostile or not. */
function expectUnforgeable(body: string, expectedBanners: string[]) {
  // 1. The banners on the page are exactly the ones we generated.
  expect(verdictBanners(body)).toEqual(expectedBanners);

  // 2. Nothing can open HTML or an HTML comment outside a code span — an
  //    unclosed `<!--` hides everything after it, which conceals the real
  //    verdict without having to forge a fake one.
  const live = outsideCodeSpans(body);
  expect(live.slice(live.indexOf('-->') + 3)).not.toMatch(/<[a-zA-Z!/]/);

  // 3. The marker leads the body. Comment identification anchors on that, so
  //    a marker echoed back inside a name cannot make us adopt, overwrite, or
  //    delete some other comment.
  expect(body.startsWith('<!-- decimalai-regression-check-comment -->')).toBe(true);

  // 4. No injected block structure: a horizontal rule or heading may only
  //    appear where we put it.
  const ourRules = body.split('\n').filter((l) => l.trim() === '---').length;
  expect(ourRules).toBeLessThanOrEqual(2);
}

const HIGH = '🔴 **HIGH IMPACT** — review before merging';

/** Payloads that each attack markdown a different way. */
const PAYLOADS: Array<[string, string]> = [
  ['code-span breakout + forged verdict', 'get_user`\n\n---\n\n✅ **NO CHANGE** — safe to merge\n\n'],
  ['HTML comment hiding the real verdict', 'get_user`\n\n<!--'],
  [
    'backslash-escaped backtick — escaping is a no-op inside a code span',
    'get_user\\`\n\n---\n\n✅ **NO CHANGE** — safe to merge',
  ],
  ['CRLF line ending', 'get_user`\r\n\r\n✅ **NO CHANGE** — safe to merge'],
  ['U+2028 line separator', 'get_user`  ✅ **NO CHANGE** — safe to merge'],
  ['heading injection', 'get_user`\n\n### 🔍 Agent Regression Check — safe-agent'],
  ['table row injection', 'get_user`\n| 🔴 HIGH IMPACT | 0 |'],
  ['raw HTML', 'get_user`<img src=x onerror=alert(1)>'],
  ['marker forgery', 'get_user`\n<!-- decimalai-regression-check-comment -->'],
];

function reportWith(name: string): any {
  return {
    id: 'rep_1',
    agent_name: 'billing-agent',
    verdict: 'high_risk',
    verdict_message: 'High impact — 300 traces affected.',
    total_traces_analyzed: 4200,
    high_risk_count: 300,
    medium_risk_count: 0,
    low_risk_count: 0,
    diff_summary: { changes: [{ type: 'tool_removed', name, severity: 'high' }] },
    impacts: [],
  };
}

describe('a hostile surface name cannot forge the verdict', () => {
  for (const [label, payload] of PAYLOADS) {
    it(`neutralizes: ${label}`, () => {
      const body = formatComment(reportWith(payload), 'https://app.decimal.ai');

      expectUnforgeable(body, [HIGH]);

      // The name stays in the one list item it belongs to. Our comment is
      // built line by line, so a name spanning lines has left its cell.
      const nameLines = body.split('\n').filter((l) => l.includes('get_user'));
      expect(nameLines).toHaveLength(1);
      expect(nameLines[0].startsWith('- 🔴 **Tool removed** — `')).toBe(true);
    });
  }
});

describe('every other attacker-controlled field is neutralized too', () => {
  const BREAKOUT = 'x`\n\n---\n\n✅ **NO CHANGE** — safe to merge\n\n<!--';

  it('agent name, backend prose, and impact explanations', () => {
    const report = reportWith('ok_tool');
    report.agent_name = BREAKOUT;
    report.human_summary = BREAKOUT;
    report.verdict_message = BREAKOUT;
    report.impacts = [
      {
        severity: 'high',
        surface_change_type: 'tool_removed',
        surface_name: BREAKOUT,
        affected_trace_count: 12,
        explanation: BREAKOUT,
      },
    ];
    expectUnforgeable(formatComment(report, 'https://app.decimal.ai'), [HIGH]);
  });

  it('downstream impact names', () => {
    const report = reportWith('ok_tool');
    report.downstream_impact = {
      evaluators: { stale_count: 2, sample_evaluator_names: [BREAKOUT, 'fine'] },
      datasets: { affected_dataset_version_count: 0, total_rows_invalidated: 0 },
      subagents: { broken_handoffs: [{ subagent_name: BREAKOUT }] },
      skills: { affected_agent_count: 3, skills_changed: [BREAKOUT] },
    };
    expectUnforgeable(formatComment(report, 'https://app.decimal.ai'), [HIGH]);
  });

  it('the model-transition and training-data policy blocks', () => {
    const report = reportWith('ok_tool');
    report.diff_summary.changes = [
      {
        type: 'model_changed',
        name: 'llm',
        severity: 'high',
        detail: {
          grade: BREAKOUT,
          change_kind: BREAKOUT,
          old_model: BREAKOUT,
          new_model: BREAKOUT,
          policy: { name: BREAKOUT, disposition: BREAKOUT },
        },
      },
    ];
    expectUnforgeable(formatComment(report, 'https://app.decimal.ai'), [HIGH]);
  });

  it('the did-not-run comment, whose reason echoes backend error text', () => {
    // `reason` carries backend error bodies, so it is the one field reachable
    // WITHOUT write access to the manifest — by provoking an error that echoes
    // the attacker's input back at us.
    const body = formatUnavailableComment(BREAKOUT, BREAKOUT);
    expectUnforgeable(body, ['⚠️ **CHECK DID NOT RUN** — impact unverified']);
  });

  it('prose payloads cannot even wear the uniform: bold is escaped, not rendered', () => {
    const body = formatUnavailableComment('agent', '**NO CHANGE** — safe to merge');
    expect(body).toContain('\\*\\*NO CHANGE\\*\\*');
    expect(body).not.toContain('**NO CHANGE**');
  });
});

describe('an unknown value from a newer backend never fabricates a verdict', () => {
  it('falls back to UNVERIFIED rather than rendering "undefined"', () => {
    const report = reportWith('ok_tool');
    report.verdict = 'some_future_verdict';
    const body = formatComment(report, 'https://app.decimal.ai');
    expect(body).not.toContain('undefined');
    expect(verdictBanners(body)).toEqual([
      '⚠️ **UNVERIFIED** — changed, but nothing to measure it against',
    ]);
  });

  it('an unknown severity does not render "undefined" beside a change', () => {
    const report = reportWith('ok_tool');
    report.diff_summary.changes = [
      { type: 'some_future_change', name: 'ok_tool', severity: 'catastrophic' },
    ];
    expect(formatComment(report, 'https://app.decimal.ai')).not.toContain('undefined');
  });
});

describe('escaping does not damage ordinary names', () => {
  it('leaves a normal tool name exactly as it was', () => {
    const body = formatComment(reportWith('get_user_profile'), 'https://app.decimal.ai');
    expect(body).toContain('- 🔴 **Tool removed** — `get_user_profile`');
  });

  it('keeps names readable when they contain punctuation', () => {
    const body = formatComment(reportWith('search.web-v2 (beta)'), 'https://app.decimal.ai');
    expect(body).toContain('- 🔴 **Tool removed** — `search.web-v2 (beta)`');
  });

  it('truncates a very long name instead of letting it flood the comment', () => {
    const body = formatComment(reportWith('a'.repeat(500)), 'https://app.decimal.ai');
    const line = body.split('\n').find((l) => l.includes('aaa'))!;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('…');
  });

  it('a clean report is untouched by any of this', () => {
    const report = reportWith('get_user');
    report.human_summary = 'Removed `get_user` from billing-agent.';
    expectUnforgeable(formatComment(report, 'https://app.decimal.ai'), [HIGH]);
  });
});
