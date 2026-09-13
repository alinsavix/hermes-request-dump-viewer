from __future__ import annotations

import re
from pathlib import Path

INDEX = Path(__file__).parents[1] / "dashboard" / "dist" / "index.js"
STYLE = Path(__file__).parents[1] / "dashboard" / "dist" / "style.css"


def _compact(value: str) -> str:
    return re.sub(r"\s+", " ", value)


def _compact_css(value: str) -> str:
    value = _compact(value)
    return re.sub(r"\s*([:;,{}()])\s*", r"\1", value)


def test_tool_call_only_messages_do_not_render_an_empty_content_placeholder():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "const emptyToolCallContent = calls.length > 0" in source
    assert "emptyToolCallContent ? null : h(Content" in source


def test_analysis_tabs_and_components_are_registered():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    for component in ("function Composition", "function PromptMap"):
        assert component in source
    assert '"Tool flow ("' not in source
    assert 'tab === "flow"' not in source
    assert "d.previous_sequence == null" in source
    assert "the previous request" in source
    assert 'className: "rdv-diff-request-link"' in source
    assert "props.onSelect(d.previous_file)" in source
    assert 'unchanged prefix messages compared with ", h("code"' not in source
    assert 'h("code", null, "Compared with "' not in source


def test_session_outcome_is_appended_to_messages_not_a_separate_tab():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "function OutcomeMessage" in source
    assert 'api("/sessions/"' in source
    assert '"/outcome"' in source
    assert "Stored session outcome" in source
    assert "Not part of the provider request" in source
    assert '["outcome", "Outcome"]' not in source


def test_tool_results_use_the_same_summary_style_as_tool_calls():
    script = _compact(INDEX.read_text(encoding="utf-8"))
    style = _compact_css(STYLE.read_text(encoding="utf-8"))
    assert "message._tool_call ? toolHeader(message._tool_call)" in script
    assert "rdv-tool-name" not in script
    assert "rdv-tool-name" not in style


def test_collapsed_tool_results_reuse_the_matching_call_header():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "toolHeader(message._tool_call)" in source


def test_encrypted_reasoning_hides_only_an_immediately_following_empty_assistant():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "function collapseReasoningFollowups(messages)" in source
    assert "encryptedReasoning" in source
    assert "emptyFollowup" in source
    assert "const displayMessages = collapseReasoningFollowups(detail.messages);" in source
    assert "const visible = displayMessages.filter" in source


def test_analysis_views_have_dedicated_styles():
    source = _compact_css(STYLE.read_text(encoding="utf-8"))
    for selector in (".rdv-composition-bar", ".rdv-prompt-section", ".rdv-flow-card", ".rdv-flow-connector"):
        assert selector in source
    assert ".rdv-tabs button.active" in source
    assert "font-weight:700" in source


def test_overview_is_the_default_detail_view():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "function Overview" in source
    assert 'useState("overview")' in source
    assert '["overview", "Overview"]' in source


def test_session_timeline_navigation_is_registered():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "function Timeline" in source
    assert 'api("/sessions/"' in source
    assert "previous_file" in source
    assert "next_file" in source


def test_sidebar_supports_collapse_resize_and_mobile_drawer():
    script = _compact(INDEX.read_text(encoding="utf-8"))
    style = _compact_css(STYLE.read_text(encoding="utf-8"))
    assert "rdv-sidebar-toggle" in script
    assert "rdv-resize-handle" in script
    assert "--rdv-list-width" in script
    assert ".rdv-page.is-list-hidden" in style
    assert ".rdv-mobile-backdrop" in style


def test_diff_effect_does_not_depend_on_loading_state():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert "[props.name, tab, diff, diffLoading]" not in source
    assert "[props.name, tab, diff]" in source


def test_message_summary_collapses_actual_whitespace():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    assert 'replace(/\\s+/g, " ")' in source
    assert 'replace(/\\\\s+/g, " ")' not in source


def test_raw_download_requires_explicit_sensitive_data_confirmation():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    confirm_at = source.index("window.confirm")
    raw_fetch_at = source.index('api("/dumps/"', confirm_at)
    assert confirm_at < raw_fetch_at
    assert "unredacted" in source[confirm_at:raw_fetch_at].lower()


def test_page_height_prefers_dynamic_viewport_with_fallback():
    source = _compact_css(STYLE.read_text(encoding="utf-8"))
    fallback = "height:calc(100vh - var(--header-height,0px))"
    preferred = "height:calc(100dvh - var(--header-height,0px))"
    assert fallback in source
    assert preferred in source
    assert source.index(fallback) < source.index(preferred)


def test_investigator_conveniences_are_available():
    source = _compact(INDEX.read_text(encoding="utf-8"))
    for marker in (
        "copyText",
        "Copy JSONPath",
        "Expand all",
        "Collapse all",
        "Download redacted",
        "Download raw",
        "encrypted reasoning",
        "estimatedSchemaCharacters",
        "URLSearchParams",
        "keydown",
    ):
        assert marker in source
