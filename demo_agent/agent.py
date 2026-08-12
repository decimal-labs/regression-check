"""Demo agent definition — tools, prompts, models.

The manifest derived from this file is what the DecimalAI dogfooding
GitHub Action diffs against the baseline. To exercise the regression
check end-to-end, edit one of the surfaces below (e.g., remove a tool
or rewrite a prompt section) and open a PR.
"""

from __future__ import annotations

from typing import Any, Dict, List


# ── Tools ────────────────────────────────────────────────────────
# Edit the dict below to simulate tool changes (add/remove/schema diff).

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "search_docs",
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch_url",
        "schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "summarize",
        "schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "max_words": {"type": "integer"},
            },
            "required": ["text"],
        },
    },
]


# ── Prompts ──────────────────────────────────────────────────────

PROMPTS: Dict[str, str] = {
    "system": (
        "You are a research assistant. When asked a question, use the "
        "search_docs tool first to find relevant material, then fetch_url "
        "for any links worth expanding, and finally summarize the result. "
        "If a question requires no tools, answer directly."
    ),
}


# ── Models ───────────────────────────────────────────────────────

MODELS: Dict[str, Dict[str, Any]] = {
    "default": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.2,
    },
}


# ── Output schema ────────────────────────────────────────────────

OUTPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer"],
}


def build_agent() -> Dict[str, Any]:
    """Return the demo agent's manifest specification as a dict.

    In a real agent, this function would instantiate LangChain / OpenAI
    Agents / etc. and the SDK's framework callbacks would capture the
    manifest implicitly. For the dogfooding agent we keep things explicit
    so the CI flow has no LLM/framework dependency.

    Returns:
        Dict with `tools`, `prompts`, `models`, `output_schema` — the
        same keys `decimalai.flush_manifest_for_ci` consumes.
    """
    return {
        "tools": TOOLS,
        "prompts": PROMPTS,
        "models": MODELS,
        "output_schema": OUTPUT_SCHEMA,
    }
