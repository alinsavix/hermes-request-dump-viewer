"""Synthetic, temporary-home regressions for the backend safety review."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import stat
from pathlib import Path

import pytest
from fastapi import FastAPI
from test_capture_toggle import plugin
from test_request_analysis import _write_dump, api

SECRET = "SYNTHETIC-REVIEW-SENTINEL"


def http(path, method="GET", body=None):
    """Exercise routing and JSON serialization without another HTTP dependency."""

    async def request():
        app = FastAPI()
        app.include_router(api.router)
        events = []

        async def receive():
            return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b""}

        async def send(event):
            events.append(event)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "headers": [(b"content-type", b"application/json")],
                "server": ("test", 80),
                "client": ("test", 1),
            },
            receive,
            send,
        )
        return events[0]["status"], json.loads(b"".join(e.get("body", b"") for e in events))

    return asyncio.run(request())


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    return tmp_path


def dump(home, **updates):
    path = _write_dump(home, "request_dump_safe.json", session_id="safe", timestamp="2026-01-01T00:00:00Z", mtime=100)
    data = json.loads(path.read_text())
    data.update(updates)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.mark.parametrize("content", [json.dumps({"password": SECRET, "padding": "x" * 300}), {"password": SECRET}])
def test_f02_preview_redacts_before_truncating(home, content):
    path = dump(home, request={"body": {"messages": [{"role": "user", "content": content}]}})
    listing = api.list_dumps(limit=200)
    preview = listing["items"][0]["preview"]
    assert SECRET not in preview
    assert api._REDACTED in preview
    assert len(preview) <= 240
    assert SECRET in json.dumps(api.get_raw_dump(path.name))


def test_f02_outcome_redacts_structured_content(home):
    with sqlite3.connect(home / "state.db") as db:
        db.executescript(
            "CREATE TABLE sessions(id TEXT, source TEXT, ended_at REAL); "
            "CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, active INTEGER, content TEXT, timestamp REAL);"
        )
        db.execute("INSERT INTO sessions VALUES ('safe', 'test', 1)")
        db.execute("INSERT INTO messages VALUES (1, 'safe', 'assistant', 1, ?, 1)", (json.dumps({"password": SECRET}),))
    result = api.get_session_outcome("safe")
    assert SECRET not in json.dumps(result)
    assert json.loads(result["content"])["password"] == api._REDACTED


@pytest.mark.parametrize("endpoint", ["list", "detail", "timeline"])
def test_f02_default_metadata_redacted(home, endpoint):
    path = dump(
        home,
        reason={"password": SECRET},
        request={"method": json.dumps({"password": SECRET}), "body": {"model": {"token": SECRET}}},
    )
    result = {
        "list": lambda: api.list_dumps(limit=200),
        "detail": lambda: api.get_dump(path.name),
        "timeline": lambda: api.get_session_timeline("safe"),
    }[endpoint]()
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize(
    "url",
    [
        f"https://user:{SECRET}@example.test/path",
        f"https://{SECRET}@example.test/path",
        f"https://example.test/path?key={SECRET}&view=full",
        f"https://example.test/path?%6bey={SECRET}&KEY={SECRET}",
        f"//user:{SECRET}@example.test/path?key={SECRET}",
    ],
)
def test_f03_url_credentials_redacted_without_masking_json_key(home, url):
    path = dump(home, request={"url": url, "body": {"key": "ordinary-property"}})
    for result in (api.list_dumps(limit=200), api.get_dump(path.name)):
        assert SECRET not in json.dumps(result)
    assert api.get_dump(path.name)["request"]["body_options"]["key"] == "ordinary-property"
    assert api.get_raw_dump(path.name)["request"]["url"] == url


@pytest.mark.parametrize(
    "url", [f"https://[invalid?key={SECRET}", f"https://user:{SECRET}@[invalid?x=1", f"HTTPS://example.test/?key={SECRET}"]
)
def test_f03_f16_url_text_preserves_envelope_not_secrets(home, url):
    content = "ERROR before " + url + " after failure"
    path = dump(home, request={"url": url, "body": {"messages": [{"role": "user", "content": content}]}})
    detail = api.get_dump(path.name)
    assert SECRET not in json.dumps(detail)
    assert detail["messages"][0]["content"].startswith("ERROR before ")
    assert detail["messages"][0]["content"].endswith(" after failure")
    assert api._redact("Why? [not a URL]") == "Why? [not a URL]"


@pytest.mark.parametrize("enabled", ["false", "true", {"value": True}, [True], 1, None])
@pytest.mark.parametrize("process", ["api", "hook"])
def test_f05_invalid_enabled_fails_closed_in_both_processes(home, monkeypatch, enabled, process):
    monkeypatch.setattr(plugin, "_home", lambda: home)
    monkeypatch.setenv(plugin._ENV_KEY, "true")
    path = api._state_path()
    path.parent.mkdir()
    path.write_text(json.dumps({"enabled": enabled}))
    assert (api.get_capture_state()["enabled"] if process == "api" else plugin._read_enabled()) is False
    plugin.on_pre_api_request()
    assert plugin.os.environ.get(plugin._ENV_KEY) is None


@pytest.mark.parametrize("state", [None, b"bad-json", b"\xff", b'{"enabled": true}'])
def test_f05_capture_api_reports_requested_not_effective_state(home, monkeypatch, state):
    monkeypatch.setenv(plugin._ENV_KEY, "true")  # dashboard env is NOT gateway state
    if state is not None:
        path = api._state_path()
        path.parent.mkdir()
        path.write_bytes(state)
    status, result = http("/capture")
    assert status == 200
    assert result["enabled"] is (state == b'{"enabled": true}')
    assert result["effective_enabled"] is None
    assert result["source"] == ("control_file" if state == b'{"enabled": true}' else "missing" if state is None else "invalid")
    status, saved = http("/capture", "PUT", {"enabled": True})
    assert status == 200
    assert saved == {"enabled": True, "source": "control_file", "effective_enabled": None}
    assert http("/capture")[1] == saved


@pytest.mark.parametrize("enabled", ["false", "true", 1, 0])
def test_f05_capture_put_requires_json_boolean(home, enabled):
    assert http("/capture", "PUT", {"enabled": enabled})[0] == 422
    assert not api._state_path().exists()


@pytest.mark.parametrize("writer", ["api", "hook"])
def test_f15_state_writes_use_unique_private_fsynced_temporary_files(home, monkeypatch, writer):
    monkeypatch.setattr(plugin, "_home", lambda: home)
    monkeypatch.setattr(plugin, "_reset_failed", False)
    path = api._state_path()
    path.parent.mkdir()
    target = home / "synthetic-target"
    target.write_text("DO NOT CHANGE")
    predictable = path.with_suffix(".json.tmp")
    predictable.symlink_to(target)
    replacements, synced = [], []
    real_replace, real_fsync = api.os.replace, api.os.fsync

    def fsync(fd):
        synced.append(api.os.fstat(fd).st_ino)
        real_fsync(fd)

    def replace(source, destination):
        temporary = Path(source)
        replacements.append((temporary, stat.S_IMODE(temporary.stat().st_mode), temporary.stat().st_ino in synced))
        real_replace(source, destination)

    monkeypatch.setattr(api.os, "replace", replace)
    monkeypatch.setattr(api.os, "fsync", fsync)
    for _ in range(2):
        if writer == "api":
            api._write_capture_state(False)
        else:
            plugin._reset_state_on_startup()
    assert target.read_text() == "DO NOT CHANGE"
    assert len(replacements) == 2
    assert replacements[0][0] != replacements[1][0]
    assert all(mode == 0o600 and synced for _, mode, synced in replacements)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {"enabled": False}
    assert set(path.parent.iterdir()) == {path, predictable}


@pytest.mark.parametrize("writer", ["api", "hook"])
@pytest.mark.parametrize("failure", ["mkdir", "fsync", "replace"])
def test_f15_failed_writes_cleanup_and_preserve_previous_state(home, monkeypatch, writer, failure):
    monkeypatch.setattr(plugin, "_home", lambda: home)
    monkeypatch.setattr(plugin, "_reset_failed", False)
    path = api._state_path()
    path.parent.mkdir()
    path.write_text('{"enabled": true}')

    def denied(*args, **kwargs):
        raise PermissionError("synthetic denied")

    monkeypatch.setattr(Path if failure == "mkdir" else api.os, failure, denied)
    if writer == "api":
        with pytest.raises(api.HTTPException) as error:
            api._write_capture_state(False)
        assert error.value.status_code == 500
    else:
        plugin._reset_state_on_startup()
        assert plugin._read_enabled() is False
    assert json.loads(path.read_text()) == {"enabled": True}
    assert list(path.parent.iterdir()) == [path]


@pytest.mark.parametrize("kind", ["symlink", "directory", "fifo", "parent_symlink", "parent_file"])
@pytest.mark.parametrize("operation", ["api_read", "hook_read", "api_write", "hook_write"])
def test_f15_rejects_unsafe_state_path_types(home, monkeypatch, kind, operation):
    monkeypatch.setattr(plugin, "_home", lambda: home)
    monkeypatch.setattr(plugin, "_reset_failed", False)
    monkeypatch.setenv(plugin._ENV_KEY, "true")
    path = api._state_path()
    target = home / "synthetic-target"
    target.write_text('{"enabled": true}')
    if kind == "parent_symlink":
        other = home / "other"
        other.mkdir()
        path.parent.symlink_to(other, target_is_directory=True)
    elif kind == "parent_file":
        path.parent.write_text("not a directory")
    else:
        path.parent.mkdir()
        if kind == "symlink":
            path.symlink_to(target)
        elif kind == "directory":
            path.mkdir()
        else:
            api.os.mkfifo(path)
    original = target.read_text()
    # Avoid ever blocking on the FIFO, even on the vulnerable implementation.
    opened = []
    real_read = Path.read_text

    def guarded_read(self, *args, **kwargs):
        if self == path:
            opened.append(self)
            raise AssertionError("unsafe state path was opened")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guarded_read)
    if operation == "api_read":
        assert api.get_capture_state() == {"enabled": False, "source": "unavailable", "effective_enabled": None}
    elif operation == "hook_read":
        assert plugin._read_enabled() is False
    elif operation == "api_write":
        with pytest.raises(api.HTTPException) as error:
            api._write_capture_state(False)
        assert error.value.status_code == 500
    else:
        plugin._reset_state_on_startup()
        assert plugin._reset_failed is True
    assert not opened
    assert target.read_text() == original
    if kind == "symlink":
        assert path.is_symlink()


@pytest.mark.parametrize("bad_bytes", [b"\xff", b'{"request":', b"[]"])
def test_f06_corrupt_record_isolated_from_valid_timeline_and_diff(home, bad_bytes):
    first = _write_dump(home, "request_dump_first.json", session_id="safe", timestamp="2025-12-31T00:00:00Z", mtime=10)
    current = dump(home)
    bad = home / "sessions" / "request_dump_corrupt.json"
    bad.write_bytes(bad_bytes)
    status, timeline = http("/sessions/safe/timeline")
    assert status == 200
    assert [item["file"] for item in timeline["items"]] == [first.name, current.name]
    status, diff = http(f"/dumps/{current.name}/diff")
    assert status == 200
    assert diff["previous_file"] == first.name
    for suffix in ("", "/diff", "/raw"):
        status, error = http(f"/dumps/{bad.name}{suffix}")
        assert status == 422
        assert bad.name in error["detail"]
    status, listing = http("/dumps")
    assert status == 200
    assert any(item["file"] == current.name for item in listing["items"])


@pytest.mark.parametrize("request_value", [[], [1], {"body": []}, {"body": [1]}, {"body": None}, None])
def test_f16_nonobject_request_bodies_normalize_to_empty_views(home, request_value):
    path = dump(home, request=request_value)
    status, detail = http(f"/dumps/{path.name}")
    assert status == 200
    assert detail["messages"] == []
    status, diff = http(f"/dumps/{path.name}/diff")
    assert status == 200
    assert diff["current_count"] == 0
    status, timeline = http("/sessions/safe/timeline")
    assert status == 200
    assert timeline["items"][0]["message_count"] == 0
    status, listing = http("/dumps")
    assert status == 200
    assert "parse_error" not in listing["items"][0]
    assert listing["items"][0]["input_format"] == "unknown"
    assert http(f"/dumps/{path.name}/raw")[1]["request"] == request_value


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_f16_nonfinite_json_is_record_error_and_scans_skip_it(home, number):
    good = dump(home)
    bad = home / "sessions" / "request_dump_nonfinite.json"
    bad.write_text('{"session_id":"bad", "request":{"body":{"temperature":' + number + "}}}")
    for suffix in ("", "/diff", "/raw"):
        status, error = http(f"/dumps/{bad.name}{suffix}")
        assert status == 422
        assert bad.name in error["detail"]
    assert http("/sessions/safe/timeline")[1]["count"] == 1
    assert http(f"/dumps/{good.name}/diff")[0] == 200
    status, listing = http("/dumps")
    assert status == 200
    bad_summary = next(item for item in listing["items"] if item["file"] == bad.name)
    assert "parse_error" in bad_summary


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_f16_nonfinite_embedded_arguments_remain_text_not_invalid_response_numbers(home, number):
    arguments = '{"value":' + number + "}"
    path = dump(
        home,
        request={
            "body": {
                "messages": [
                    {
                        "role": "assistant",
                        "tool_calls": [{"id": "call-1", "function": {"name": "synthetic", "arguments": arguments}}],
                    }
                ]
            }
        },
    )
    status, detail = http(f"/dumps/{path.name}")
    assert status == 200
    assert detail["analysis"]["tool_interactions"][0]["arguments"] == arguments
    assert http(f"/dumps/{path.name}/diff")[0] == 200


@pytest.mark.parametrize("has_message", [False, True])
def test_f02_outcome_metadata_also_uses_default_redaction(home, has_message):
    with sqlite3.connect(home / "state.db") as db:
        db.executescript(
            "CREATE TABLE sessions(id TEXT, source TEXT, ended_at REAL); "
            "CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, active INTEGER, content TEXT, timestamp REAL);"
        )
        db.execute("INSERT INTO sessions VALUES ('safe', ?, 1)", (json.dumps({"password": SECRET}),))
        if has_message:
            db.execute("INSERT INTO messages VALUES (1, 'safe', 'assistant', 1, 'ok', 1)")
    status, result = http("/sessions/safe/outcome")
    assert status == 200
    assert SECRET not in json.dumps(result)


def test_f06_raw_endpoint_retains_path_size_and_symlink_guards(home, monkeypatch):
    path = dump(home)
    monkeypatch.setattr(api, "_MAX_FILE_BYTES", 1)
    assert http(f"/dumps/{path.name}/raw")[0] == 413
    assert http("/dumps/not-a-dump.json/raw")[0] == 400
    with pytest.raises(api.HTTPException) as error:
        api.get_raw_dump("../request_dump_escape.json")
    assert error.value.status_code == 400
    link = path.with_name("request_dump_link.json")
    link.symlink_to(path)
    assert http(f"/dumps/{link.name}/raw")[0] == 404


def test_f16_malformed_previous_request_is_empty_for_diff(home):
    previous = dump(home, request=[1])
    current = _write_dump(home, "request_dump_next.json", session_id="safe", timestamp="2026-01-02T00:00:00Z", mtime=200)
    status, diff = http(f"/dumps/{current.name}/diff")
    assert status == 200
    assert diff["previous_file"] == previous.name
    assert diff["previous_count"] == 0
    assert diff["current_count"] == 1


@pytest.mark.parametrize("url", [f"/v1?api_key={SECRET}&view=full", f"?key={SECRET}&view=full"])
def test_f03_relative_provider_urls_still_redact_query_credentials(home, url):
    path = dump(home, request={"url": url, "body": {}})
    detail = api.get_dump(path.name)
    assert SECRET not in json.dumps(detail)
    assert "view=full" in detail["request"]["url"]


def test_f15_unreadable_state_is_fail_closed_not_uncaught_error(home, monkeypatch):
    monkeypatch.setattr(plugin, "_home", lambda: home)

    def denied(*args, **kwargs):
        raise PermissionError("synthetic denied")

    monkeypatch.setattr(Path, "read_text", denied)
    assert api.get_capture_state() == {"enabled": False, "source": "unavailable", "effective_enabled": None}
    assert plugin._read_enabled() is False
