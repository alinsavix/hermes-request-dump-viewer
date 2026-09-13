from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from test_request_analysis import _write_dump, api


def test_dump_listing_redacts_credentials_embedded_in_provider_url():
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        path = _write_dump(
            root,
            "request_dump_listing_redaction.json",
            session_id="alpha",
            timestamp="2026-08-16T10:00:00Z",
            mtime=100,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        data["request"]["url"] = "https://example.test/v1?api_key=list-api-secret&view=full"
        path.write_text(json.dumps(data), encoding="utf-8")
        with patch.object(api, "get_hermes_home", return_value=root):
            listing = api.list_dumps(limit=200)

    serialized = json.dumps(listing, ensure_ascii=False)
    assert "list-api-secret" not in serialized
    url = listing["items"][0]["url"]
    assert parse_qs(urlsplit(url).query)["api_key"] == ["••••••••"]
    assert parse_qs(urlsplit(url).query)["view"] == ["full"]
