"""Credential-free simple web extraction backend.

This provider gives ``web_extract`` a low-dependency fallback for ordinary
public HTML/text pages when paid extraction backends are not configured or are
unavailable. It intentionally does not provide search and does not attempt
browser rendering, login, JavaScript execution, or PDF OCR.
"""

from __future__ import annotations

from .provider import SimpleExtractWebProvider


def register(ctx) -> None:
    """Register the simple extraction provider with Hermes."""

    ctx.register_web_search_provider(SimpleExtractWebProvider())
