/**
 * The fixture cannot drift from the live response shape, or from the story every other
 * surface tells.
 *
 * `fixtures/impact_report.json` was captured from a real run; if the backend's response
 * shape moves, `tests/fixtures/backend_regression_contract.json` moves with it (that file
 * is regenerated from the backend), and this test then points at the fixture as the thing
 * that is stale. The numbers are pinned because docs.decimal.ai/tutorials/two-minute-demo,
 * the README image and `decimalai demo regression` all state them: 2 high / 118 medium / 0
 * low over 120 traces, six manifest changes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_REPORT, fixtureReport, FIXTURE_BANNER } from '../src/fixture';

const contract = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'backend_regression_contract.json'), 'utf8'),
) as { verdict_enum: string[]; eval_verdict_enum: string[]; backend_response_keys: string[] };

const raw = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'impact_report.json'), 'utf8')) as Record<string, unknown>;

describe('the fixture report', () => {
  it('uses only keys the backend actually returns', () => {
    const keys = Object.keys(raw).filter((k) => k !== '_README');
    const unknown = keys.filter((k) => !contract.backend_response_keys.includes(k));
    expect(unknown).toEqual([]);
  });

  it('carries the demo story every other surface states', () => {
    expect(FIXTURE_REPORT.verdict).toBe('high_risk');
    expect(contract.verdict_enum).toContain(FIXTURE_REPORT.verdict);
    expect(FIXTURE_REPORT.total_traces_analyzed).toBe(120);
    expect(FIXTURE_REPORT.high_risk_count).toBe(2);
    expect(FIXTURE_REPORT.medium_risk_count).toBe(118);
    expect(FIXTURE_REPORT.low_risk_count).toBe(0);
    expect(FIXTURE_REPORT.agent_name).toBe('[Demo] support-agent');
    const types = (FIXTURE_REPORT.diff_summary?.changes ?? []).map((c) => c.type).sort();
    expect(types).toEqual([
      'model_changed',
      'prompt_section_rewritten',
      'tool_added',
      'tool_removed',
      'tool_renamed',
      'tool_schema_optional_param_added',
    ]);
  });

  it('has placeholders where a live run has ids, so nothing points at a real record', () => {
    expect(FIXTURE_REPORT.id).toBe('fixture-demo-support-agent');
    expect(FIXTURE_REPORT.pr_context).toBeNull();
    expect(raw.source).toBe('fixture');
  });

  it('is copied, not shared, and relabels only the agent name', () => {
    const a = fixtureReport('mine');
    expect(a.agent_name).toBe('mine');
    expect(FIXTURE_REPORT.agent_name).toBe('[Demo] support-agent');
    a.high_risk_count = 999;
    expect(fixtureReport().high_risk_count).toBe(2);
  });

  it('the banner is plain markdown and names the remedy', () => {
    expect(FIXTURE_BANNER.startsWith('> **Fixture run — sample data, not your traffic.**')).toBe(true);
    expect(FIXTURE_BANNER).toContain('api-key: ${{ secrets.DECIMAL_API_KEY }}');
    expect(FIXTURE_BANNER).not.toMatch(/<[a-zA-Z!/]/);
  });
});

describe('the sample comment a stranger sees', () => {
  it('names nothing internal', () => {
    expect(JSON.stringify(raw)).not.toMatch(/\bCUJ\b/);
  });
});

