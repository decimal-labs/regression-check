# Demo Agent (in-tree smoke test)

This directory is the integration-test fixture for the `regression-check`
GitHub Action. It's a minimal "agent" — really just a manifest spec — that the
repo's own CI exercises on every PR (the `dogfood` job in
`.github/workflows/ci.yml`) to make sure the manifest-extraction path keeps
working. It is **not** shipped to customers; it's how we keep the Action
honest against a real agent definition.

## What this is

A throwaway agent whose only job is to produce a manifest the Action can diff:

```
PR opened
  → ci.yml `dogfood` job runs scripts/init_for_decimal.py (manifest_only mode)
  → the DecimalAI SDK extracts tools/prompts/models and uploads a candidate manifest
```

The `dogfood` job only exercises **manifest extraction** (it uploads a
candidate manifest when `DECIMAL_API_KEY` is configured, and skips otherwise).
To see a full impact-report comment, wire the published Action into a real
agent repo as shown in the top-level [`README.md`](../README.md) quick start.

## Files

| File | Purpose |
|---|---|
| `agent.py` | **Explicit-args variant** — `TOOLS`/`PROMPTS`/`MODELS` as plain Python dicts. The path for customers without a framework integration. |
| `langchain_agent.py` | **LangChain-introspection variant** — real `langchain-core` objects (`StructuredTool`, `ChatPromptTemplate`). The path for customers using LangChain. |
| `__init__.py` | Re-exports `build_agent` from `agent.py`. |
| `../scripts/init_for_decimal.py` | CI entry point for the explicit-args variant. Calls `flush_manifest_for_ci(tools=..., prompts=..., models=...)`. |
| `../scripts/init_for_decimal_langchain.py` | Manual entry point for the LangChain variant. Calls `flush_manifest_for_ci(chain=...)` and lets the SDK introspect the chain. |
| `../action.yml` + `../dist/index.js` | The Action itself — this repo root **is** the Action (`uses: decimal-labs/regression-check@v1`). |
| `../.github/workflows/ci.yml` | Repo CI — builds + tests the Action, then runs the `dogfood` manifest-extraction step against this demo agent. |

## Which extraction path is right for you?

Both files produce the same manifest output. Use this tree to pick the one
that matches your project:

```
Are you using LangChain (or a LangChain-shaped agent) in production?
  │
  ├─ YES ──►  Use the introspection path.
  │           file: langchain_agent.py
  │           CI script: scripts/init_for_decimal_langchain.py
  │           Why: SDK reads .tools / .llm / .prompt directly from your real
  │                LangChain objects, so the manifest stays in sync as the
  │                agent code changes. Less boilerplate.
  │
  └─ NO ───►  Are you using OpenAI Agents SDK, CrewAI, LlamaIndex, or AutoGen?
              │
              ├─ YES ──►  Those frameworks have their own install() integrations
              │           that auto-extract manifests at runtime. This demo
              │           covers the two paths shown here; framework-
              │           specific setup lives in the customer docs at
              │           docs.decimal.ai.
              │
              └─ NO ───►  Use the explicit-args path.
                          file: agent.py
                          CI script: scripts/init_for_decimal.py
                          Why: No framework dependency. You hand-build TOOLS,
                               PROMPTS, MODELS as plain Python dicts and
                               pass them to flush_manifest_for_ci(...).
                               Works in any CI environment.
```

**Summary:** introspection if you're on LangChain, explicit-args otherwise.
The explicit-args path is exercised on every PR (the `dogfood` job in
`ci.yml`); the LangChain variant is run manually.

## What "intentional changes" look like

Some example diffs that should produce specific verdicts (assuming a baseline
manifest exists for `decimalai-demo-agent`):

- **Remove a tool from `TOOLS`** → 🔴 HIGH RISK (any historical traces that called it will break)
- **Add a required parameter** to a tool's `schema.required` list → 🔴 HIGH RISK
- **Add an optional parameter** (in properties but NOT in required) → 🟢 LOW RISK
- **Change the `system` prompt text** → 🟡 MEDIUM RISK (prompt-section rewrite)
- **Change `MODELS["default"]["model"]`** → 🟡 MEDIUM RISK (model swap; structural reasoning can only flag, not predict direction)
- **Add a brand-new tool** → 🟢 LOW RISK (no historical traces affected)

## Local smoke test (no GitHub needed)

Run the extraction + regression check against a DecimalAI backend on
`:8000` (local dev or `https://api.decimal.ai`):

```bash
# Requires the DecimalAI backend reachable (e.g. local dev on :8000).
DECIMALAI_MODE=manifest_only \
  DECIMAL_API_KEY=dai_sk_test_key_001 \
  DECIMAL_BASE_URL=http://localhost:8000 \
  python scripts/init_for_decimal.py

# Then call the regression check directly via the CLI
DECIMAL_BASE_URL=http://localhost:8000 \
  decimalai regression-check --agent-name decimalai-demo-agent --api-key dai_sk_test_key_001
```

The first run records the candidate as the baseline ("first run — baseline
recorded"); a second run after editing one of the surfaces in `agent.py`
produces a real impact verdict.
