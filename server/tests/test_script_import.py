from __future__ import annotations

import json

import pytest

from server.core.script_import import detect_source_format, import_script


def test_detect_source_format_prefers_filename_and_json_object() -> None:
    assert detect_source_format("{}", filename="script.json") == "json"
    assert detect_source_format('{"segments":[]}', filename=None) == "json"
    assert detect_source_format("# Title\n\nBody", filename="script.md") == "markdown"


def test_import_json_keeps_existing_contract() -> None:
    source = {"title": "Demo", "segments": [{"id": 1, "text": "Hello."}]}
    result = import_script(json.dumps(source), filename="demo.json")
    assert result.source_format == "json"
    assert result.suggested_title == "Demo"
    assert result.script == source


def test_import_markdown_uses_title_and_paragraphs_as_segments() -> None:
    result = import_script(
        "# Episode Title\n\nFirst paragraph.\nStill first shot.\n\nSecond paragraph.",
        filename="demo.md",
    )
    assert result.source_format == "markdown"
    assert result.suggested_title == "Episode Title"
    assert result.script == {
        "title": "Episode Title",
        "segments": [
            {"id": 1, "type": "content", "text": "First paragraph.\nStill first shot."},
            {"id": 2, "type": "content", "text": "Second paragraph."},
        ],
    }


def test_import_markdown_strips_common_inline_syntax() -> None:
    result = import_script(
        "---\n"
        "title: Frontmatter Title\n"
        "---\n\n"
        "- **Bold** item with [link](https://example.com)\n"
        "- `code` item\n",
        filename="demo.md",
    )
    assert result.suggested_title == "Frontmatter Title"
    assert result.script["segments"] == [
        {"id": 1, "type": "content", "text": "Bold item with link"},
        {"id": 2, "type": "content", "text": "code item"},
    ]


def test_import_text_uses_blank_lines_as_shot_boundaries() -> None:
    result = import_script("First shot.\n\nSecond shot.\n\nThird shot.")
    assert result.source_format == "text"
    assert result.suggested_title is None
    assert result.script == {
        "segments": [
            {"id": 1, "type": "content", "text": "First shot."},
            {"id": 2, "type": "content", "text": "Second shot."},
            {"id": 3, "type": "content", "text": "Third shot."},
        ]
    }


def test_import_rejects_non_object_json() -> None:
    with pytest.raises(ValueError, match="script root must be a JSON object"):
        import_script("[]", filename="bad.json")
