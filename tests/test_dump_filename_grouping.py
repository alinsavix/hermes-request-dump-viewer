"""Filename-index regressions use synthetic dumps in temporary homes only."""

from __future__ import annotations

import hashlib
import json
import os
import time
from unittest.mock import patch

import pytest
from test_request_analysis import _write_dump, api


def native(home, session_id, index, *, component=None, mtime=100):
    return _write_dump(
        home,
        f"request_dump_{component or session_id}_20260913_120000_{index:06d}.json",
        session_id=session_id,
        timestamp=f"2026-09-13T12:00:00.{index:06d}",
        mtime=mtime,
    )


def test_sidebar_loads_one_snapshot_per_filename_group(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    paths = [native(tmp_path, "20260913_091500_arbitrary_safe_id", i) for i in range(20)]
    with patch.object(api, "_load", wraps=api._load) as load:
        result = api.list_dumps(limit=1)
    assert load.call_count == 1
    assert result["items"][0]["file"] == paths[-1].name
    assert result["items"][0]["request_count"] == len(paths)
    assert result["dump_count"] == len(paths)
    assert result["total_bytes"] == paths[-1].stat().st_size


def test_corrupt_newest_uses_next_snapshot_but_counts_all_files(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    paths = [native(tmp_path, "alpha", i) for i in range(5)]
    paths[-1].write_text("{broken", encoding="utf-8")
    with patch.object(api, "_load", wraps=api._load) as load:
        result = api.list_dumps(limit=1)
    assert result["items"][0]["file"] == paths[-2].name
    assert result["items"][0]["request_count"] == len(paths)
    assert result["dump_count"] == len(paths)
    assert load.call_count == 2


def test_mismatched_representative_falls_back_to_json_grouping(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    older = native(tmp_path, "alpha", 1)
    wrong = native(tmp_path, "beta", 2, component="alpha")
    with patch.object(api, "_load", wraps=api._load) as load:
        result = api.list_dumps(limit=20)
    assert {item["session_id"]: item["request_count"] for item in result["items"]} == {"alpha": 1, "beta": 1}
    assert {item["file"] for item in result["items"]} == {older.name, wrong.name}
    assert load.call_count == 2


def test_timeline_reads_requested_component_plus_legacy_only(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    requested = [native(tmp_path, "alpha_with_underscores", i) for i in range(3)]
    for i in range(12):
        native(tmp_path, "other_session", i)
    legacy = _write_dump(
        tmp_path, "request_dump_legacy.json", session_id="alpha_with_underscores", timestamp="2026-09-13T11:00:00", mtime=900
    )
    wrong = native(tmp_path, "other_session", 9, component="alpha_with_underscores")
    with patch.object(api, "_load", wraps=api._load) as load:
        result = api.get_session_timeline("alpha_with_underscores")
    assert {call.args[0] for call in load.call_args_list} == {path.name for path in [*requested, legacy, wrong]}
    assert [item["file"] for item in result["items"]] == [legacy.name, *(path.name for path in requested)]
    assert result["items"][-1]["previous_file"] == requested[-2].name


def test_symlinks_oversize_and_invalid_paths_are_not_counted_or_loaded(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    good = native(tmp_path, "safe", 1)
    linked = good.with_name("request_dump_safe_20260913_120000_000002.json")
    linked.symlink_to(good)
    oversized = native(tmp_path, "safe", 3)
    with oversized.open("r+b") as handle:
        handle.truncate(api._MAX_FILE_BYTES + 1)
    good.with_name("request_dump_safe_20260913_120000_000004.json").mkdir()
    good.with_name("request_dump_bad name.json").write_text("{}")
    with patch.object(api, "_load", wraps=api._load) as load:
        listing = api.list_dumps(limit=1)
        timeline = api.get_session_timeline("safe")
    assert listing["dump_count"] == listing["items"][0]["request_count"] == 1
    assert timeline["count"] == 1
    assert [call.args[0] for call in load.call_args_list] == [good.name, good.name]


def test_legacy_component_with_native_timestamp_still_uses_json(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    # Older/custom writers used dots literally; current Hermes hashes them.
    old_writer = native(tmp_path, "session.alias", 1)
    with patch.object(api, "_load", wraps=api._load) as load:
        timeline = api.get_session_timeline("session.alias")
    assert [item["file"] for item in timeline["items"]] == [old_writer.name]
    assert load.call_count == 1


@pytest.mark.parametrize("session_id,prefix", [("session.alias", "session_alias"), ("_alias_", "alias"), ("s" * 110, "s" * 96)])
def test_sanitized_aliases_keep_actual_json_session_id(tmp_path, monkeypatch, session_id, prefix):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    component = prefix + "_" + hashlib.sha256(session_id.encode()).hexdigest()[:12]
    paths = [native(tmp_path, session_id, i, component=component) for i in range(3)]
    ordinary = native(tmp_path, prefix, 9)
    with patch.object(api, "_load", wraps=api._load) as load:
        listing = api.list_dumps(limit=20)
    assert load.call_count == 2
    assert {item["session_id"]: item["request_count"] for item in listing["items"]} == {session_id: 3, prefix: 1}
    with patch.object(api, "_load", wraps=api._load) as load:
        timeline = api.get_session_timeline(session_id)
    assert [item["file"] for item in timeline["items"]] == [path.name for path in paths]
    assert ordinary.name not in {call.args[0] for call in load.call_args_list}


@pytest.mark.parametrize("limit", [1, 2, 20])
def test_multiple_groups_use_filename_time_not_copied_mtime(tmp_path, monkeypatch, limit):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    expected = []
    for index, session in enumerate(("alpha", "beta", "gamma")):
        group = [native(tmp_path, session, index * 10 + step, mtime=10000 - index * 10 - step) for step in range(5)]
        expected.append(group[-1])
    with patch.object(api, "_load", wraps=api._load) as load:
        listing = api.list_dumps(limit=limit)
    # Limit controls returned rows, not the stat scan or representative checks.
    assert load.call_count == 3
    assert listing["dump_count"] == 15
    assert [item["file"] for item in listing["items"]] == [path.name for path in reversed(expected)][:limit]
    assert all(item["request_count"] == 5 for item in listing["items"])
    assert listing["count"] == min(limit, 3)


def test_unknown_names_merge_by_json_and_keep_error_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    recognized = [native(tmp_path, "alpha", i) for i in range(3)]
    legacy = _write_dump(tmp_path, "request_dump_old.json", session_id="alpha", timestamp="ignored-for-legacy-list", mtime=100)
    invalid_date = _write_dump(
        tmp_path, "request_dump_mislabeled_20269999_250000_000000.json", session_id="alpha", timestamp="", mtime=101
    )
    corrupt = legacy.with_name("request_dump_unknown_corrupt.json")
    corrupt.write_text("null")
    os.utime(corrupt, (99, 99))
    with patch.object(api, "_load", wraps=api._load) as load:
        listing = api.list_dumps(limit=20)
    assert load.call_count == 4
    assert listing["dump_count"] == len(recognized) + 3
    assert listing["items"][0]["request_count"] == 5
    assert listing["items"][0]["file"] == recognized[-1].name
    assert listing["items"][1]["file"] == corrupt.name
    assert "parse_error" in listing["items"][1]
    timeline = api.get_session_timeline("alpha")
    assert {item["file"] for item in timeline["items"]} == {path.name for path in [*recognized, legacy, invalid_date]}


def test_all_corrupt_group_preserves_filename_error_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    paths = [native(tmp_path, "alpha", i) for i in range(3)]
    for path in paths:
        path.write_text("{broken")
    listing = api.list_dumps(limit=20)
    assert listing["count"] == listing["dump_count"] == 3
    assert all("parse_error" in item for item in listing["items"])
    assert {item["file"] for item in listing["items"]} == {path.name for path in paths}


def test_temp_100_mib_cumulative_snapshot_benchmark(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    messages = [{"role": "system", "content": "Synthetic instructions " + "x" * 950000}]
    paths = []
    for index in range(100):
        messages.append({"role": "user" if index % 2 == 0 else "assistant", "content": f"Synthetic turn {index}"})
        path = native(tmp_path, "benchmark_session", index)
        data = json.loads(path.read_text())
        data["request"]["body"]["messages"] = messages
        encoded = json.dumps(data).encode()
        path.write_bytes(encoded + b" " * (1024 * 1024 - len(encoded)))
        paths.append(path)
    assert sum(path.stat().st_size for path in paths) == 100 * 1024 * 1024
    with patch.object(api, "_load", wraps=api._load) as load, patch.object(api, "_summary", wraps=api._summary) as summary:
        start = time.perf_counter()
        listing = api.list_dumps(limit=1)
        elapsed = time.perf_counter() - start
    assert load.call_count == summary.call_count == 1
    assert listing["dump_count"] == listing["items"][0]["request_count"] == 100
    assert listing["items"][0]["message_count"] == len(messages)
    print(
        f"\n100 x 1 MiB cumulative snapshots: list(limit=1) {elapsed:.6f}s; _load={load.call_count}, _summary={summary.call_count}"
    )
