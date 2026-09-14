"""Invalid-Unicode code units must remain escapable JSON, not crash UTF-8."""

import json

import pytest
from test_backend_safety import http
from test_request_analysis import _write_dump, api


@pytest.mark.parametrize("unit", ["\ud800", "\udfff"])
def test_lone_surrogates_roundtrip_through_normal_and_raw_http(tmp_path, monkeypatch, unit):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    path = _write_dump(
        tmp_path,
        "request_dump_unicode.json",
        session_id="safe",
        timestamp="2026-01-01T00:00:00Z",
        messages=[{"role": "user", "content": "before " + unit + " after", "metadata": {unit: unit}}],
        mtime=100,
    )
    original = path.read_bytes()
    expected = json.loads(original)
    status, listing = http("/dumps")
    assert status == 200
    assert listing["items"][0]["preview"] == "before " + unit + " after"
    status, detail = http("/dumps/" + path.name)
    assert status == 200
    assert detail["messages"][0]["content"] == expected["request"]["body"]["messages"][0]["content"]
    assert detail["messages"][0]["metadata"] == {unit: unit}
    status, raw = http("/dumps/" + path.name + "/raw")
    assert status == 200
    assert raw == expected
    assert path.read_bytes() == original


def test_surrogates_in_diff_timeline_and_embedded_redacted_arguments(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    unit = "\ud800"
    before = _write_dump(tmp_path, "request_dump_before.json", session_id="safe", timestamp="2026-01-01", mtime=100)
    arguments = json.dumps({"text": unit, unit: "literal", "password": "synthetic-value"})
    after = _write_dump(
        tmp_path,
        "request_dump_after.json",
        session_id="safe",
        timestamp="2026-01-02",
        mtime=200,
        messages=[
            {"role": "assistant", "tool_calls": [{"id": "a", "function": {"name": "f", "arguments": arguments}}]},
            {"role": "user", "content": unit},
        ],
    )
    data = json.loads(after.read_bytes())
    data["reason"] = unit
    data["request"]["body"]["extra"] = {unit: unit}
    after.write_text(json.dumps(data))
    for route in ["/dumps", "/sessions/safe/timeline", "/dumps/" + after.name, "/dumps/" + after.name + "/diff"]:
        status, response = http(route)
        assert status == 200
        assert "synthetic-value" not in json.dumps(response)
        assert "\\ud800" in json.dumps(response)
    status, detail = http("/dumps/" + after.name)
    decoded = json.loads(detail["messages"][0]["tool_calls"][0]["function"]["arguments"])
    assert decoded == {"text": unit, unit: "literal", "password": api._REDACTED}
    status, raw = http("/dumps/" + after.name + "/raw")
    assert status == 200 and raw == data
    assert before.exists()


def test_wire_escaping_preserves_unicode_and_literal_escape_distinction():
    value = {"emoji": "♫ 🍰", "unit": "\ud800", "literal": "\\ud800", "\udfff": "key"}
    wire = api.EscapedJSONResponse(value).body
    wire.decode("utf-8", errors="strict")
    assert json.loads(wire) == value
