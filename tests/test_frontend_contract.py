from __future__ import annotations

import unittest
from pathlib import Path


INDEX = Path(__file__).parents[1] / "dashboard" / "dist" / "index.js"
STYLE = Path(__file__).parents[1] / "dashboard" / "dist" / "style.css"


class FrontendContractTests(unittest.TestCase):
    def test_analysis_tabs_and_components_are_registered(self):
        source = INDEX.read_text(encoding="utf-8")
        for component in ("function Composition", "function PromptMap", "function ToolFlow"):
            self.assertIn(component, source)
        for tab in ('["overview", "Overview"]', '["prompt", "Prompt map', '["flow", "Tool flow'):
            self.assertIn(tab, source)

    def test_session_outcome_is_appended_to_messages_not_a_separate_tab(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("function OutcomeMessage", source)
        self.assertIn('api("/sessions/"', source)
        self.assertIn(' + "/outcome")', source)
        self.assertIn("Stored session outcome", source)
        self.assertIn("Not part of the provider request", source)
        self.assertNotIn('["outcome", "Outcome"]', source)

    def test_tool_result_name_uses_plain_bold_text(self):
        script = INDEX.read_text(encoding="utf-8")
        style = STYLE.read_text(encoding="utf-8")
        self.assertIn('className: "rdv-tool-name"', script)
        self.assertIn(".rdv-tool-name{font:inherit;font-weight:700;background:transparent", style)

    def test_collapsed_tool_results_reuse_the_matching_call_header(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("toolHeader(message._tool_call)", source)

    def test_encrypted_reasoning_hides_only_an_immediately_following_empty_assistant(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("function collapseReasoningFollowups(messages)", source)
        self.assertIn("encryptedReasoning", source)
        self.assertIn("emptyFollowup", source)
        self.assertIn("const displayMessages = collapseReasoningFollowups(detail.messages);", source)
        self.assertIn("const visible = displayMessages.filter", source)

    def test_analysis_views_have_dedicated_styles(self):
        source = STYLE.read_text(encoding="utf-8")
        for selector in (".rdv-composition-bar", ".rdv-prompt-section", ".rdv-flow-card", ".rdv-flow-connector"):
            self.assertIn(selector, source)

    def test_overview_is_the_default_detail_view(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("function Overview", source)
        self.assertIn('useState("overview")', source)
        self.assertIn('["overview", "Overview"]', source)

    def test_session_timeline_navigation_is_registered(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("function Timeline", source)
        self.assertIn('api("/sessions/"', source)
        self.assertIn("previous_file", source)
        self.assertIn("next_file", source)

    def test_sidebar_supports_collapse_resize_and_mobile_drawer(self):
        script = INDEX.read_text(encoding="utf-8")
        style = STYLE.read_text(encoding="utf-8")
        self.assertIn("rdv-sidebar-toggle", script)
        self.assertIn("rdv-resize-handle", script)
        self.assertIn("--rdv-list-width", script)
        self.assertIn(".rdv-page.is-list-hidden", style)
        self.assertIn(".rdv-mobile-backdrop", style)

    def test_diff_effect_does_not_depend_on_loading_state(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertNotIn("[props.name, tab, diff, diffLoading]", source)
        self.assertIn("[props.name, tab, diff]", source)

    def test_message_summary_collapses_actual_whitespace(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn(r'replace(/\s+/g, " ")', source)
        self.assertNotIn(r'replace(/\\s+/g, " ")', source)

    def test_raw_download_requires_explicit_sensitive_data_confirmation(self):
        source = INDEX.read_text(encoding="utf-8")
        confirm_at = source.index("window.confirm")
        raw_fetch_at = source.index('api("/dumps/"', confirm_at)
        self.assertLess(confirm_at, raw_fetch_at)
        self.assertIn("unredacted", source[confirm_at:raw_fetch_at].lower())

    def test_page_height_prefers_dynamic_viewport_with_fallback(self):
        source = STYLE.read_text(encoding="utf-8")
        fallback = "height:calc(100vh - var(--header-height,0px))"
        preferred = "height:calc(100dvh - var(--header-height,0px))"
        self.assertIn(fallback, source)
        self.assertIn(preferred, source)
        self.assertLess(source.index(fallback), source.index(preferred))

    def test_investigator_conveniences_are_available(self):
        source = INDEX.read_text(encoding="utf-8")
        for marker in (
            "copyText", "Copy JSONPath", "Expand all", "Collapse all",
            "Download redacted", "Download raw", "encrypted reasoning", "estimatedSchemaCharacters",
            "URLSearchParams", "keydown",
        ):
            self.assertIn(marker, source)


if __name__ == "__main__":
    unittest.main()
