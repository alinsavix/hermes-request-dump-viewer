"""Synthetic security regressions; never inspect real request dumps."""

import random
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

import pytest
from test_backend_safety import http
from test_request_analysis import MODULE_PATH, _write_dump, api


def test_url_redaction_handles_long_scheme_like_text_with_bounded_work():
    code = """
import importlib.util, sys
s = importlib.util.spec_from_file_location('api', sys.argv[1])
api = importlib.util.module_from_spec(s)
s.loader.exec_module(api)
text = 'a.' * 128000
assert api._redact(text) == text
"""
    # Generous process budget rather than a fragile sub-millisecond benchmark.
    subprocess.run([sys.executable, "-c", code, str(MODULE_PATH)], check=True, capture_output=True, timeout=5)


@pytest.mark.parametrize("prefix", ["", "See ", "(see:", "9.", "a_", "é", "prefix."])
@pytest.mark.parametrize("scheme", ["https", "HTTPS", "git+https", "custom.v1"])
def test_url_tokens_keep_credential_masking_and_surrounding_text(prefix, scheme):
    value = prefix + scheme + "://user:synthetic@example.test/path?key=synthetic&view=full END"
    # Differential contract for short inputs only, never the old hostile pattern.
    old = re.compile(r"(?:\b[a-z][a-z0-9+.-]*://|(?<!\S)//)[^\s<>\"']+", re.IGNORECASE)
    assert api._redact_urls_in_text(value) == old.sub(lambda m: api._redact_url(m.group()), value)


def test_delimiter_scanner_preserves_old_token_boundaries_on_short_inputs():
    old = re.compile(r"(?:\b[a-z][a-z0-9+.-]*://|(?<!\S)//)[^\s<>\"']+", re.IGNORECASE)
    rng = random.Random(0)
    pieces = ["a.", "1_", "https", "://", "//", "x?key=synthetic", " ", "\n", "<", "'", "é", "İ"]
    for _ in range(3000):
        value = "".join(rng.choices(pieces, k=12))
        assert api._redact_urls_in_text(value) == old.sub(lambda m: api._redact_url(m.group()), value)


def test_listing_redacts_entire_long_url_before_preview_truncation(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    credential = "synthetic-" * 1000
    content = "https://example.test/?key=" + credential + "&view=full"
    _write_dump(
        tmp_path,
        "request_dump_long.json",
        session_id="safe",
        timestamp="2026-01-01",
        mtime=100,
        messages=[{"role": "user", "content": content}],
    )
    status, listing = http("/dumps")
    assert status == 200
    preview = listing["items"][0]["preview"]
    assert "synthetic" not in preview
    assert parse_qs(urlsplit(preview).query) == {"key": [api._REDACTED], "view": ["full"]}
