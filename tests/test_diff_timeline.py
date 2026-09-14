"""Behavioral contract for occurrence-preserving chronological diffs."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from itertools import product
from pathlib import Path

import pytest
from fastapi import FastAPI

MODULE_PATH = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("timeline_api", MODULE_PATH)
assert spec is not None
api = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(api)


def message(text, role="user"):
    return {"role": role, "content": text}


def check_diff(before, after):
    result = api._aligned_message_diff(before, after)
    rows = [row for row in result["timeline"] if row["kind"] == "message"]
    assert sorted(row["before_index"] for row in rows if row["before_index"] is not None) == list(range(len(before)))
    assert [row["after_index"] for row in rows if row["after_index"] is not None] == list(range(len(after)))
    assert len({row["id"] for row in result["timeline"]}) == len(result["timeline"])
    valid = [["unchanged"], ["modified"], ["moved"], ["modified", "moved"], ["removed"], ["added"]]
    for row in rows:
        assert row["status"] in valid
        assert isinstance(row["match_basis"], str) and row["match_basis"]
        assert row["before"] == (before[row["before_index"]] if row["before_index"] is not None else None)
        assert row["after"] == (after[row["after_index"]] if row["after_index"] is not None else None)
    by_id = {row["id"]: row for row in rows}
    sources = [row for row in result["timeline"] if row["kind"] == "move_source"]
    assert sorted(source["target_id"] for source in sources) == sorted(row["id"] for row in rows if "moved" in row["status"])
    for source in sources:
        target = by_id[source["target_id"]]
        assert (source["before_index"], source["after_index"]) == (target["before_index"], target["after_index"])
    summary = result["summary"]
    assert set(summary) == {"unchanged", "modified", "moved", "added", "removed"}
    assert summary == {key: sum(key in row["status"] for row in rows) for key in summary}
    retained = sum(row["before_index"] is not None and row["after_index"] is not None for row in rows)
    assert retained + summary["removed"] == len(before)
    assert retained + summary["added"] == len(after)
    assert result == api._aligned_message_diff(before, after)
    return result, rows


def call(call_id, arguments="{}"):
    return {"role": "assistant", "tool_calls": [{"id": call_id, "function": {"name": "lookup", "arguments": arguments}}]}


def result(call_id, content):
    return {"role": "tool", "tool_call_id": call_id, "name": "lookup", "content": content}


def test_stable_call_and_result_ids_preserve_truncated_payloads():
    before = api._link_tool_results([call("a", '{"text":"long text"}'), result("a", "long result")])
    after = api._link_tool_results([call("a", '{"text":"short"}'), result("a", "short")])
    diff, rows = check_diff(before, after)
    assert [row["status"] for row in rows] == [["modified"], ["modified"]]
    assert [row["match_basis"] for row in rows] == ["stable_call_id", "stable_result_id"]
    assert diff["summary"]["removed"] == diff["summary"]["added"] == 0


@pytest.mark.parametrize("modified", [False, True])
def test_reorder_has_one_destination_and_source_at_old_gap(modified):
    moving = call("moving") if modified else message("moving")
    destination = call("moving", '{"changed":true}') if modified else moving
    before = [message("start"), moving, message("deleted"), message("a"), message("b"), message("end")]
    after = [before[0], before[3], before[4], destination, before[5]]
    diff, rows = check_diff(before, after)
    target = next(row for row in rows if row["before_index"] == 1)
    assert target["after_index"] == 3
    assert target["status"] == (["modified", "moved"] if modified else ["moved"])
    refs = [row for row in diff["timeline"] if row["kind"] == "move_source"]
    assert len(refs) == 1
    assert refs[0]["target_id"] == target["id"]
    assert (refs[0]["before_index"], refs[0]["after_index"]) == (1, 3)
    assert [row["kind"] for row in diff["timeline"][:3]] == ["message", "move_source", "message"]
    assert diff["timeline"][2]["status"] == ["removed"]
    assert diff["summary"] == {"unchanged": 4, "modified": int(modified), "moved": 1, "removed": 1, "added": 0}


def test_canonical_arguments_and_rekeyed_result_provenance():
    before = [call("old", '{"a":1,"b":2}'), result("old", "ok")]
    after = [call("new", '{ "b": 2, "a": 1 }'), result("new", "ok")]
    diff, rows = check_diff(before, after)
    assert diff["summary"]["unchanged"] == 2
    assert [row["match_basis"] for row in rows] == ["canonical_exact", "canonical_exact_provenance"]


def test_same_name_distinct_calls_do_not_merge_equal_ok_results():
    before = [call("old", '{"task":"first"}'), result("old", "ok")]
    after = [call("new", '{"task":"other"}'), result("new", "ok")]
    diff, _ = check_diff(before, after)
    assert diff["summary"] == {"unchanged": 0, "modified": 0, "moved": 0, "removed": 2, "added": 2}


def test_unique_system_instruction_slot_can_be_modified():
    before = api._normalized_messages({"instructions": "Base\n# Skills\nOld", "input": "same"})
    after = api._normalized_messages({"instructions": "Base\n# Skills\nNew", "input": "same"})
    diff, rows = check_diff(before, after)
    assert [row["status"] for row in rows] == [["modified"], ["unchanged"]]
    assert rows[0]["match_basis"] == "unique_instruction_slot"
    assert diff["summary"]["modified"] == 1


def endpoint_diff(tmp_path, monkeypatch, before, after):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    for index, messages in enumerate([before, after]):
        if messages is None:
            continue
        (sessions / f"request_dump_{index}.json").write_text(
            json.dumps(
                {
                    "timestamp": f"2026-09-13T01:00:0{index}Z",
                    "session_id": "test",
                    "request": {"body": {"messages": messages}},
                }
            )
        )
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    app = FastAPI()
    app.include_router(api.router)
    # Exercise the actual GET route using ASGI, without an unpinned test-client dependency.
    events = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(event):
        events.append(event)

    asyncio.run(
        app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/dumps/request_dump_1.json/diff",
                "query_string": b"",
                "headers": [],
                "root_path": "",
                "server": ("test", 80),
                "client": ("test", 123),
            },
            receive,
            send,
        )
    )
    assert events[0]["status"] == 200
    return json.loads(b"".join(event.get("body", b"") for event in events))


@pytest.mark.parametrize("before", [None, []])
def test_first_or_empty_request_endpoint_contract(tmp_path, monkeypatch, before):
    diff = endpoint_diff(tmp_path, monkeypatch, before, [message("first")])
    assert diff["schema_version"] == 2
    assert diff["previous_file"] == (None if before is None else "request_dump_0.json")
    assert diff["previous_sequence"] == (None if before is None else 1)
    assert diff["previous_count"] == 0 and diff["current_count"] == 1
    assert diff["timeline"][0]["status"] == ["added"]
    assert diff["summary"] == {"unchanged": 0, "modified": 0, "moved": 0, "added": 1, "removed": 0}


def test_endpoint_redacts_all_rows_and_matches_raw_credentials(tmp_path, monkeypatch):
    before = [
        call("a", '{"password":"old-secret"}'),
        result("a", '{"authorization":"result-before-secret"}'),
        {**message("removed"), "metadata": {"api_key": "removed-secret"}},
        {**message("same"), "metadata": {"cookie": "unchanged-secret"}},
    ]
    after = [
        call("a", '{"password":"new-secret"}'),
        result("a", '{"authorization":"result-after-secret"}'),
        before[3],
        message("https://example.test/?access_token=url-secret&view=full"),
    ]
    diff = endpoint_diff(tmp_path, monkeypatch, before, after)
    serialized = json.dumps(diff)
    for secret in (
        "old-secret",
        "new-secret",
        "result-before-secret",
        "result-after-secret",
        "removed-secret",
        "unchanged-secret",
        "url-secret",
    ):
        assert secret not in serialized
    rows = [row for row in diff["timeline"] if row["kind"] == "message"]
    assert diff["summary"] == {"unchanged": 1, "modified": 2, "moved": 0, "added": 1, "removed": 1}
    assert rows[0]["status"] == ["modified"]
    assert rows[0]["before"] == rows[0]["after"]  # Masked values equal; raw values did not.
    assert "view=full" in serialized


def test_ambiguous_reused_ids_do_not_invent_edits():
    before = [result("reused", "first"), result("reused", "second")]
    after = [result("reused", "unrelated")]
    diff, _ = check_diff(before, after)
    assert diff["summary"] == {"unchanged": 0, "modified": 0, "moved": 0, "added": 1, "removed": 2}


def test_stable_ids_are_reserved_before_equal_call_payloads():
    before = [call("retained", '{"x":1}'), call("other", '{"x":1}')]
    after = [call("retained", '{"x":2}'), call("replacement", '{"x":1}')]
    _, rows = check_diff(before, after)
    assert [(row["before_index"], row["after_index"], row["status"]) for row in rows] == [
        (0, 0, ["modified"]),
        (1, 1, ["unchanged"]),
    ]


@pytest.mark.parametrize(
    ("old_text", "new_text", "statuses"),
    [
        ([], [], []),
        ([], ["a"], [["added"]]),
        (["a"], [], [["removed"]]),
        (["a", "b"], ["a", "b", "c"], [["unchanged"], ["unchanged"], ["added"]]),
        (["a", "b"], ["a", "insert", "b"], [["unchanged"], ["added"], ["unchanged"]]),
        (["a", "delete", "b"], ["a", "b"], [["unchanged"], ["removed"], ["unchanged"]]),
        (["a", "b", "tail"], ["a", "b"], [["unchanged"], ["unchanged"], ["removed"]]),
        (["a", "same", "same", "b"], ["a", "same", "b"], [["unchanged"], ["unchanged"], ["removed"], ["unchanged"]]),
        (["old prompt"], ["unrelated prompt"], [["added"], ["removed"]]),
    ],
)
def test_basic_timeline_order_and_occurrence_coverage(old_text, new_text, statuses):
    _, rows = check_diff(list(map(message, old_text)), list(map(message, new_text)))
    assert [row["status"] for row in rows] == statuses


def test_duplicate_subsequences_do_not_invent_relative_moves():
    # Exhaustively retain/delete occurrences from small repetitive histories.
    for text in product("ab", repeat=5):
        before = list(map(message, text))
        for mask in product((False, True), repeat=5):
            after = [item for item, retain in zip(before, mask, strict=True) if retain]
            diff, _ = check_diff(before, after)
            assert diff["summary"]["moved"] == 0, (text, mask)
            assert diff["summary"]["unchanged"] == len(after)


def test_ambiguous_instruction_slots_and_orphan_results_remain_unmatched():
    before = [message("one", "system"), message("two", "system"), result("old", "ok")]
    after = [message("other", "system"), message("different", "system"), result("new", "ok")]
    diff, _ = check_diff(before, after)
    assert diff["summary"] == {"unchanged": 0, "modified": 0, "moved": 0, "added": 3, "removed": 3}


def test_unchanged_result_ignores_changed_derived_call_arguments():
    before = api._link_tool_results([call("a", '{"text":"long"}'), result("a", "same")])
    after = api._link_tool_results([call("a", '{"text":"short"}'), result("a", "same")])
    _, rows = check_diff(before, after)
    assert [row["status"] for row in rows] == [["modified"], ["unchanged"]]


def test_duplicate_payload_prefers_occurrence_after_surviving_id_anchor():
    before = [message("repeat"), call("anchor"), message("repeat")]
    after = before[1:]
    diff, rows = check_diff(before, after)
    assert [row["status"] for row in rows] == [["removed"], ["unchanged"], ["unchanged"]]
    assert diff["summary"]["moved"] == 0


@pytest.mark.parametrize("factory", [call, lambda identity: result(identity, "ok")])
def test_reused_identity_prefers_occurrence_after_unique_anchor(factory):
    before = [factory("reused"), factory("anchor"), factory("reused")]
    diff, rows = check_diff(before, before[1:])
    assert diff["summary"] == {"unchanged": 2, "modified": 0, "moved": 0, "removed": 1, "added": 0}
    assert [(row["before_index"], row["after_index"]) for row in rows] == [(0, None), (1, 0), (2, 1)]


@pytest.mark.parametrize("factory", [call, lambda identity: result(identity, "ok")])
def test_reused_identity_suffix_cannot_cross_ordinary_anchor(factory):
    before = [factory("4"), factory("4"), factory("3"), message("2"), factory("3")]
    diff, rows = check_diff(before, [before[0], before[2], before[3]])
    assert diff["summary"] == {"unchanged": 3, "modified": 0, "moved": 0, "removed": 2, "added": 0}
    retained = [row for row in rows if row["after_index"] is not None]
    assert [row["before_index"] for row in retained] == [0, 2, 3]


@pytest.mark.parametrize("insert", [False, True])
def test_mixed_identity_subsequences_do_not_invent_moves(insert):
    # Exhaust every deletion mask for every small history over ordinary,
    # call and result occurrences. Calls/results deliberately reuse both IDs
    # and payloads; the different IDs also share identical stripped payloads.
    alphabet = [message("repeat"), call("a"), call("b"), result("a", "ok"), result("b", "ok")]
    for history in product(range(len(alphabet)), repeat=5):
        complete = [alphabet[index] for index in history]
        for mask in product((False, True), repeat=len(complete)):
            shortened = [item for item, retain in zip(complete, mask, strict=True) if retain]
            before, after = (shortened, complete) if insert else (complete, shortened)
            diff, rows = check_diff(before, after)
            assert diff["summary"] == {
                "unchanged": len(shortened),
                "modified": 0,
                "moved": 0,
                "removed": len(before) - len(shortened),
                "added": len(after) - len(shortened),
            }, (history, mask)
            retained = [row for row in rows if row["after_index"] is not None and row["before_index"] is not None]
            old_indices = [row["before_index"] for row in retained]
            assert old_indices == sorted(old_indices), (history, mask)
            for row in retained:
                # Identity plus full canonical payload, never role/name alone.
                assert api._message_identity(row["before"]) == api._message_identity(row["after"])
                assert api._message_fingerprint(row["before"]) == api._message_fingerprint(row["after"])


def test_deletion_prefix_is_removed_before_anchor_not_moved():
    before = [message("discard"), message("keep"), message("answer", "assistant")]
    result, rows = check_diff(before, before[1:])
    assert [row["status"] for row in rows] == [["removed"], ["unchanged"], ["unchanged"]]
    assert result["summary"] == {"unchanged": 2, "modified": 0, "moved": 0, "removed": 1, "added": 0}


@pytest.mark.parametrize("factory", [lambda _: message("repeat"), lambda _: call("reused")])
@pytest.mark.parametrize("edit", ["identical", "insert", "delete", "changed_edges", "prefix"])
def test_repetitive_histories_bound_match_work(monkeypatch, factory, edit):
    size = 4000
    before = [factory(i) for i in range(size)]
    after = list(before)
    if edit == "insert":
        after.insert(size // 2, message("inserted"))
    elif edit == "delete":
        before.insert(size // 2, message("deleted"))
    elif edit == "changed_edges":
        before = [message("old-start"), *before, message("old-end")]
        after = [message("new-start"), *after, message("new-end")]
    elif edit == "prefix":
        before += [message("old-end")]
        after += [message("new-end")]
    original = api.bisect_left
    operations = 0

    def bounded_bisect(*args, **kwargs):
        nonlocal operations
        operations += 1
        assert operations <= size * 20, "repetitive alignment must not enumerate quadratic match pairs"
        return original(*args, **kwargs)

    monkeypatch.setattr(api, "bisect_left", bounded_bisect)
    diff = api._aligned_message_diff(before, after)
    assert diff["summary"] == {
        "unchanged": size,
        "modified": 0,
        "moved": 0,
        "added": len(after) - size,
        "removed": len(before) - size,
    }


@pytest.mark.parametrize("reverse", [False, True])
def test_pathological_reorders_use_conservative_bounded_alignment(monkeypatch, reverse):
    before = list(map(message, "a" * 2000 + "b" * 2000))
    after = list(reversed(before))
    if reverse:
        before, after = after, before
    original = api.bisect_left
    operations = 0

    def bounded_bisect(*args, **kwargs):
        nonlocal operations
        operations += 1
        assert operations < 80_000
        return original(*args, **kwargs)

    monkeypatch.setattr(api, "bisect_left", bounded_bisect)
    diff, rows = check_diff(before, after)
    # Do not prescribe a particular approximate count: require conservative
    # matching and complete occurrence coverage, not guessed edits/moves.
    assert diff["summary"]["unchanged"] > 0
    assert diff["summary"]["moved"] == diff["summary"]["modified"] == 0
    assert all(row["before"] == row["after"] for row in rows if row["status"] == ["unchanged"])


def test_large_mixed_identity_history_does_not_rescan_every_anchor():
    import subprocess
    import sys

    # A generous process timeout is only a smoke guard. The quadratic
    # implementation rescans billions of indices on this modest (~5 MB) input.
    code = """
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('api', sys.argv[1])
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
messages = []
for i in range(30000):
    messages.extend([
        {'role': 'assistant', 'tool_calls': [{'id': str(i), 'function': {'name': 'f', 'arguments': '{}'}}]},
        {'role': 'user', 'content': 'repeat'},
    ])
diff = api._aligned_message_diff(messages, messages)
assert diff['summary'] == {'unchanged': len(messages), 'modified': 0, 'moved': 0, 'added': 0, 'removed': 0}
"""
    subprocess.run([sys.executable, "-c", code, str(MODULE_PATH)], check=True, timeout=10)


def test_leftover_reused_identity_cannot_match_conflicting_equal_payload():
    before = [call("reused"), call("anchor"), call("reused")]
    after = [call("replacement"), call("anchor"), call("reused")]
    diff, rows = check_diff(before, after)
    assert diff["summary"] == {"unchanged": 2, "modified": 0, "moved": 0, "added": 1, "removed": 1}
    assert next(row for row in rows if row["after_index"] == 2)["before_index"] == 2


def test_real_compaction_structure_preserves_retained_identity():
    fixture = json.loads((Path(__file__).parent / "fixtures" / "compaction-structure.json").read_text())
    diff, rows = check_diff(fixture["before"], fixture["after"])
    # Independently verified against the real pair, not generated expectations.
    assert diff["summary"] == {"unchanged": 122, "modified": 35, "moved": 0, "added": 4, "removed": 224}
    retained_call = next(row for row in rows if row["before_index"] == 4)
    assert retained_call["after_index"] == 2
    assert retained_call["status"] == ["unchanged"]
    shortened_result = next(row for row in rows if row["before_index"] == 6)
    assert shortened_result["after_index"] == 4
    assert shortened_result["status"] == ["modified"]
