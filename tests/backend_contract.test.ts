/**
 * Backend ↔ Action contract test (offline).
 *
 * The Action's TS types have to agree with the response the DecimalAI API
 * actually returns, but the API is a separate service that CI cannot reach.
 * Left unchecked, a field or verdict-enum rename on the server would silently
 * break the customer-facing PR comment and the merge gate with nothing red.
 *
 * This test closes that gap WITHOUT a live server. It pins the Action's TS
 * contract to a COMMITTED snapshot of the response shape
 * (tests/fixtures/backend_regression_contract.json — see its _README for how
 * to regenerate it). Drift on EITHER side fails CI:
 *   - rename a verdict value in src/api.ts  → enum mismatch below
 *   - regenerate the snapshot after a server-side field/verdict rename
 *     without updating src/api.ts            → enum / key mismatch below
 *
 * TS interfaces are erased at runtime, so we can't reflect over
 * `RegressionCheckResponse` / `Verdict` directly. Instead we hand-maintain
 * the expected values as runtime `const`s and TIE them to the actual TS
 * types with `satisfies` guards: rename a value in src/api.ts and `tsc`
 * (npm run lint) breaks here too, so the hand-list can't silently rot.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Verdict,
  EvalVerdict,
  RegressionCheckResponse,
} from '../src/api';

type Contract = {
  verdict_enum: string[];
  eval_verdict_enum: string[];
  backend_response_keys: string[];
};

const contract: Contract = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'backend_regression_contract.json'),
    'utf8',
  ),
);

/**
 * The verdict values the Action's `Verdict` type handles. The `satisfies`
 * clause makes `tsc` reject this array if it stops being a list of the
 * actual `Verdict` union members — so renaming a value in src/api.ts can't
 * skip this guard. The exhaustiveness check below catches a value DROPPED
 * from this list.
 */
const TS_VERDICTS = [
  'high_risk',
  'medium_risk',
  'low_risk',
  'no_change',
  // A structural change with zero traces in the window to measure it against:
  // no verdict is possible, and that is NOT the same as "no change".
  'unverified',
  'first_run',
] as const satisfies readonly Verdict[];

const TS_EVAL_VERDICTS = [
  'clean',
  'expected_impact',
  'regression_likely',
  'first_run',
] as const satisfies readonly EvalVerdict[];

/**
 * Compile-time exhaustiveness: assigning the union back into the array's
 * element type forces TS_VERDICTS to enumerate EVERY member of `Verdict`.
 * If a value is added to the union in src/api.ts but not to TS_VERDICTS,
 * this assignment is a type error (npm run lint fails).
 */
const _verdictExhaustive: (typeof TS_VERDICTS)[number] = '' as Verdict;
const _evalExhaustive: (typeof TS_EVAL_VERDICTS)[number] = '' as EvalVerdict;
void _verdictExhaustive;
void _evalExhaustive;

/**
 * The response keys the Action's TS REQUIRES (reads off the JSON and would
 * misrender / mis-gate without). The `satisfies` clause ties each entry to
 * an actual key of `RegressionCheckResponse`: rename `verdict` →
 * `verdict_v2` in src/api.ts and this list is a type error until updated.
 *
 * These are the non-optional fields of RegressionCheckResponse that the
 * comment template (src/comment.ts) and the gate (src/index.ts) consume.
 */
const TS_REQUIRED_KEYS = [
  'id',
  'agent_name',
  'baseline_manifest_id',
  'candidate_manifest_id',
  'status',
  'verdict',
  'verdict_message',
  'high_risk_count',
  'medium_risk_count',
  'low_risk_count',
  'total_traces_analyzed',
  'diff_summary',
  'pr_context',
] as const satisfies readonly (keyof RegressionCheckResponse)[];

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

describe('backend ↔ Action contract (offline snapshot)', () => {
  it('Verdict enum matches the backend snapshot EXACTLY', () => {
    // Exact set equality: a verdict added, removed, or renamed on either
    // side (TS or the snapshot regenerated from the backend) fails here.
    expect(sorted(TS_VERDICTS)).toEqual(sorted(contract.verdict_enum));
  });

  it('EvalVerdict enum matches the backend snapshot EXACTLY', () => {
    expect(sorted(TS_EVAL_VERDICTS)).toEqual(sorted(contract.eval_verdict_enum));
  });

  it('every TS-required response key is present in the backend snapshot', () => {
    // The backend emits a SUPERSET (keys the Action doesn't render). The
    // contract we must hold: every key the Action reads is one the backend
    // actually sends. Rename/drop a key backend-side (snapshot regenerated)
    // or TS-side and this fails.
    const backendKeys = new Set(contract.backend_response_keys);
    const missing = TS_REQUIRED_KEYS.filter((k) => !backendKeys.has(k));
    expect(missing, `TS reads keys the backend snapshot doesn't emit: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('the snapshot key set is well-formed (no dupes, all strings)', () => {
    // Guards against a botched regeneration that would weaken the checks
    // above (e.g. a duplicated or empty key silently passing set membership).
    const keys = contract.backend_response_keys;
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
