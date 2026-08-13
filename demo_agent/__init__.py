"""Demo agent for DecimalAI dogfooding.

Used by the `dogfood` job in `.github/workflows/ci.yml` to exercise the
manifest-extraction flow against this repo.

This is NOT a production agent. It's a minimal manifest source that:
- Has a stable shape (tools, prompts, models) we can intentionally evolve
- Doesn't require external LLM API keys (registers via flush_manifest_for_ci)
- Lives in the repo so a real PR against it surfaces a real impact report
"""

from .agent import build_agent  # noqa: F401
