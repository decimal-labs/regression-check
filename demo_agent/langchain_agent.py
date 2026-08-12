"""Demo agent built with real LangChain primitives.

This sibling to `agent.py` exercises the SDK's LangChain introspection path
(`decimalai.flush_manifest_for_ci(chain=...)`) instead of passing explicit
tools/prompts/models dicts. Validates that the runtime flow works against
real langchain-core objects, not hand-crafted test doubles.

Used by `scripts/init_for_decimal_langchain.py` for the LangChain dogfood
variant. The original `agent.py` + `init_for_decimal.py` still exists for
the explicit path — both are supported.

Note: this file imports langchain-core only. We deliberately avoid
langchain (the higher-level chain library) and langchain-openai so the
demo runs in CI environments that don't have real OpenAI keys.
"""

from __future__ import annotations

from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field


# ── Tool arg schemas ─────────────────────────────────────────────


class SearchArgs(BaseModel):
    query: str = Field(description="Search query string")
    limit: int = Field(default=10, description="Max results to return")


class FetchUrlArgs(BaseModel):
    url: str = Field(description="URL to fetch")


class SummarizeArgs(BaseModel):
    text: str = Field(description="Text to summarize")
    max_words: int = Field(default=100, description="Maximum length")


# ── Tool implementations (no-op for CI; the customer would call real APIs) ──


def _search(query: str, limit: int = 10) -> str:
    return f"search results for {query!r} (limit={limit})"


def _fetch_url(url: str) -> str:
    return f"contents of {url}"


def _summarize(text: str, max_words: int = 100) -> str:
    return text[: max_words * 7]


def make_tools() -> list[StructuredTool]:
    return [
        StructuredTool.from_function(
            func=_search,
            name="search_docs",
            description="Search the knowledge base",
            args_schema=SearchArgs,
        ),
        StructuredTool.from_function(
            func=_fetch_url,
            name="fetch_url",
            description="Fetch the contents of a URL",
            args_schema=FetchUrlArgs,
        ),
        StructuredTool.from_function(
            func=_summarize,
            name="summarize",
            description="Summarize text",
            args_schema=SummarizeArgs,
        ),
    ]


def make_prompt() -> ChatPromptTemplate:
    return ChatPromptTemplate.from_messages([
        (
            "system",
            "You are a research assistant. When asked a question, use search_docs "
            "first to find relevant material, then fetch_url for any links worth "
            "expanding, and finally summarize the result.",
        ),
        ("human", "{input}"),
    ])


class FakeModel:
    """Stand-in for a real ChatOpenAI / ChatAnthropic in CI.

    The class name is what `_infer_provider` reads to decide the provider
    label. The attributes are what `_extract_models` reads. Class name
    intentionally contains 'OpenAI' so the demo manifest looks realistic.

    In a real customer agent, this would be `ChatOpenAI(...)`, `ChatAnthropic(...)`,
    etc. — but those packages require API keys to instantiate even when they
    won't be called.
    """
    model_name = "gpt-4o"
    temperature = 0.2
    max_tokens = None


class ChatOpenAIStandin(FakeModel):
    """Class name contains 'OpenAI' so `_infer_provider` returns 'openai'."""


class DemoChain:
    """Minimal chain-shaped object the SDK's introspection can read.

    Has `tools`, `llm`, `prompt` attributes — that's all `introspect_chain`
    needs. The real customer equivalent would be the result of
    `create_react_agent(llm, tools, prompt)`.
    """
    def __init__(self):
        self.tools = make_tools()
        self.llm = ChatOpenAIStandin()
        self.prompt = make_prompt()


def build_agent() -> DemoChain:
    """Build the demo agent. Called by `scripts/init_for_decimal_langchain.py`."""
    return DemoChain()
