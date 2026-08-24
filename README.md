# Agent Regression Check — GitHub Action

**Catch agent regressions before they ship — no eval cases required.**

[![Release](https://img.shields.io/github/v/release/decimal-labs/regression-check)](https://github.com/decimal-labs/regression-check/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/decimal-labs/regression-check/ci.yml?branch=main)](https://github.com/decimal-labs/regression-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/decimal-labs/regression-check/blob/main/LICENSE)

> Part of [DecimalAI](https://decimal.ai) — most users want [decimal-labs/decimalai-python](https://github.com/decimal-labs/decimalai-python), the SDK this Action pairs with.

When you open a PR with an agent change (renamed tool, rewritten prompt, swapped model), this Action computes the structural blast radius against your last 30 days of production traces and posts a per-PR impact report:

![The impact report the Action posts as a pull request comment](https://raw.githubusercontent.com/decimal-labs/regression-check/main/docs/assets/pr-comment.png)

*Example report — the numbers above are illustrative (they come from the demo's seeded reference agent, not customer traffic). Run it yourself to get your own.*


DecimalAI uses your **production traffic as the implicit test set**. You don't need to write or maintain eval cases for the Action to catch regressions.

Want to see a report before wiring up CI? The demo runs the same check against a **seeded reference agent** — its numbers are illustrative, run it yourself:

```bash
pip install decimalai && decimalai demo regression   # ~2 min; needs a free API key (app.decimal.ai/settings)
```

---

## Quick start

### 1. Install the SDK in your agent code

```bash
pip install decimalai
```

```python
import decimalai
decimalai.init(api_key="dai_sk_...")  # or via DECIMAL_API_KEY env var
```

### 2. Add a thin init script for CI

```python
# scripts/init_for_decimal.py
"""Entry point for DecimalAI manifest extraction in CI."""
from myapp.agent import build_agent  # your existing agent factory

if __name__ == "__main__":
    build_agent()  # SDK captures the manifest. Exits.
```

### 3. Add the workflow

```yaml
# .github/workflows/decimal.yml
name: Agent Regression Check
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # to post the impact report comment
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -e .

      - name: Manifest extraction
        env:
          DECIMALAI_MODE: manifest_only
          DECIMAL_API_KEY: ${{ secrets.DECIMAL_API_KEY }}
          OPENAI_API_KEY: dummy   # placeholder, never called in manifest_only mode
        run: python scripts/init_for_decimal.py

      - name: Agent Regression Check
        uses: decimal-labs/regression-check@v1
        with:
          api-key: ${{ secrets.DECIMAL_API_KEY }}
          agent-name: support-agent
```

### 4. Add the secret

In **Settings → Secrets and variables → Actions**, add:
- `DECIMAL_API_KEY`: your key from [app.decimal.ai/settings](https://app.decimal.ai/settings)

That's it. Open a PR and the impact report shows up as a comment within ~30 seconds.

---

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | DecimalAI API key. Pull from GitHub Secrets. |
| `agent-name` | yes | — | Agent name (matches the value passed to `decimalai.init()`). |
| `github-token` | no | `${{ github.token }}` | Token used to post / update the PR impact comment. Defaults to the automatic per-job token, so the comment works out of the box once the workflow grants `pull-requests: write`. Override only for a different token (e.g. a PAT to comment on forked PRs). Falls back to the `GITHUB_TOKEN` / `GH_TOKEN` env vars if set empty. |
| `candidate-manifest-id` | no | (auto) | If omitted, reads from `$GITHUB_OUTPUT` (the standard handoff from `decimalai.flush_manifest_for_ci()`) or `./decimal_manifest_id.txt`. |
| `base-url` | no | `https://api.decimal.ai` | DecimalAI API base URL. Defaults to production. Override only if DecimalAI directs you to a different API host. |
| `fail-on` | no | `high` | When to fail the workflow: `high` (any HIGH RISK), `medium` (any MEDIUM+), or `none` (warn only). The `unverified` verdict is ranked by the severity of the manifest diff, so `fail-on: high` still fails a PR that deletes a tool on an agent with no traffic. |
| `on-error` | no | `warn` | What to do when the check could not RUN — a DecimalAI outage or 5xx, a network error, a timeout, or your plan's monthly regression-check quota (429). `warn` posts a "check did not run" comment and exits 0; `fail` reds the job. Misconfiguration (401/403 bad key, 400/404 unknown agent or manifest) is always fatal under both. |
| `comment-mode` | no | `update` | `update` (single comment, updated per push) or `new` (post fresh per push). |
| `trace-window-days` | no | `30` | How far back to look for affected traces. |
| `behavioral-check` | no | `off` | Behavioral verification for model swaps (preview). Only runs when the diff contains a model change. `off` skips it; `mock` counts how many recorded model calls are eligible to replay but spends no tokens (free); `real` re-issues a representative recorded call per affected trace against the candidate model and LLM-judges the outputs (spends tokens). |

## Outputs

| Name | Description |
|---|---|
| `verdict` | One of: `high_risk`, `medium_risk`, `low_risk`, `no_change`, `unverified`, `first_run` — or `unavailable` when the check could not run and `on-error` is `warn`. |
| `high-risk-count` | Number of HIGH RISK traces in the report. |
| `medium-risk-count` | Number of MEDIUM RISK traces. |
| `low-risk-count` | Number of LOW RISK traces. |
| `regression-check-id` | DecimalAI persisted regression check ID (for deep linking). |
| `report-url` | URL to the full report on the DecimalAI dashboard. |

## How it works

1. The previous CI step (`scripts/init_for_decimal.py`) runs your agent's existing initialization in `manifest_only` mode. The DecimalAI SDK captures tools, prompts, and models from runtime objects and uploads the manifest as a candidate.

2. This Action reads the candidate manifest ID and posts to `POST /api/v1/regression-check`. The DecimalAI backend:
   - Computes the structural diff against your agent's baseline manifest
   - For each changed surface, queries for historical production traces that depended on it
   - Classifies severity (HIGH / MEDIUM / LOW) per the impact

3. The Action formats the impact report as a markdown PR comment and upserts it on the PR.

4. Action exit code is 1 if the verdict meets the `fail-on` threshold; otherwise 0.

### When there is no traffic to measure against

The impact report answers "which of your recorded production traces depended on
what you just changed". That question has no answer if the agent has no traces
in the window — a brand-new agent, an agent you haven't instrumented yet, or
traffic older than `trace-window-days`.

In that case the verdict is **`unverified`**, not `no_change`. The two are
different claims:

| Verdict | What it means |
|---|---|
| `no_change` | We looked at real production traffic and this change touches none of it. |
| `unverified` | The manifest changed and there was **no traffic to check it against**. Nothing was verified. |

`unverified` inherits the severity of the manifest diff, so a deleted tool
fails under the default `fail-on: high` while a low-severity change only warns.
To turn `unverified` into a real verdict, instrument production with
`decimalai.init()` so the agent emits traces, or widen `trace-window-days`.

**No agent execution.** We don't run your code in CI. We only diff manifests and query the trace store. See [docs.decimal.ai/guides/regression-check](https://docs.decimal.ai/guides/regression-check) for the architectural detail.

## Permissions

The workflow needs `pull-requests: write` permission to post / update the impact comment (see the `permissions:` block in the [quick start](#3-add-the-workflow) workflow). The Action authenticates with the automatic per-job `${{ github.token }}` by default — you don't need to pass a token manually. Without the `pull-requests: write` permission, the Action runs successfully but skips the comment (everything is still in outputs + logs).

To comment on PRs from forks, or otherwise use a different identity, pass an explicit token via the `github-token` input (e.g. `github-token: ${{ secrets.MY_PAT }}`).

## First-run behavior

The first PR you open after installation has nothing to diff against. The Action records your candidate manifest as the baseline and posts a friendly comment:

> ✓ **FIRST RUN** — baseline recorded
>
> Future PRs will diff against this manifest.

Subsequent PRs get real impact reports.

## Troubleshooting

### "No candidate-manifest-id provided or discoverable"

The previous CI step (`scripts/init_for_decimal.py`) didn't write the manifest ID to `$GITHUB_OUTPUT` or `./decimal_manifest_id.txt`. Check that:
- `DECIMALAI_MODE=manifest_only` is set when running the init script
- Your init script calls `decimalai.flush_manifest_for_ci(...)` (or your `build_agent()` triggers automatic capture)
- The init step succeeded (check the step logs for errors)

### "Manifest extraction failed"

Your init script raised an exception. This is usually a setup issue — your `build_agent()` might require resources unavailable in CI (database, network services). Stub or mock those for the manifest_only path.

### "First run" comment on every PR

The baseline isn't being persisted. Make sure your production deployment is also instrumented with the SDK so it registers manifests under normal mode (not `manifest_only`).

## Development

```bash
npm install
npm run lint       # tsc --noEmit
npm test
npm run build      # generates dist/index.js (committed for Marketplace)
```

Run these yourself before opening a PR. CI runs the same four, and additionally fails if `dist/` is stale — so commit the rebuild along with your source change.

## License

[MIT](https://github.com/decimal-labs/regression-check/blob/main/LICENSE)

---

**DecimalAI** · [Docs](https://docs.decimal.ai) · [Skills Registry](https://app.decimal.ai/skills) · [Python SDK](https://github.com/decimal-labs/decimalai-python) · [agentversion](https://github.com/decimal-labs/agentversion) · [skillevaluation](https://github.com/decimal-labs/skillevaluation) · [hello@decimal.ai](mailto:hello@decimal.ai)
