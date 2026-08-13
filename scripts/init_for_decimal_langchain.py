"""Manifest-extraction entry point — LangChain introspection variant.

Sibling of `scripts/init_for_decimal.py`. Where that script passes explicit
`tools=[...], prompts={...}, models={...}` dicts to `flush_manifest_for_ci`,
this one builds a real LangChain-shaped chain and lets the SDK introspect it.

This is the path real customers using LangChain will follow — drop the
SDK in, build your agent as normal, point at the chain.

Local smoke test (no GitHub needed):

    DECIMALAI_MODE=manifest_only \\
    DECIMAL_API_KEY=dai_sk_test_key_001 \\
    DECIMAL_BASE_URL=http://localhost:8000 \\
        python scripts/init_for_decimal_langchain.py

Run manually (or wire into CI) to exercise the LangChain introspection path.
"""

from __future__ import annotations

import os
import sys

import decimalai
from demo_agent.langchain_agent import build_agent


def main() -> int:
    decimalai.init()  # picks up DECIMAL_API_KEY + DECIMALAI_MODE from env

    agent_name = os.environ.get("DEMO_AGENT_NAME", "decimalai-demo-agent-langchain")

    # Build the chain — real langchain-core objects under the hood.
    # The SDK's HTTP-client bouncer (added in the manifest_only mode fix)
    # ensures that even if instantiating the chain accidentally triggers a
    # LangChain callback, no traces escape to the production trace store.
    chain = build_agent()

    # Hand the chain to flush_manifest_for_ci; introspection extracts the
    # manifest data without invoking the chain.
    result = decimalai.flush_manifest_for_ci(
        agent_name=agent_name,
        chain=chain,
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
