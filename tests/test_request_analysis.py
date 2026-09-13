from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

MODULE_PATH = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("request_dump_viewer_api", MODULE_PATH)
api = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(api)


def sample_body():
    return {
        "model": "test-model",
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "Hermes preamble.\n\n# Finishing the job\nFinish the mission.\n\n## Skills (mandatory)\nLoad useful skills.\n\n════════════════════\nMEMORY (your personal notes)\nFavorite snack: waffles.\n\nUSER PROFILE (who the user is)\nName: Alinsa\n\n## Current Session Context\nSource: Discord",
            },
            {"role": "user", "content": "Earlier question"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call-1", "type": "function", "function": {"name": "waffle_lookup", "arguments": '{"crispy":true}'}},
                    {"id": "call-2", "type": "function", "function": {"name": "taco_lookup", "arguments": "{}"}},
                ],
            },
            {"role": "tool", "name": "waffle_lookup", "tool_call_id": "call-1", "content": '{"count":3}'},
            {"role": "tool", "name": "ghost_tool", "tool_call_id": "orphan-9", "content": "boo"},
            {"role": "user", "content": "Current question"},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "waffle_lookup",
                    "description": "Count waffles",
                    "parameters": {"type": "object", "properties": {"crispy": {"type": "boolean"}}},
                },
            }
        ],
    }


def _write_dump(
    root: Path, name: str, *, session_id: str, timestamp: str, messages: list[dict] | None = None, mtime: float
) -> Path:
    path = root / "sessions" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "timestamp": timestamp,
                "session_id": session_id,
                "reason": "completion",
                "request": {
                    "method": "POST",
                    "url": "https://example.test/v1/chat/completions",
                    "headers": {"authorization": "Bearer should-not-leak"},
                    "body": {"model": "test-model", "messages": messages or [{"role": "user", "content": "hello"}]},
                },
            }
        ),
        encoding="utf-8",
    )
    os.utime(path, (mtime, mtime))
    return path


def test_redacted_detail_masks_common_credentials_and_sensitive_url_parameters():
    secret_keys = ("api_key", "access_token", "client_secret", "password", "token", "x-auth-token", "refresh_token")
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        path = _write_dump(root, "request_dump_redaction.json", session_id="alpha", timestamp="2026-08-16T10:00:00Z", mtime=100)
        data = json.loads(path.read_text(encoding="utf-8"))
        data["request"]["url"] = "https://example.test/v1?api_key=url-api-secret&access_token=url-token-secret&view=full"
        data["request"]["body"]["credentials"] = {key: f"secret-{index}" for index, key in enumerate(secret_keys)}
        data["request"]["body"]["messages"][0]["metadata"] = {"password": "message-secret"}
        path.write_text(json.dumps(data), encoding="utf-8")
        with patch.object(api, "get_hermes_home", return_value=root):
            detail = api.get_dump(path.name)
    serialized = json.dumps(detail, ensure_ascii=False)
    for index, _key in enumerate(secret_keys):
        assert f"secret-{index}" not in serialized
    assert "url-api-secret" not in serialized
    assert "url-token-secret" not in serialized
    assert "message-secret" not in serialized
    assert "view=full" in detail["request"]["url"]
    assert "••••••••" in serialized


def test_raw_download_returns_the_exact_dump_object():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        path = _write_dump(root, "request_dump_alpha_raw.json", session_id="alpha", timestamp="2026-08-16T10:00:00Z", mtime=100)
        expected = json.loads(path.read_text(encoding="utf-8"))
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_raw_dump(path.name)
    assert result == expected
    assert result["request"]["headers"]["authorization"] == "Bearer should-not-leak"


def test_session_outcome_returns_latest_nonempty_active_assistant_response():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        connection = sqlite3.connect(root / "state.db")
        connection.executescript(
            "\n                CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, ended_at REAL);\n                CREATE TABLE messages (\n                    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,\n                    timestamp REAL, active INTEGER\n                );\n                INSERT INTO sessions VALUES ('subagent-1', 'subagent', 123.0);\n                INSERT INTO messages VALUES (1, 'subagent-1', 'assistant', '', 100.0, 1);\n                INSERT INTO messages VALUES (2, 'subagent-1', 'assistant', 'older response', 110.0, 1);\n                INSERT INTO messages VALUES (3, 'subagent-1', 'assistant', 'stale response', 115.0, 0);\n                INSERT INTO messages VALUES (4, 'subagent-1', 'assistant', 'final response', 120.0, 1);\n            "
        )
        connection.commit()
        connection.close()
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_session_outcome("subagent-1")
    assert result["content"] == "final response"
    assert result["message_id"] == 4
    assert result["source"] == "subagent"
    assert result["ended"]


def test_session_outcome_reports_missing_session_database():
    with tempfile.TemporaryDirectory() as temp_dir, patch.object(api, "get_hermes_home", return_value=Path(temp_dir)):
        result = api.get_session_outcome("subagent-1")
    assert result == {"session_id": "subagent-1", "found": False, "reason": "Session database unavailable"}


def test_raw_download_rejects_dump_symlinks():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        outside = root / "outside.json"
        outside.write_text('{"secret":"escape"}', encoding="utf-8")
        sessions = root / "sessions"
        sessions.mkdir()
        link = sessions / "request_dump_escape.json"
        link.symlink_to(outside)
        with patch.object(api, "get_hermes_home", return_value=root), pytest.raises(api.HTTPException) as raised:
            api.get_raw_dump(link.name)
    assert raised.value.status_code == 404


def test_list_dumps_ignores_symlinks_and_oversized_files_before_parsing():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        sessions = root / "sessions"
        sessions.mkdir()
        outside = root / "outside.json"
        outside.write_text('{"session_id":"escaped"}', encoding="utf-8")
        (sessions / "request_dump_link.json").symlink_to(outside)
        oversized = sessions / "request_dump_oversized.json"
        oversized.write_text("x" * 33, encoding="utf-8")
        with (
            patch.object(api, "get_hermes_home", return_value=root),
            patch.object(api, "_MAX_FILE_BYTES", 32),
            patch.object(api, "_summary", wraps=api._summary) as summary,
        ):
            result = api.list_dumps(limit=200)
    assert result["items"] == []
    assert result["dump_count"] == 0
    summary.assert_not_called()


def test_list_dumps_exposes_request_count_for_each_session():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        _write_dump(root, "request_dump_alpha_1.json", session_id="alpha", timestamp="2026-08-16T10:00:00Z", mtime=100)
        _write_dump(root, "request_dump_alpha_2.json", session_id="alpha", timestamp="2026-08-16T10:01:00Z", mtime=200)
        _write_dump(root, "request_dump_beta_1.json", session_id="beta", timestamp="2026-08-16T10:02:00Z", mtime=300)
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.list_dumps(limit=200)
    counts = {item["session_id"]: item["request_count"] for item in result["items"]}
    assert counts == {"beta": 1, "alpha": 2}


def test_session_timeline_returns_chronological_request_metrics_and_links():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        first = _write_dump(
            root,
            "request_dump_alpha_1.json",
            session_id="alpha",
            timestamp="2026-08-16T10:00:00Z",
            messages=[{"role": "user", "content": "short"}],
            mtime=100,
        )
        _write_dump(root, "request_dump_beta_1.json", session_id="beta", timestamp="2026-08-16T10:00:30Z", mtime=150)
        second = _write_dump(
            root,
            "request_dump_alpha_2.json",
            session_id="alpha",
            timestamp="2026-08-16T10:01:00Z",
            messages=[{"role": "user", "content": "short"}, {"role": "assistant", "content": "a much longer answer"}],
            mtime=200,
        )
        first_size = first.stat().st_size
        second_size = second.stat().st_size
        invalid = root / "sessions" / "request_dump_broken.json"
        invalid.write_text("[]", encoding="utf-8")
        os.utime(invalid, (175, 175))
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_session_timeline("alpha")
    assert result["session_id"] == "alpha"
    assert result["count"] == 2
    items = result["items"]
    assert [item["sequence"] for item in items] == [1, 2]
    assert [item["file"] for item in items] == [first.name, second.name]
    assert [item["timestamp"] for item in items] == ["2026-08-16T10:00:00Z", "2026-08-16T10:01:00Z"]
    assert items[0]["previous_file"] is None
    assert items[0]["next_file"] == second.name
    assert items[1]["previous_file"] == first.name
    assert items[1]["next_file"] is None
    assert items[0]["size"] == first_size
    assert items[1]["size_delta"] == second_size - first_size
    assert items[0]["size_delta"] is None
    assert items[0]["characters"] > 0
    assert items[1]["estimated_tokens"] > items[0]["estimated_tokens"]
    assert items[0]["token_delta"] is None
    assert items[1]["token_delta"] == items[1]["estimated_tokens"] - items[0]["estimated_tokens"]
    assert items[1]["message_count"] == 2
    assert items[1]["model"] == "test-model"
    assert items[1]["reason"] == "completion"
    assert "should-not-leak" not in json.dumps(result)


def test_session_timeline_rejects_unsafe_session_ids():
    with pytest.raises(api.HTTPException) as raised:
        api.get_session_timeline("alpha/../../secrets")
    assert raised.value.status_code == 400
    assert raised.value.detail == "Invalid session id"


def test_session_timeline_does_not_follow_dump_symlinks_outside_sessions():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        outside = _write_dump(root, "outside.json", session_id="alpha", timestamp="2026-08-16T10:00:00Z", mtime=100)
        outside = outside.rename(root / "outside.json")
        sessions = root / "sessions"
        sessions.mkdir(exist_ok=True)
        (sessions / "request_dump_link.json").symlink_to(outside)
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_session_timeline("alpha")
    assert result["items"] == []


def test_session_timeline_uses_dump_timestamps_for_chronological_order():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        _write_dump(root, "request_dump_later.json", session_id="alpha", timestamp="2026-08-16T10:01:00Z", mtime=100)
        _write_dump(root, "request_dump_earlier.json", session_id="alpha", timestamp="2026-08-16T10:00:00Z", mtime=200)
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_session_timeline("alpha")
    assert [item["file"] for item in result["items"]] == ["request_dump_earlier.json", "request_dump_later.json"]


def test_diff_uses_embedded_timestamps_when_mtime_order_disagrees():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        _write_dump(
            root,
            "request_dump_alpha_oldest.json",
            session_id="alpha",
            timestamp="2026-08-16T10:00:00Z",
            messages=[{"role": "user", "content": "oldest"}],
            mtime=400,
        )
        previous = _write_dump(
            root,
            "request_dump_alpha_previous.json",
            session_id="alpha",
            timestamp="2026-08-16T10:01:00Z",
            messages=[{"role": "user", "content": "previous"}],
            mtime=300,
        )
        current = _write_dump(
            root,
            "request_dump_alpha_current.json",
            session_id="alpha",
            timestamp="2026-08-16T10:02:00Z",
            messages=[{"role": "user", "content": "current"}],
            mtime=100,
        )
        with patch.object(api, "get_hermes_home", return_value=root):
            result = api.get_diff(current.name)
    assert result["previous_file"] == previous.name
    assert result["removed_messages"][0]["content"] == "previous"


def test_composition_separates_request_sources_and_marks_message_indices():
    body = sample_body()
    messages = api._normalized_messages(body)
    composition = api._analyze_request(body, messages)["composition"]
    parts = {part["key"]: part for part in composition["parts"]}
    assert list(parts) == ["instructions", "history", "current_user", "tools", "options"]
    assert parts["instructions"]["message_indices"] == [0]
    assert parts["history"]["message_indices"] == [1, 2, 3, 4]
    assert parts["current_user"]["message_indices"] == [5]
    assert parts["tools"]["characters"] > 0
    assert parts["options"]["characters"] > 0
    assert composition["total_characters"] == sum(part["characters"] for part in composition["parts"])
    assert composition["estimated_tokens"] == (composition["total_characters"] + 3) // 4


def test_prompt_map_recognizes_injected_source_sections():
    body = sample_body()
    messages = api._normalized_messages(body)
    sections = api._analyze_request(body, messages)["prompt_sections"]
    by_title = {section["title"]: section for section in sections}
    assert by_title["Core instructions"]["category"] == "Core prompt"
    assert by_title["Finishing the job"]["category"] == "Operating rules"
    assert by_title["Skills (mandatory)"]["category"] == "Skills"
    assert by_title["MEMORY (your personal notes)"]["category"] == "Persistent memory"
    assert by_title["USER PROFILE (who the user is)"]["category"] == "User profile"
    assert by_title["Current Session Context"]["category"] == "Session context"
    assert all(section["characters"] == len(section["content"]) for section in sections)
    assert all(section["message_index"] == 0 for section in sections)


def test_tool_flow_pairs_results_and_reports_missing_and_orphaned_results():
    body = sample_body()
    messages = api._normalized_messages(body)
    analysis = api._analyze_request(body, messages)
    flows = {flow["call_id"]: flow for flow in analysis["tool_interactions"]}
    assert flows["call-1"]["name"] == "waffle_lookup"
    assert flows["call-1"]["call_message_index"] == 2
    assert flows["call-1"]["status"] == "matched"
    assert flows["call-1"]["arguments"] == {"crispy": True}
    assert flows["call-1"]["results"] == [{"message_index": 3, "name": "waffle_lookup", "content": '{"count":3}'}]
    assert flows["call-2"]["status"] == "missing_result"
    assert flows["call-2"]["results"] == []
    assert analysis["orphan_tool_results"] == [{"call_id": "orphan-9", "message_index": 4, "name": "ghost_tool", "content": "boo"}]


def test_responses_function_outputs_inherit_tool_name_from_matching_call_id():
    body = {
        "model": "gpt-test",
        "input": [
            {"type": "function_call", "call_id": "call-1", "name": "search_files", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call-1", "output": '{"total_count": 3}'},
        ],
    }
    messages = api._normalized_messages(body)
    assert messages[0]["tool_calls"][0]["function"]["name"] == "search_files"
    assert messages[1]["role"] == "tool"
    assert messages[1]["name"] == "search_files"
    assert messages[1]["tool_call_id"] == "call-1"


def test_tool_results_inherit_matching_call_arguments_for_collapsed_headers():
    body = {
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-skill",
                        "type": "function",
                        "function": {"name": "skill_view", "arguments": '{"name":"local:github-local-patterns"}'},
                    },
                    {
                        "id": "call-file",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"/tmp/example.md"}'},
                    },
                ],
            },
            {"role": "tool", "name": "skill_view", "tool_call_id": "call-skill", "content": '{"success":true}'},
            {"role": "tool", "name": "read_file", "tool_call_id": "call-file", "content": "file contents"},
        ]
    }
    messages = api._normalized_messages(body)
    assert messages[1]["_tool_call"]["function"]["arguments"] == '{"name":"local:github-local-patterns"}'
    assert messages[2]["_tool_call"]["function"]["arguments"] == '{"path":"/tmp/example.md"}'


def test_responses_instructions_and_input_get_composition_and_prompt_map():
    body = {
        "model": "gpt-test",
        "instructions": "Base instructions\n\n# Tool-use enforcement\nUse tools.",
        "input": [
            {"role": "user", "content": "First"},
            {"role": "assistant", "content": "Answer"},
            {"role": "user", "content": "Latest"},
        ],
        "tools": [],
    }
    messages = api._normalized_messages(body)
    analysis = api._analyze_request(body, messages)
    parts = {part["key"]: part for part in analysis["composition"]["parts"]}
    assert parts["instructions"]["message_indices"] == [0]
    assert parts["history"]["message_indices"] == [1, 2]
    assert parts["current_user"]["message_indices"] == [3]
    assert [section["title"] for section in analysis["prompt_sections"]] == ["Core instructions", "Tool-use enforcement"]
