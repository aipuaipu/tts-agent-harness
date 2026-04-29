"""Normalize author-friendly script inputs into canonical ``script.json``.

The downstream pipeline already depends on the existing JSON contract:

    {"title": "...", "segments": [{"id": 1, "text": "..."}]}

This module keeps that contract stable while accepting easier authoring
surfaces such as ``.txt``, ``.md`` and pasted text.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

SourceFormat = Literal["json", "markdown", "text"]

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
_FRONTMATTER_TITLE_RE = re.compile(r"^\s*title\s*:\s*(.+?)\s*$", re.IGNORECASE)
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*$")
_BULLET_RE = re.compile(r"^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)(.*)$")
_HRULE_RE = re.compile(r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_CODE_RE = re.compile(r"`([^`]*)`")
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_INLINE_MARK_RE = re.compile(r"(\*\*|__|\*|_|~~)")


@dataclass(frozen=True)
class ImportedScript:
    script: dict[str, Any]
    source_format: SourceFormat
    suggested_title: str | None = None


def import_script(
    raw: bytes | str,
    *,
    filename: str | None = None,
    content_type: str | None = None,
) -> ImportedScript:
    """Convert arbitrary script input into canonical JSON-ready structure."""

    if isinstance(raw, bytes):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError(f"script must be UTF-8 text: {exc}") from exc
    else:
        text = raw

    source_format = detect_source_format(
        text,
        filename=filename,
        content_type=content_type,
    )
    if source_format == "json":
        return _import_json(text)
    return _import_text(text, source_format=source_format)


def detect_source_format(
    text: str,
    *,
    filename: str | None = None,
    content_type: str | None = None,
) -> SourceFormat:
    lower_name = (filename or "").lower()
    lower_content_type = (content_type or "").lower()
    stripped = text.lstrip()

    if lower_name.endswith(".json") or "application/json" in lower_content_type:
        return "json"
    if lower_name.endswith(".md") or lower_name.endswith(".markdown"):
        return "markdown"
    if "text/markdown" in lower_content_type:
        return "markdown"
    if stripped.startswith("{"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(parsed, dict):
                return "json"

    if _looks_like_markdown(text):
        return "markdown"
    return "text"


def _import_json(text: str) -> ImportedScript:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"script is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(
            f"script root must be a JSON object, got {type(parsed).__name__}"
        )
    title = parsed.get("title")
    return ImportedScript(
        script=parsed,
        source_format="json",
        suggested_title=title.strip() if isinstance(title, str) and title.strip() else None,
    )


def _import_text(text: str, *, source_format: SourceFormat) -> ImportedScript:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    body, frontmatter_title = _strip_frontmatter(normalized)
    title, body = _extract_leading_title(body)
    blocks = _extract_blocks(body)

    segments = [
        {"id": index, "type": "content", "text": block}
        for index, block in enumerate(blocks, start=1)
    ]

    effective_title = title or frontmatter_title
    script: dict[str, Any] = {"segments": segments}
    if effective_title:
        script["title"] = effective_title

    return ImportedScript(
        script=script,
        source_format=source_format,
        suggested_title=effective_title,
    )


def _looks_like_markdown(text: str) -> bool:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return False
    if _FRONTMATTER_RE.match(text):
        return True
    return any(
        _HEADING_RE.match(line)
        or _BULLET_RE.match(line)
        or line.lstrip().startswith("> ")
        or _FENCE_RE.match(line)
        for line in lines[:20]
    )


def _strip_frontmatter(text: str) -> tuple[str, str | None]:
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return text, None

    frontmatter = match.group(1)
    title: str | None = None
    for line in frontmatter.splitlines():
        title_match = _FRONTMATTER_TITLE_RE.match(line)
        if title_match:
            title = _clean_inline_markdown(title_match.group(1))
            break
    return text[match.end():], title or None


def _extract_leading_title(text: str) -> tuple[str | None, str]:
    lines = text.splitlines()
    title: str | None = None
    cut_index: int | None = None
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        match = _HEADING_RE.match(line)
        if match and len(match.group(1)) == 1:
            title = _clean_inline_markdown(match.group(2))
            cut_index = index
        break

    if cut_index is None:
        return None, text

    remaining = lines[:cut_index] + lines[cut_index + 1 :]
    return title or None, "\n".join(remaining)


def _extract_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    paragraph_lines: list[str] = []
    list_item_lines: list[str] | None = None
    in_fence = False

    def flush_paragraph() -> None:
        nonlocal paragraph_lines
        block = _normalize_block(paragraph_lines)
        if block:
            blocks.append(block)
        paragraph_lines = []

    def flush_list_item() -> None:
        nonlocal list_item_lines
        if list_item_lines is None:
            return
        block = _normalize_block(list_item_lines)
        if block:
            blocks.append(block)
        list_item_lines = None

    for raw_line in text.splitlines():
        if _FENCE_RE.match(raw_line):
            flush_paragraph()
            flush_list_item()
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        line = raw_line.strip()
        if not line:
            flush_paragraph()
            flush_list_item()
            continue
        if _HRULE_RE.match(line):
            flush_paragraph()
            flush_list_item()
            continue

        heading = _HEADING_RE.match(raw_line)
        if heading:
            flush_paragraph()
            flush_list_item()
            continue

        bullet = _BULLET_RE.match(raw_line)
        if bullet:
            flush_paragraph()
            flush_list_item()
            list_item_lines = [_strip_block_prefixes(bullet.group(1))]
            continue

        if list_item_lines is not None and raw_line.startswith((" ", "\t")):
            list_item_lines.append(_strip_block_prefixes(raw_line))
            continue

        flush_list_item()
        paragraph_lines.append(_strip_block_prefixes(raw_line))

    flush_paragraph()
    flush_list_item()
    return blocks


def _strip_block_prefixes(line: str) -> str:
    return re.sub(r"^\s{0,3}>\s?", "", line).strip()


def _normalize_block(lines: list[str]) -> str:
    cleaned = [_clean_inline_markdown(line) for line in lines if line.strip()]
    joined = "\n".join(part for part in cleaned if part)
    return re.sub(r"[ \t]+", " ", joined).strip()


def _clean_inline_markdown(text: str) -> str:
    text = _HTML_COMMENT_RE.sub("", text)
    text = _IMAGE_RE.sub(lambda match: match.group(1).strip(), text)
    text = _LINK_RE.sub(lambda match: match.group(1).strip(), text)
    text = _CODE_RE.sub(lambda match: match.group(1), text)
    text = _INLINE_MARK_RE.sub("", text)
    return text.strip()


__all__ = ["ImportedScript", "SourceFormat", "detect_source_format", "import_script"]
