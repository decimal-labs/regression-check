"""CI entry point for DecimalAI manifest extraction.

Invoked by .github/workflows/decimal.yml during the manifest-extraction
step. Builds the demo agent's manifest spec and uploads it as a candidate
for the regression check that follows in the next workflow step.

Reads the agent name from the DEMO_AGENT_NAME env var (default
`decimalai-demo-agent`). The same name must be passed to the
`decimal-labs/regression-check` Action in the next workflow step.

Local smoke test (no GitHub Action needed):

    DECIMALAI_MODE=manifest_only \\
    DECIMAL_API_KEY=dai_sk_test_key_001 \\
    DECIMAL_BASE_URL=http://localhost:8000 \\
    python scripts/init_for_decimal.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# `python scripts/init_for_decimal.py` puts THIS file's directory on sys.path —
# not the working directory — so `demo_agent`, a package at the repo root, is not
# importable and the import below raises ModuleNotFoundError. Put the repo root on
# the path explicitly so the script runs the same way from any cwd, including the
# invocation this module's own docstring documents.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import decimalai  # noqa: E402  — must follow the sys.path fix above
from demo_agent import build_agent  # noqa: E402


def main() -> int:
    decimalai.init()  # picks up DECIMAL_API_KEY + DECIMALAI_MODE from env

    agent_name = os.environ.get("DEMO_AGENT_NAME", "decimalai-demo-agent")
    spec = build_agent()

    result = decimalai.flush_manifest_for_ci(
        agent_name=agent_name,
        tools=spec["tools"],
        prompts=spec["prompts"],
        models=spec["models"],
        output_schema=spec["output_schema"],
    )

    print(f"✓ Manifest registered: {result['manifest_id']}")
    print(f"  Written to: {result['output_path']}")
    if result["pr_context"]:
        pc = result["pr_context"]
        if pc.get("repo"):
            line = f"  PR context: {pc['repo']}"
            if pc.get("pr_number") is not None:
                line += f" #{pc['pr_number']}"
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
