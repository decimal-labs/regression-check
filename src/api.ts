/**
 * Thin HTTP client for the DecimalAI regression-check API.
 *
 * Mirrors the Python SDK's _client.run_regression_check() — same payload,
 * same response shape.
 */

export type Verdict =
  | 'high_risk'
  | 'medium_risk'
  | 'low_risk'
  | 'no_change'
  /**
   * The diff has ≥1 structural change and there were ZERO production traces
   * in the window to measure its blast radius against. Distinct from
   * `no_change`, which means "we looked at real traffic and this change
   * touches none of it". Before this verdict existed both cases produced
   * `no_change` / "safe to merge" / exit 0, so a PR that deleted a tool went
   * green on any agent without instrumented traffic.
   *
   * `unverified` carries no trace-derived severity — rank it by
   * `structural_severity` (see shouldFail in index.ts).
   */
  | 'unverified'
  | 'first_run';

/**
 * Eval-weighted second-axis verdict. Independent from the
 * structural `Verdict` above — surfaces whether the change touched traffic
 * that was *passing* eval (regression_likely) vs. only failing/unscored
 * traffic (expected_impact). May be undefined when talking to a backend
 * that predates the eval-aware layer; the PR comment renders the structural
 * verdict alone in that case.
 */
export type EvalVerdict =
  | 'clean'
  | 'expected_impact'
  | 'regression_likely'
  | 'first_run';

export interface EvalBreakdown {
  passing_affected: number;
  failing_affected: number;
  unscored_affected: number;
  eval_capped?: boolean;
}

export type Severity = 'high' | 'medium' | 'low';

export interface SurfaceChangeSummary {
  type: string;
  name: string | null;
  severity: Severity;
  detail?: Record<string, unknown>;
}

export interface DiffSummary {
  total_changes: number;
  high_severity_changes?: number;
  medium_severity_changes?: number;
  low_severity_changes?: number;
  changes: SurfaceChangeSummary[];
  first_run?: boolean;
}

export interface RegressionImpact {
  id: string;
  surface_change_type: string;
  surface_name: string | null;
  severity: Severity;
  affected_trace_count: number;
  sample_trace_ids: string[] | null;
  explanation: string | null;
  /** NULL for impacts persisted before the eval-aware layer landed. */
  eval_breakdown?: EvalBreakdown | null;
}

/**
 * Four downstream-impact dimensions persisted alongside the structural + eval
 * verdicts. Returned on every RegressionCheckResponse (the backend serializer
 * falls back to the default-zero shape for rows that predate the layer, so this
 * is never null on the wire).
 */
export interface DownstreamImpact {
  evaluators: {
    stale_count: number;
    sample_evaluator_names: string[];
    surfaces_causing_staleness: string[];
  };
  datasets: {
    affected_dataset_version_count: number;
    sample_dataset_names: string[];
    total_rows_invalidated: number;
  };
  subagents: {
    broken_handoffs: Array<{
      subagent_name: string;
      surface_diff: string;
    }>;
  };
  skills: {
    affected_agent_count: number;
    sample_agent_names: string[];
    skills_changed: string[];
  };
}

export interface RegressionCheckResponse {
  id: string;
  agent_name: string;
  baseline_manifest_id: string | null;
  candidate_manifest_id: string;
  status: string;
  verdict: Verdict;
  verdict_message: string;
  /**
   * Highest severity present in the manifest diff, independent of how many
   * traces it touched. Undefined when talking to a backend old enough that it
   * does not send this field — `shouldFail` then treats `unverified` as low
   * severity, i.e. it warns rather than guessing a failure the server never
   * claimed.
   */
  structural_severity?: Severity | null;
  /**
   * Server-composed one-line natural-language summary of the manifest diff.
   * May be undefined for older backends that predate the impact-report-service
   * composer; the PR comment falls back to listing raw changes when absent.
   */
  human_summary?: string;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  total_traces_analyzed: number;
  diff_summary: DiffSummary | null;
  pr_context: Record<string, unknown> | null;
  impacts?: RegressionImpact[];
  created_at: string | null;
  /**
   * Eval-weighted second-axis verdict and breakdown. NULL
   * for checks persisted before the eval-aware layer landed. The PR
   * comment renders the structural verdict only when these are absent.
   */
  eval_verdict?: EvalVerdict | null;
  eval_breakdown?: EvalBreakdown | null;
  /**
   * Downstream impact across evaluators / datasets / sub-agents / skills.
   * Optional only because backends predating the layer omit it; newer ones
   * always send the default-zero shape at minimum.
   */
  downstream_impact?: DownstreamImpact | null;
}

export interface PrContext {
  repo?: string;
  pr_number?: number | null;
  branch?: string | null;
  commit_sha?: string | null;
}

export interface RunRegressionCheckArgs {
  baseUrl: string;
  apiKey: string;
  agentName: string;
  candidateManifestId: string;
  prContext?: PrContext | null;
  traceWindowDays: number;
}

// Network timeouts (ms). The Action runs inside a CI job; a hung or slow backend must not
// stall the job until the GitHub runner's global timeout. `call-replay?mode=real` performs
// live server-side LLM calls, so it gets a larger budget than the structural check.
const REGRESSION_CHECK_TIMEOUT_MS = 60_000;
const CALL_REPLAY_TIMEOUT_MS = 180_000;

/**
 * A non-2xx response from the DecimalAI API, carrying the status code.
 *
 * The status code is the point. `runRegressionCheck` used to throw a bare
 * `Error` whose only signal was a message string, so index.ts could not tell
 * "your API key is wrong" (the customer must fix it) from "you hit the Free
 * tier's 50-checks/month quota" or "our backend 500'd" (nothing to do with the
 * PR). Everything became `core.setFailed`, which reds the job — before
 * `shouldFail` is ever consulted, so `fail-on: none` did NOT make the check
 * advisory despite the docs promising "we won't hold your PR hostage".
 */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/**
 * True when a failure says something about DecimalAI's availability rather
 * than about the customer's pull request.
 *
 * Transient (the check could not run — nothing the PR author can fix):
 *   • 429 — rate limit, or the plan's monthly regression-check quota
 *   • 5xx — our fault
 *   • network error / DNS / timeout — no `ApiHttpError` at all
 *
 * NOT transient (a real misconfiguration that must stay loud, or the run would
 * silently do nothing forever):
 *   • 401 / 403 — bad or unauthorized API key
 *   • 400 / 404 — bad agent name, missing or foreign candidate manifest
 */
export function isTransientApiFailure(err: unknown): boolean {
  if (err instanceof ApiHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  return true;
}

/** `fetch` with an AbortController deadline; turns a hang into a clear, catchable error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function runRegressionCheck(
  args: RunRegressionCheckArgs,
): Promise<RegressionCheckResponse> {
  const url = `${args.baseUrl}/api/v1/regression-check`;
  const body: Record<string, unknown> = {
    agent_name: args.agentName,
    candidate_manifest_id: args.candidateManifestId,
    trace_window_days: args.traceWindowDays,
    // Identify the GitHub Action as the source so the dashboard can
    // render a "⚙ GH Action" badge instead of inferring from pr_context.
    source: 'github_action',
  };
  if (args.prContext && Object.keys(args.prContext).length > 0) {
    body.pr_context = args.prContext;
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    REGRESSION_CHECK_TIMEOUT_MS,
  );

  if (!res.ok) {
    let detail = '';
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
      detail = JSON.stringify(parsed);
    } catch {
      detail = await res.text();
    }
    // Make a quota 429 self-explaining instead of dumping raw JSON into
    // the job log. The server's quota response already carries
    // feature/used/limit/upgrade_url — surface it.
    let message = `Regression check API error ${res.status}: ${detail}`;
    if (res.status === 429 && parsed) {
      // FastAPI wraps HTTPException(detail={...}) as {"detail": {...}}; some
      // handlers flatten it. Accept both shapes rather than guessing.
      const d = (
        parsed.detail && typeof parsed.detail === 'object' ? parsed.detail : parsed
      ) as Record<string, unknown>;
      const limit = d.limit;
      const feature = d.feature ?? 'regression_checks';
      const upgrade = d.upgrade_url;
      message =
        `Monthly quota reached for ${String(feature)}` +
        (limit != null ? ` (${String(limit)} on your plan)` : '') +
        (upgrade ? ` — upgrade at ${String(upgrade)}` : '');
    }
    throw new ApiHttpError(res.status, detail, message);
  }

  return (await res.json()) as RegressionCheckResponse;
}

// ── Behavioral call-replay (model-change verification) ────────────

export type JudgeVerdict = 'better' | 'worse' | 'equivalent' | 'unclear';

export interface CallReplaySample {
  trace_id: string | null;
  recorded: string;
  new: string;
  similarity: number;
  kind: string;
  judge_verdict?: JudgeVerdict;
  judge_reason?: string;
}

export interface CallReplaySummary {
  replayed: number;
  equivalent: number;
  changed: number;
  errors: number;
  samples: CallReplaySample[];
  judge?: Partial<Record<JudgeVerdict, number>>;
}

export type CallReplayStatus = 'ok' | 'no_model_change' | 'unsupported' | 'no_calls';

export interface CallReplayResult {
  status: CallReplayStatus;
  message: string | null;
  provider: string | null;
  target_model: string | null;
  baseline_model: string | null;
  per_trace: string;
  mode: 'mock' | 'real';
  summary: CallReplaySummary | null;
  computed_at?: string;
}

export interface RunCallReplayArgs {
  baseUrl: string;
  apiKey: string;
  regressionCheckId: string;
  mode: 'mock' | 'real';
  judge?: boolean;
}

/**
 * Behavioral verification for a check's model change: re-issue a representative
 * recorded model call per affected trace against the candidate model and diff
 * the outputs. `mode=mock` never spends tokens; `mode=real` performs live
 * same-provider calls (OpenAI/Gemini) server-side. `judge` adds the LLM-judge
 * tier on changed samples.
 */
export async function runCallReplay(args: RunCallReplayArgs): Promise<CallReplayResult> {
  const url =
    `${args.baseUrl}/api/v1/regression-check/${args.regressionCheckId}/call-replay` +
    `?mode=${args.mode}&judge=${args.judge ? 'true' : 'false'}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
    },
    CALL_REPLAY_TIMEOUT_MS,
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text();
    }
    throw new Error(`Call-replay API error ${res.status}: ${detail}`);
  }
  return (await res.json()) as CallReplayResult;
}

/**
 * Build a dashboard URL for a regression check (best-effort — derives the
 * app URL from the API base URL by replacing 'api.' with 'app.').
 */
export function buildReportUrl(
  baseUrl: string,
  agentName: string,
  regressionCheckId: string,
): string {
  let appBase = baseUrl.replace(/\/api\/?$/, '');
  try {
    const u = new URL(appBase);
    // Only rewrite a leading 'api.' in the hostname (e.g. api.decimal.ai ->
    // app.decimal.ai); leave self-hosted hosts like my-api.company.io alone.
    u.hostname = u.hostname.replace(/^api\./, 'app.');
    appBase = u.toString().replace(/\/$/, '');
  } catch {
    // Not an absolute URL — fall back to the previous best-effort behavior.
    appBase = appBase.replace(/^(https?:\/\/)?api\./, '$1app.');
  }
  return `${appBase}/agents/${encodeURIComponent(agentName)}/regression/${regressionCheckId}`;
}
