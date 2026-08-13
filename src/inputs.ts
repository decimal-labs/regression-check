/**
 * Input parsing + validation for the Decimal regression-check Action.
 */

import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

export type FailOn = 'high' | 'medium' | 'none';
export type CommentMode = 'update' | 'new';
export type BehavioralCheck = 'off' | 'mock' | 'real';
/**
 * What to do when the check could not RUN — quota 429, backend 5xx, network
 * error, timeout. `warn` posts a degraded PR comment and exits 0; `fail` reds
 * the job (opt-in blocking).
 * Misconfiguration (401/403/400/404) is always fatal under both — see
 * isTransientApiFailure in api.ts.
 */
export type OnError = 'warn' | 'fail';

export interface ActionInputs {
  apiKey: string;
  agentName: string;
  candidateManifestId: string;
  baseUrl: string;
  failOn: FailOn;
  commentMode: CommentMode;
  traceWindowDays: number;
  behavioralCheck: BehavioralCheck;
  onError: OnError;
  /**
   * Token for the PR-comment client. Resolved from the `github-token` input
   * (which defaults to ${{ github.token }} in action.yml) and, for backward
   * compatibility, falls back to the GITHUB_TOKEN / GH_TOKEN env vars. Empty
   * string when no token is available — the comment step is then skipped.
   */
  githubToken: string;
}

const FAIL_ON_VALUES: FailOn[] = ['high', 'medium', 'none'];
const COMMENT_MODE_VALUES: CommentMode[] = ['update', 'new'];
const BEHAVIORAL_CHECK_VALUES: BehavioralCheck[] = ['off', 'mock', 'real'];
const ON_ERROR_VALUES: OnError[] = ['warn', 'fail'];

export function parseInputs(): ActionInputs {
  const apiKey = core.getInput('api-key', { required: true });
  // Register the key for log masking regardless of how the
  // caller supplied it — values from vars.*/matrix/literals are NOT auto-masked like
  // secrets.* are, so without this an error body or future log line could print it in
  // plaintext in the (publicly readable, ~90-day) Action log.
  if (apiKey) core.setSecret(apiKey);
  const agentName = core.getInput('agent-name', { required: true });

  const failOnRaw = (core.getInput('fail-on') || 'high').toLowerCase();
  if (!FAIL_ON_VALUES.includes(failOnRaw as FailOn)) {
    throw new Error(
      `Invalid fail-on value '${failOnRaw}'. Must be one of: ${FAIL_ON_VALUES.join(', ')}`,
    );
  }

  const commentModeRaw = (core.getInput('comment-mode') || 'update').toLowerCase();
  if (!COMMENT_MODE_VALUES.includes(commentModeRaw as CommentMode)) {
    throw new Error(
      `Invalid comment-mode value '${commentModeRaw}'. Must be one of: ${COMMENT_MODE_VALUES.join(', ')}`,
    );
  }

  const traceWindowDaysRaw = core.getInput('trace-window-days') || '30';
  // Strict integer check — parseInt would silently accept '30days' -> 30.
  if (!/^\d+$/.test(traceWindowDaysRaw)) {
    throw new Error(
      `Invalid trace-window-days '${traceWindowDaysRaw}'. Must be a positive integer.`,
    );
  }
  const traceWindowDays = parseInt(traceWindowDaysRaw, 10);
  if (Number.isNaN(traceWindowDays) || traceWindowDays < 1) {
    throw new Error(
      `Invalid trace-window-days '${traceWindowDaysRaw}'. Must be a positive integer.`,
    );
  }
  if (traceWindowDays > 365) {
    throw new Error(
      `Invalid trace-window-days '${traceWindowDaysRaw}'. Must be 365 or fewer.`,
    );
  }

  const explicitId = core.getInput('candidate-manifest-id');
  const candidateManifestId = explicitId || resolveCandidateManifestId();
  if (!candidateManifestId) {
    throw new Error(
      'No candidate-manifest-id provided or discoverable. ' +
        'Either pass it explicitly or run decimalai.flush_manifest_for_ci() ' +
        'in a prior step to write decimal_manifest_id to $GITHUB_OUTPUT.',
    );
  }

  const baseUrl = (core.getInput('base-url') || 'https://api.decimal.ai').replace(/\/$/, '');

  // PR-comment token. The `github-token` input defaults to ${{ github.token }}
  // in action.yml, so this works by default once the workflow grants
  // `pull-requests: write`. Fall back to GITHUB_TOKEN / GH_TOKEN for callers
  // who wired the token via env before this input existed.
  const githubToken =
    core.getInput('github-token') ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';

  const behavioralRaw = (core.getInput('behavioral-check') || 'off').toLowerCase();
  if (!BEHAVIORAL_CHECK_VALUES.includes(behavioralRaw as BehavioralCheck)) {
    throw new Error(
      `Invalid behavioral-check value '${behavioralRaw}'. Must be one of: ${BEHAVIORAL_CHECK_VALUES.join(', ')}`,
    );
  }

  // Defaults to `warn` — a failure to REACH the check (5xx, network error,
  // timeout, monthly-quota 429) is not a regression in the caller's code, so
  // it must not red every open PR in their repo. `fail` opts back in to
  // blocking behaviour for teams that want the check to gate merges even when
  // it could not run.
  const onErrorRaw = (core.getInput('on-error') || 'warn').toLowerCase();
  if (!ON_ERROR_VALUES.includes(onErrorRaw as OnError)) {
    throw new Error(
      `Invalid on-error value '${onErrorRaw}'. Must be one of: ${ON_ERROR_VALUES.join(', ')}`,
    );
  }

  return {
    apiKey,
    agentName,
    candidateManifestId,
    baseUrl,
    failOn: failOnRaw as FailOn,
    commentMode: commentModeRaw as CommentMode,
    traceWindowDays,
    behavioralCheck: behavioralRaw as BehavioralCheck,
    onError: onErrorRaw as OnError,
    githubToken,
  };
}

/**
 * Resolve the candidate manifest ID from the standard locations.
 * Mirrors the Python CLI's _resolve_candidate_manifest_id() logic.
 *
 * Priority:
 *   1. $GITHUB_OUTPUT (decimal_manifest_id=<id> line, written by flush_manifest_for_ci)
 *   2. <cwd>/decimal_manifest_id.txt (whole file is the ID)
 *
 * @param cwd Working directory to look for the fallback file. Defaults to
 *   process.cwd(). Exposed as an arg primarily for testability — tests can
 *   pass a tmp dir without mutating global process state.
 */
export function resolveCandidateManifestId(cwd: string = process.cwd()): string {
  const ghOutput = (process.env.GITHUB_OUTPUT || '').trim();
  if (ghOutput && fs.existsSync(ghOutput)) {
    const lines = fs.readFileSync(ghOutput, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.startsWith('decimal_manifest_id=')) {
        return line.substring('decimal_manifest_id='.length).trim();
      }
    }
  }

  const fallback = path.join(cwd, 'decimal_manifest_id.txt');
  if (fs.existsSync(fallback)) {
    const text = fs.readFileSync(fallback, 'utf-8').trim();
    if (text) return text;
  }

  return '';
}
