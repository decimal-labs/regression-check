"""Demo agent for DecimalAI dogfooding.

Used by `.github/workflows/decimal.yml` to exercise the regression-check
flow on the DecimalAI monorepo itself.

This is NOT a production agent. It's a minimal manifest source that:
- Has a stable shape (tools, prompts, models) we can intentionally evolve
- Doesn't require external LLM API keys (registers via flush_manifest_for_ci)
- Lives in the repo so a real PR against it surfaces a real impact report
"""

from .agent import build_agent  # noqa: F401
