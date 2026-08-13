/**
 * PR comment formatting + upsert via the GitHub REST API.
 *
 * Updates an existing comment in place per push rather than posting a new
 * one. Identification of "our" comment is via a hidden
 * marker string in the comment body.
 */

import * as github from '@actions/github';
import {
  CallReplayResult,
  EvalBreakdown,
  EvalVerdict,
  JudgeVerdict,
  RegressionCheckResponse,
  Severity,
  SurfaceChangeSummary,
  Verdict,
  buildReportUrl,
} from './api';
import { CommentMode } from './inputs';

/** Hidden marker for finding our existing comment on update mode. */
const MARKER = '<!-- decimalai-regression-check-comment -->';

/**
 * Hardening for attacker-controlled text.
 *
 * Every name this file renders — tools, skills, models, evaluators, sub-agents,
 * plus the backend prose composed from them — comes from the manifest in the
 * pull request being checked. The author of that pull request is precisely the
 * person the gate is judging, so all of it is hostile input.
 *
 * The class of bug this exists to prevent: a tool name carrying a raw
 * backtick, a newline, a `---` rule and an unclosed `<!--` can forge a green
 * verdict into our own comment and hide the real one below it, so a reviewer
 * sees a clean gate on a breaking change. A gate whose output is writable by
 * the person being gated is worse than no gate, because it is trusted.
 *
 * Two properties do the work:
 *   - Newlines are the structural vector. Markdown structure — headings, `---`
 *     rules, list items, table rows — is line-based, so text that cannot carry
 *     a newline cannot invent structure.
 *   - `<` is the concealment vector. GitHub renders raw HTML in comments, and
 *     an unclosed `<!--` hides everything that follows it.
 */
const MAX_INLINE = 120;
const MAX_PROSE = 400;

function collapse(value: unknown, max: number): string {
  const s = value == null ? '' : String(value);
  // `\s+` covers \n and \r, and also U+2028/U+2029, which several renderers
  // treat as line breaks but a naive `\n` check misses.
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Text going INSIDE a code span — the `\`${…}\`` sites.
 *
 * Backticks are replaced, not backslash-escaped. Markdown does not honour
 * backslash escapes inside a code span, so `` `a\`b` `` still terminates at the
 * raw backtick and the rest leaks out as markup. Escaping here is not merely
 * weaker than replacing — it does nothing. `<` needs no treatment: a code span
 * renders it literally.
 */
function mdCode(value: unknown, max = MAX_INLINE): string {
  return collapse(value, max).replace(/`/g, "'");
}

/**
 * Text going into plain markdown prose, outside any code span. Here backslash
 * escapes DO apply, so backticks are escaped rather than replaced and the
 * original characters survive. A leading list/heading/quote marker is escaped
 * so a name cannot open a new block at the start of a line.
 */
function mdText(value: unknown, max = MAX_INLINE): string {
  return (
    collapse(value, max)
      .replace(/</g, '&lt;')
      // Emphasis markers are escaped, not just the structural ones. Without
      // this, a name reading `**NO CHANGE** — safe to merge` renders in the
      // same bold as a real verdict: it cannot occupy its own line any more,
      // but it can still wear the uniform. Escaped, the asterisks stay visible
      // and it reads as what it is — someone's tool name.
      .replace(/([\\`*_[\]])/g, '\\$1')
      .replace(/^([-+#>|]|\d+\.)/, '\\$1')
  );
}

const VERDICT_HEADER: Record<Verdict, string> = {
  high_risk: '🔴 **HIGH IMPACT** — review before merging',
  medium_risk: '🟡 **MEDIUM IMPACT** — review affected traces',
  low_risk: '🟢 **LOW IMPACT** — likely safe to merge',
  no_change: '✅ **NO CHANGE** — safe to merge',
  // Deliberately NOT a green check. This verdict means the manifest changed
  // and there was no production traffic in the window to measure the change
  // against, so this must not read as a clean bill of health.
  unverified: '⚠️ **UNVERIFIED** — changed, but nothing to measure it against',
  first_run: '✓ **FIRST RUN** — baseline recorded',
};

/**
 * Eval-weighted second-axis verdict header. Renders ALONGSIDE
 * the structural verdict above. The structural verdict says "this change
 * touched 247 traces"; this verdict says "and 183 of those were passing
 * eval — that's where the regression risk actually lives."
 */
const EVAL_VERDICT_HEADER: Record<EvalVerdict, string> = {
  regression_likely:
    '⚠️ **REGRESSION LIKELY** — affects traffic that was passing eval',
  expected_impact:
    'ℹ️ **EXPECTED IMPACT** — affected traces were already failing eval',
  clean: '✅ **CLEAN** — no passing-eval traffic affected',
  first_run: '✓ **FIRST RUN** — no eval baseline yet',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
};

// Plain-English gloss for each training-data disposition (rendered in the
// Training-data policy block — display only, distinct from the gate).
const DISPOSITION_GLOSS: Record<string, string> = {
  drop: 'excluded from training',
  replay: 'need re-running first',
  flag: 'flagged for review',
  repair: 'auto-repaired',
  keep: 'retained',
};

const CHANGE_TYPE_LABELS: Record<string, string> = {
  tool_removed: 'Tool removed',
  tool_added: 'Tool added',
  tool_renamed: 'Tool renamed',
  tool_schema_required_param_added: 'Required param added',
  tool_schema_optional_param_added: 'Optional param added',
  tool_schema_param_removed: 'Param removed',
  prompt_section_rewritten: 'Prompt section rewritten',
  skill_removed: 'Skill removed',
  skill_modified: 'Skill modified',
  model_changed: 'Model changed',
};

/**
 * Inline grade annotation for model/prompt changes, read from the
 * backend-populated `SurfaceChange.detail` (grade / change_kind / diff_pct /
 * old+new). Empty string for changes that carry no grade (tools, skills, or
 * older backends) — so the change line is unchanged for those.
 */
function gradeSuffix(c: SurfaceChangeSummary): string {
  const d = (c.detail || {}) as Record<string, unknown>;
  const grade = typeof d.grade === 'string' ? mdText(d.grade, 40) : '';
  if (!grade) return '';
  if (c.type === 'model_changed') {
    const kind =
      typeof d.change_kind === 'string'
        ? ` (${mdText(d.change_kind.replace(/_/g, ' '), 40)})`
        : '';
    const oldM = (d.old_model ?? d.old_provider) as string | undefined;
    const newM = (d.new_model ?? d.new_provider) as string | undefined;
    const transition =
      oldM && newM ? ` \`${mdCode(oldM, 60)} → ${mdCode(newM, 60)}\`` : '';
    return ` · **${grade}**${kind}${transition}`;
  }
  if (c.type === 'prompt_section_rewritten') {
    const pct = typeof d.diff_pct === 'number' ? ` (${d.diff_pct}% changed)` : '';
    return ` · **${grade}**${pct}`;
  }
  return ` · **${grade}**`;
}

function describeChange(c: SurfaceChangeSummary): string {
  // `c.type` is attacker-controlled too: the fallback branch renders it raw
  // when the backend reports a change type this Action does not know yet.
  const label = CHANGE_TYPE_LABELS[c.type] || mdText(c.type.replace(/_/g, ' '), 60);
  const name = c.name ? ` — \`${mdCode(c.name)}\`` : '';
  // An unrecognized severity yields `undefined` from the emoji map, which
  // renders the string "undefined". Fall back to the neutral marker instead.
  const emoji = SEVERITY_EMOJI[c.severity] || '•';
  return `${emoji} **${label}**${name}${gradeSuffix(c)}`;
}

/**
 * Render an eval breakdown inline. Skips when the breakdown is absent
 * (older backend) or all-zero. Format: " (5 passing • 30 failing • 6 unscored)".
 */
function formatEvalInline(eb: EvalBreakdown | null | undefined): string {
  if (!eb) return '';
  const { passing_affected, failing_affected, unscored_affected } = eb;
  if (passing_affected + failing_affected + unscored_affected === 0) return '';
  const parts: string[] = [];
  if (passing_affected > 0) parts.push(`${passing_affected.toLocaleString()} passing`);
  if (failing_affected > 0) parts.push(`${failing_affected.toLocaleString()} failing`);
  if (unscored_affected > 0) parts.push(`${unscored_affected.toLocaleString()} unscored`);
  return ` _(${parts.join(' • ')})_`;
}

/**
 * Behavioral verification block. Renders the call-replay result (counts +
 * optional LLM-judge verdicts) under the verdict. Silent for `no_model_change`;
 * a one-liner for unsupported / no-calls; full counts for `ok`.
 */
function formatBehavioral(cr: CallReplayResult): string[] {
  const out: string[] = [];
  if (cr.status === 'no_model_change') return out;

  if (cr.status !== 'ok' || !cr.summary) {
    out.push(`**Behavioral verification** — ${cr.message || 'not run'}`);
    out.push('');
    return out;
  }

  const s = cr.summary;
  const swap =
    cr.baseline_model && cr.target_model
      ? `\`${cr.baseline_model} → ${cr.target_model}\` `
      : '';
  if (cr.mode !== 'real') {
    // Mock re-issues calls against a model-independent stub, so the
    // equivalent/changed split is meaningless (it always reads ~100% changed).
    // Show the real eligible-call count and point at the real check — never a
    // fabricated changed-count.
    out.push(
      `**Behavioral verification** — ${swap}${s.replayed} recorded ` +
        `call${s.replayed === 1 ? '' : 's'} eligible for replay _(mock — not verified)_`,
    );
    out.push(
      '- Add `behavioral-check: real` to verify outputs against the new model ' +
        '(spends tokens), or use post-deploy bisect.',
    );
    out.push('');
    return out;
  }

  out.push(
    `**Behavioral verification** — ${swap}re-issued ${s.replayed} recorded ` +
      `call${s.replayed === 1 ? '' : 's'}`,
  );
  const bits = [`${s.equivalent} equivalent`, `**${s.changed} changed**`];
  if (s.errors) bits.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
  out.push(`- ${bits.join(' · ')}`);
  if (s.judge) {
    const order: JudgeVerdict[] = ['worse', 'better', 'equivalent', 'unclear'];
    const jbits = order
      .filter((v) => (s.judge?.[v] ?? 0) > 0)
      .map((v) => `${s.judge?.[v]} ${v}`);
    if (jbits.length > 0) out.push(`- Judge: ${jbits.join(' · ')}`);
  }
  out.push('');
  return out;
}

// Honest behavioral nudge. When the diff includes a model change but no *real*
// call-replay result was produced, the structural check genuinely can't say
// whether outputs differ. Point the reviewer at the two ways to find out —
// `behavioral-check: real` (spends tokens) or post-deploy bisect — WITHOUT
// fabricating a changed-count. `n` is the real affected-trace count, not a
// guess. (Mock call-replay is deliberately NOT defaulted: it returns a
// model-independent stub that always reads as "100% changed", which would be
// noise, not signal.)
function formatBehavioralNudge(report: RegressionCheckResponse): string[] {
  const changes = report.diff_summary?.changes || [];
  const hasModelChange = changes.some((c) => c.type === 'model_changed');
  if (!hasModelChange) return [];

  const modelImpact = (report.impacts || []).find(
    (i) => i.surface_change_type === 'model_changed',
  );
  const n = modelImpact?.affected_trace_count ?? report.total_traces_analyzed;
  const fmt = (x: number) => x.toLocaleString('en-US');

  return [
    "**Behavioral verification** — model change detected; the structural " +
      "check can't confirm whether outputs differ.",
    `- ${fmt(n)} recorded call${n === 1 ? '' : 's'} can be replayed against ` +
      'the new model. Add `behavioral-check: real` to verify (spends tokens), ' +
      'or use post-deploy bisect.',
    '',
  ];
}

export function formatComment(
  report: RegressionCheckResponse,
  baseUrl: string,
  callReplay?: CallReplayResult | null,
): string {
  const lines: string[] = [];
  lines.push(MARKER);
  lines.push(`### 🔍 Decimal Manifest Impact — \`${mdCode(report.agent_name)}\``);
  lines.push('');

  // `human_summary` — the same one-line callout that appears on the
  // in-product ImpactReport — goes right under the heading. It's a plain-
  // English description of the change: the reviewer's eye-anchor before
  // they decide whether to read the rest of the table.
  if (report.human_summary) {
    lines.push(`> ${mdText(report.human_summary, MAX_PROSE)}`);
    lines.push('');
  }

  if (report.verdict === 'first_run') {
    lines.push(VERDICT_HEADER.first_run);
    lines.push('');
    lines.push(mdText(report.verdict_message, MAX_PROSE));
    lines.push('');
    lines.push(`_Future PRs will diff against this manifest._`);
    return lines.join('\n');
  }

  // Diff summary
  const changes = report.diff_summary?.changes || [];
  if (changes.length > 0) {
    lines.push('**Manifest changes:**');
    for (const c of changes.slice(0, 8)) {
      lines.push(`- ${describeChange(c)}`);
    }
    if (changes.length > 8) {
      lines.push(`- _… and ${changes.length - 8} more_`);
    }
    lines.push('');
  }

  // Impact table — comma-format trace counts for readability
  const total = report.total_traces_analyzed;
  const fmt = (n: number) => n.toLocaleString('en-US');

  // With zero traces there is no impact table worth printing — every
  // cell is 0, and a table of zeros under a real diff reads as reassurance.
  // Say what actually happened instead.
  if (report.verdict === 'unverified') {
    lines.push('**Impact: not measured.**');
    lines.push('');
    lines.push(
      `No production traces for \`${mdCode(report.agent_name)}\` in the trace window, ` +
        'so there is nothing to check these changes against. This is not a ' +
        'clean bill of health — the changes above are unverified.',
    );
    lines.push('');
    lines.push('To get a real verdict:');
    lines.push(
      '- Instrument production with `decimalai.init()` so the agent emits traces, or',
    );
    lines.push('- Widen `trace-window-days` if traffic is older than the window.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(VERDICT_HEADER.unverified);
    lines.push('');
    lines.push(mdText(report.verdict_message, MAX_PROSE));
    lines.push('');
    // The eval verdict is deliberately omitted: with zero affected traces the
    // backend returns `clean`, and rendering "✅ CLEAN" under an UNVERIFIED
    // header re-creates the self-contradiction this fix exists to remove.
    lines.push(...formatBehavioralNudge(report));
    lines.push(`[View full report →](${buildReportUrl(baseUrl, report.agent_name, report.id)})`);
    return lines.join('\n');
  }

  lines.push(`**Impact on last ${fmt(total)} production trace${total === 1 ? '' : 's'}:**`);
  lines.push('');

  // When the eval breakdown is present, render a richer table that
  // splits each severity row by eval state. Fall back to the original
  // 2-column table when the backend doesn't supply the breakdown.
  const eb = report.eval_breakdown;
  if (eb) {
    lines.push('| Severity | Affected | Currently passing eval | Currently failing | Unscored |');
    lines.push('|---|---|---|---|---|');
    const totalAffected =
      report.high_risk_count + report.medium_risk_count + report.low_risk_count;
    // We don't have per-severity eval splits in the aggregate (the per-
    // impact rows below carry that). The aggregate row shows the overall
    // affected-by-eval-state split, which is the headline number engineers
    // want — "how much of the impact was on working traffic?"
    // The eval split is drawn from a sampled population (≤1000 traces per
    // surface) while `Affected` is exhaustive — the two columns share no
    // denominator, so mark the eval cells when capped to stop a reviewer
    // reading them as Affected = passing + failing + unscored.
    const evalSuffix = eb.eval_capped ? ' (sampled)' : '';
    lines.push(
      `| _all_ | ${fmt(totalAffected)} | ` +
        `${fmt(eb.passing_affected)}${evalSuffix} | ${fmt(eb.failing_affected)}${evalSuffix} | ${fmt(eb.unscored_affected)}${evalSuffix} |`,
    );
    lines.push(`| 🔴 HIGH IMPACT | ${fmt(report.high_risk_count)} | | | |`);
    lines.push(`| 🟡 MEDIUM IMPACT | ${fmt(report.medium_risk_count)} | | | |`);
    lines.push(`| 🟢 LOW IMPACT | ${fmt(report.low_risk_count)} | | | |`);
    if (eb.eval_capped) {
      lines.push('');
      lines.push(
        `> _Eval breakdown sampled at ${fmt(1000)} traces per surface change; affected-trace totals above are exhaustive._`,
      );
    }
  } else {
    lines.push('| Severity | Traces |');
    lines.push('|---|---|');
    lines.push(`| 🔴 HIGH IMPACT | ${fmt(report.high_risk_count)} |`);
    lines.push(`| 🟡 MEDIUM IMPACT | ${fmt(report.medium_risk_count)} |`);
    lines.push(`| 🟢 LOW IMPACT | ${fmt(report.low_risk_count)} |`);
  }
  lines.push('');

  // Per-impact details (top 3 high-severity), with per-impact eval split
  // inline so reviewers can see at a glance whether the impact landed on
  // passing or failing traffic.
  const impacts = (report.impacts || [])
    .filter((i) => i.severity === 'high')
    .slice(0, 3);
  if (impacts.length > 0) {
    lines.push('**Top affected:**');
    for (const i of impacts) {
      const base = i.explanation
        ? mdText(i.explanation, MAX_PROSE)
        : `${describeChange({
            type: i.surface_change_type,
            name: i.surface_name,
            severity: i.severity,
          })} — ${fmt(i.affected_trace_count)} traces`;
      lines.push(`- ${base}${formatEvalInline(i.eval_breakdown)}`);
    }
    lines.push('');
  }

  // Visual separator + dual-verdict block. The structural verdict comes
  // first (it's what's been there since 015); the eval verdict is rendered
  // below ONLY when the backend supplied one, so older deployments still
  // render correctly.
  lines.push('---');
  lines.push('');
  // Look the verdict up rather than rendering it. An unrecognized verdict from
  // a newer backend must never print "undefined" where a verdict belongs, and
  // must never be echoed through as text — fall back to the honest UNVERIFIED
  // header, which is the safe direction to be wrong in.
  lines.push(VERDICT_HEADER[report.verdict] || VERDICT_HEADER.unverified);
  if (report.eval_verdict && EVAL_VERDICT_HEADER[report.eval_verdict]) {
    lines.push(EVAL_VERDICT_HEADER[report.eval_verdict]);
  }
  lines.push('');

  // Training-data policy implication — DISPLAY ONLY. The verdict above is the
  // gate (structural severity + fail-on); this separate, labeled block shows
  // what the user's SFT/compatibility policy would do with the affected traces,
  // so the gate and the data disposition never blur. Only model/prompt changes
  // carry detail.policy (older backends omit it → block is silent).
  const policyChanges = changes.filter(
    (c) => c.detail && (c.detail as Record<string, unknown>).policy,
  );
  if (policyChanges.length > 0) {
    const firstPol = (policyChanges[0].detail as Record<string, unknown>)
      .policy as Record<string, unknown>;
    const impactByType = new Map(
      (report.impacts || []).map((i) => [i.surface_change_type, i] as const),
    );
    lines.push(`**Training-data policy** (\`${mdCode(firstPol.name, 60)}\`)`);
    for (const c of policyChanges) {
      const d = c.detail as Record<string, unknown>;
      const pol = d.policy as Record<string, unknown>;
      const label = CHANGE_TYPE_LABELS[c.type] || mdText(c.type.replace(/_/g, ' '), 60);
      // Looked up below for the gloss, so it must stay the raw key — but it is
      // also rendered, so render the escaped form and key off the raw one.
      const disposition = String(pol.disposition);
      const safeDisposition = mdText(disposition, 40);
      const gloss = DISPOSITION_GLOSS[disposition] || '';
      const imp = impactByType.get(c.type);
      const cnt = imp
        ? ` — ${fmt(imp.affected_trace_count)} trace${imp.affected_trace_count === 1 ? '' : 's'}${gloss ? ' ' + gloss : ''}`
        : gloss
          ? ` — ${gloss}`
          : '';
      lines.push(`- ${label} (${mdText(d.grade, 40)}) → **${safeDisposition}**${cnt}`);
    }
    lines.push('');
  }

  // Behavioral verification. When the Action ran a call-replay (behavioral-check
  // != off), show its result. Otherwise — behavioral-check is off (the default)
  // — surface an honest nudge IF the diff has a model change, with no fabricated
  // changed-count. Sits under the verdict + training-data policy, above
  // downstream impact.
  if (callReplay) {
    lines.push(...formatBehavioral(callReplay));
  } else {
    lines.push(...formatBehavioralNudge(report));
  }

  // Downstream impact rows. Each conditional — only renders if the
  // corresponding count is non-zero. Backends predating the downstream-impact
  // layer omit `downstream_impact` entirely, so this section is silent there.
  const di = report.downstream_impact;
  if (di) {
    const rows: string[] = [];
    if (di.evaluators.stale_count > 0) {
      const sample =
        di.evaluators.sample_evaluator_names.length > 0
          ? ` (e.g., ${di.evaluators.sample_evaluator_names
              .slice(0, 2)
              .map((n) => mdText(n, 60))
              .join(', ')})`
          : '';
      rows.push(
        `- **Evaluator impact:** ${di.evaluators.stale_count} stale${sample}`,
      );
    }
    if (di.datasets.affected_dataset_version_count > 0) {
      const rows_note =
        di.datasets.total_rows_invalidated > 0
          ? ` (${fmt(di.datasets.total_rows_invalidated)} rows)`
          : '';
      rows.push(
        `- **Dataset impact:** ${di.datasets.affected_dataset_version_count} version${di.datasets.affected_dataset_version_count === 1 ? '' : 's'} partly invalidated${rows_note}`,
      );
    }
    if (di.subagents.broken_handoffs.length > 0) {
      const samples = di.subagents.broken_handoffs
        .slice(0, 2)
        .map((h) => `\`${mdCode(h.subagent_name, 60)}\``)
        .join(', ');
      rows.push(
        `- **Sub-agent impact:** ${di.subagents.broken_handoffs.length} handoff${di.subagents.broken_handoffs.length === 1 ? '' : 's'} affected (${samples})`,
      );
    }
    if (di.skills.affected_agent_count > 0) {
      const skills =
        di.skills.skills_changed.length > 0
          ? ` (skill${di.skills.skills_changed.length === 1 ? '' : 's'}: ${di.skills.skills_changed
              .slice(0, 2)
              .map((s) => mdText(s, 60))
              .join(', ')})`
          : '';
      rows.push(
        `- **Skill impact:** ${di.skills.affected_agent_count} agent${di.skills.affected_agent_count === 1 ? '' : 's'} affected${skills}`,
      );
    }
    if (rows.length > 0) {
      lines.push('**Downstream impact:**');
      lines.push(...rows);
      lines.push('');
    }
  }

  // Report link
  const reportUrl = buildReportUrl(baseUrl, report.agent_name, report.id);
  lines.push(`[View full report →](${reportUrl})`);

  return lines.join('\n');
}

/**
 * The PR comment for a check that could not RUN — quota 429, backend 5xx,
 * network error, timeout — under `on-error: warn`.
 *
 * Carries the same MARKER as a normal comment so it replaces the previous
 * verdict in `update` mode. That matters: leaving a stale green "safe to
 * merge" from an earlier push while the current push never got checked is the
 * false green wearing a different hat. Says plainly that nothing was
 * verified, and never implies the change is safe.
 */
export function formatUnavailableComment(agentName: string, reason: string): string {
  return [
    MARKER,
    `### 🔍 Decimal Manifest Impact — \`${mdCode(agentName)}\``,
    '',
    '⚠️ **CHECK DID NOT RUN** — impact unverified',
    '',
    // `reason` carries backend error text and HTTP bodies, so it is the one
    // field an attacker can influence WITHOUT write access to the manifest —
    // by provoking an error that echoes their input back.
    `The impact check could not reach a verdict: ${mdText(reason, MAX_PROSE)}`,
    '',
    'This job was **not** failed (`on-error: warn`). Nothing about this pull ' +
      'request has been verified — treat it as unreviewed by Decimal, not as ' +
      'approved. Set `on-error: fail` to make availability problems blocking.',
  ].join('\n');
}

export interface UpsertCommentArgs {
  githubToken: string;
  body: string;
  mode: CommentMode;
}

/**
 * Post or update the regression check comment on the current PR.
 *
 * No-op when not running in a PR context (push to main, manual dispatch, etc.).
 */
export async function upsertPrComment(args: UpsertCommentArgs): Promise<void> {
  const ctx = github.context;
  const prNumber = ctx.payload.pull_request?.number;
  if (!prNumber) {
    // Not a PR — nothing to comment on. Caller still has access to job logs and outputs.
    return;
  }

  const octokit = github.getOctokit(args.githubToken);
  const { owner, repo } = ctx.repo;

  if (args.mode === 'new') {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: args.body,
    });
    return;
  }

  // mode === 'update' — find existing, else create.
  //
  // A user who previously ran with comment-mode `new` (one fresh comment per
  // push) can accumulate several of our marked comments. Switching to `update`
  // must not orphan the stale ones — otherwise the PR shows multiple,
  // contradictory verdicts. So collect ALL marked comments, update the most
  // recent in place, and delete the older duplicates.
  const existing = await findExistingComments(octokit, owner, repo, prNumber);
  if (existing.length > 0) {
    const [keep, ...stale] = existing;
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: keep,
      body: args.body,
    });
    for (const id of stale) {
      await octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: id,
      });
    }
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: args.body,
    });
  }
}

/**
 * Return the ids of every comment carrying our marker, most-recent first.
 * listComments returns oldest→newest, so the last marked comment is the one
 * we keep (update); the rest are stale duplicates to delete.
 */
async function findExistingComments(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number[]> {
  const marked: number[] = [];
  // Paginate to handle PRs with many comments
  for await (const { data: page } of octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: prNumber, per_page: 100 },
  )) {
    for (const c of page) {
      // Anchored at the start, not `includes`. We always emit the marker as
      // the first line, so anchoring costs nothing and closes two holes:
      //
      //   - GitHub's "Quote reply" copies our comment verbatim into someone
      //     else's, marker included. Under `includes`, the next run treated
      //     that human's comment as ours — overwriting it with a verdict, or
      //     deleting it outright as a stale duplicate. A reviewer quoting the
      //     gate to discuss it should not have their comment eaten.
      //   - A surface name in the PR can carry the marker text, which then
      //     appears inside our own rendered body. Inert once anchored.
      if (c.body && c.body.trimStart().startsWith(MARKER)) {
        marked.push(c.id);
      }
    }
  }
  // Most-recent first: keep [0], delete the rest.
  return marked.reverse();
}
