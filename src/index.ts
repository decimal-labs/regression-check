/**
 * Decimal regression-check Action — main entry point.
 *
 * Flow:
 *   1. Parse inputs
 *   2. Resolve candidate manifest ID (from input or $GITHUB_OUTPUT or local file)
 *   3. Build PR context from github.context
 *   4. POST /api/v1/regression-check
 *   5. Format + upsert the PR comment
 *   6. Set Action outputs
 *   7. Exit code: 0 if verdict < fail-on threshold, 1 otherwise
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  isTransientApiFailure,
  runRegressionCheck,
  runCallReplay,
  buildReportUrl,
  CallReplayResult,
  PrContext,
  Severity,
  Verdict,
} from './api';
import { formatComment, formatUnavailableComment, upsertPrComment } from './comment';
import { parseInputs, FailOn } from './inputs';

const VERDICT_RANK: Record<Verdict, number> = {
  no_change: 0,
  first_run: 0,
  low_risk: 1,
  medium_risk: 2,
  high_risk: 3,
  // Placeholder only. `unverified` has no trace-derived severity of its
  // own — shouldFail substitutes the diff's severity before this is read.
  unverified: 0,
};

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const FAIL_ON_RANK: Record<FailOn, number> = {
  none: Infinity, // never fails
  high: 3,
  medium: 2,
};

/**
 * `unverified` is ranked by the severity of the manifest DIFF, not by an
 * affected-trace count it does not have.
 *
 * Giving `unverified` a fixed rank would just move the problem: too low and a
 * deleted tool still merges green; too high and a one-line prompt tweak with
 * no traffic reds the job. Inheriting the diff's severity means the gate
 * reacts to what actually changed, and `fail-on: high` (the default) still
 * fails on the tool deletion.
 *
 * When `structuralSeverity` is absent — a backend old enough not to send it,
 * which cannot mint `unverified` anyway — fall back to low: warn, never
 * invent a failure the server never claimed.
 */
function shouldFail(
  verdict: Verdict,
  failOn: FailOn,
  structuralSeverity?: Severity | null,
): boolean {
  const rank =
    verdict === 'unverified'
      ? structuralSeverity
        ? SEVERITY_RANK[structuralSeverity]
        : SEVERITY_RANK.low
      : VERDICT_RANK[verdict];
  return rank >= FAIL_ON_RANK[failOn];
}

function buildPrContext(): PrContext {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    return {
      repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
      commit_sha: ctx.sha,
    };
  }
  const head = pr.head as { ref?: string; sha?: string } | undefined;
  return {
    repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
    pr_number: pr.number,
    branch: head?.ref || null,
    commit_sha: head?.sha || ctx.sha,
  };
}

async function main(): Promise<void> {
  let inputs;
  try {
    inputs = parseInputs();
  } catch (e) {
    core.setFailed(`Input error: ${(e as Error).message}`);
    return;
  }

  core.info(`Running regression check for agent='${inputs.agentName}' candidate='${inputs.candidateManifestId}'`);

  const githubTokenForComment = inputs.githubToken;
  if (githubTokenForComment) core.setSecret(githubTokenForComment); // mask the token in Action logs

  let report;
  try {
    report = await runRegressionCheck({
      baseUrl: inputs.baseUrl,
      apiKey: inputs.apiKey,
      agentName: inputs.agentName,
      candidateManifestId: inputs.candidateManifestId,
      prContext: buildPrContext(),
      traceWindowDays: inputs.traceWindowDays,
    });
  } catch (e) {
    const reason = (e as Error).message;
    // A transient failure to RUN the check — a 5xx, a network blip, a
    // rate-limit 429 — is not a regression in the caller's code. Under
    // `on-error: warn` it must leave the job green and report `unavailable`;
    // only a verdict the server actually returned may reach shouldFail(), so
    // `fail-on: none` stays advisory.
    if (isTransientApiFailure(e) && inputs.onError === 'warn') {
      core.warning(`Impact check unavailable — ${reason}`);
      // Outputs still get set so downstream steps branch on a real value
      // rather than an empty string.
      core.setOutput('verdict', 'unavailable');
      core.setOutput('high-risk-count', '0');
      core.setOutput('medium-risk-count', '0');
      core.setOutput('low-risk-count', '0');
      if (githubTokenForComment) {
        try {
          await upsertPrComment({
            githubToken: githubTokenForComment,
            body: formatUnavailableComment(inputs.agentName, reason),
            mode: inputs.commentMode,
          });
        } catch (commentErr) {
          core.warning(
            `Failed to upsert PR comment: ${(commentErr as Error).message}`,
          );
        }
      }
      return; // exit 0 — advisory, per on-error: warn
    }
    core.setFailed(`Regression check failed: ${reason}`);
    return;
  }

  // Set outputs
  core.setOutput('verdict', report.verdict);
  core.setOutput('high-risk-count', String(report.high_risk_count));
  core.setOutput('medium-risk-count', String(report.medium_risk_count));
  core.setOutput('low-risk-count', String(report.low_risk_count));
  core.setOutput('regression-check-id', report.id);
  core.setOutput('report-url', buildReportUrl(inputs.baseUrl, inputs.agentName, report.id));

  // Log a summary regardless of PR context
  core.info(
    `Verdict: ${report.verdict.toUpperCase()} | ` +
      `HIGH=${report.high_risk_count} MEDIUM=${report.medium_risk_count} LOW=${report.low_risk_count}`,
  );
  core.info(report.verdict_message);

  // Behavioral verification (opt-in). Re-issues recorded model calls against
  // the candidate model when behavioral-check != off AND the diff has a model
  // change. Informational only — never fails the action.
  let callReplay: CallReplayResult | undefined;
  if (inputs.behavioralCheck !== 'off') {
    const hasModelChange = (report.diff_summary?.changes || []).some(
      (c) => c.type === 'model_changed',
    );
    if (hasModelChange) {
      try {
        callReplay = await runCallReplay({
          baseUrl: inputs.baseUrl,
          apiKey: inputs.apiKey,
          regressionCheckId: report.id,
          mode: inputs.behavioralCheck === 'real' ? 'real' : 'mock',
          judge: inputs.behavioralCheck === 'real',
        });
        core.info(
          `Behavioral verification (${callReplay.mode}): ${callReplay.status}` +
            (callReplay.summary
              ? ` — ${callReplay.summary.replayed} replayed, ${callReplay.summary.changed} changed`
              : ''),
        );
      } catch (e) {
        core.warning(`Behavioral verification failed: ${(e as Error).message}`);
      }
    } else {
      core.info('behavioral-check requested but the diff has no model change — skipping.');
    }
  }

  // Post / update the PR comment (no-op outside PR context). The token comes
  // from the `github-token` input (defaults to ${{ github.token }}) with an
  // env fallback — see parseInputs().
  const githubToken = githubTokenForComment;
  if (githubToken) {
    try {
      await upsertPrComment({
        githubToken,
        body: formatComment(report, inputs.baseUrl, callReplay),
        mode: inputs.commentMode,
      });
    } catch (e) {
      // Comment failures should not fail the action — the regression check
      // itself succeeded and the result is in outputs + logs.
      core.warning(`Failed to upsert PR comment: ${(e as Error).message}`);
    }
  } else {
    core.info('GITHUB_TOKEN not present — skipping PR comment post.');
  }

  // Exit code per fail-on policy
  if (shouldFail(report.verdict, inputs.failOn, report.structural_severity)) {
    core.setFailed(
      `Verdict '${report.verdict}' meets fail-on threshold '${inputs.failOn}'. ${report.verdict_message}`,
    );
  }
}

/**
 * The Action only needs the run STARTED — node keeps the process alive until
 * the promise settles. It is exported so tests can await completion instead
 * of racing it: the `on-error` behaviour is a wiring property (does the catch
 * block call setFailed, or degrade to a warning?), and a test that only
 * exercises the pure classifier would pass with the wiring reverted.
 */
export const _completed = main().catch((e) => {
  core.setFailed(`Unexpected error: ${(e as Error).stack || (e as Error).message}`);
});

// Export for testing
export { shouldFail, buildPrContext };
