from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

MODULE_PATH = Path(__file__).parents[1] / "__init__.py"
spec = importlib.util.spec_from_file_location("request_dump_viewer_plugin", MODULE_PATH)
plugin = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(plugin)


@pytest.fixture
def plugin_state(tmp_path, monkeypatch):
    home = tmp_path
    state_path = home / "state" / plugin._STATE_FILE
    monkeypatch.delenv(plugin._ENV_KEY, raising=False)
    plugin._last_enabled = None
    monkeypatch.setattr(plugin, "_reset_failed", False, raising=False)
    return home, state_path


def test_startup_resets_capture_state_and_environment(plugin_state):
    home, state_path = plugin_state
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"enabled": True}), encoding="utf-8")
    os.environ[plugin._ENV_KEY] = "true"

    with patch.object(plugin, "_home", return_value=home):
        plugin._reset_state_on_startup()

    assert json.loads(state_path.read_text(encoding="utf-8")) == {"enabled": False}
    assert plugin._ENV_KEY not in os.environ


def test_enabled_state_is_reflected_into_gateway_environment(plugin_state):
    home, state_path = plugin_state
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"enabled": True}), encoding="utf-8")

    with patch.object(plugin, "_home", return_value=home):
        plugin.on_pre_api_request()

    assert os.environ[plugin._ENV_KEY] == "true"


def test_disabled_state_removes_gateway_environment_flag(plugin_state):
    home, state_path = plugin_state
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"enabled": False}), encoding="utf-8")
    os.environ[plugin._ENV_KEY] = "true"

    with patch.object(plugin, "_home", return_value=home):
        plugin.on_pre_api_request()

    assert plugin._ENV_KEY not in os.environ


def test_malformed_state_fails_closed(plugin_state):
    home, state_path = plugin_state
    state_path.parent.mkdir(parents=True)
    state_path.write_text("not-json", encoding="utf-8")
    os.environ[plugin._ENV_KEY] = "true"

    with patch.object(plugin, "_home", return_value=home):
        plugin.on_pre_api_request()

    assert plugin._ENV_KEY not in os.environ


def test_failed_reset_latches_local_capture_off(plugin_state):
    home, path = plugin_state
    path.parent.mkdir()
    path.write_text('{"enabled": true}')
    os.environ[plugin._ENV_KEY] = "true"
    with patch.object(plugin, "_home", return_value=home):
        with patch.object(plugin.os, "replace", side_effect=PermissionError("synthetic denied")):
            plugin._reset_state_on_startup()
        plugin.on_pre_api_request()
        assert plugin._ENV_KEY not in os.environ
        # Stale or later enabled control files cannot override a failed reset.
        assert plugin._read_enabled() is False
        assert json.loads(path.read_text())["enabled"] is True
        plugin._reset_state_on_startup()
        path.write_text('{"enabled": true}')
        plugin.on_pre_api_request()
        assert os.environ[plugin._ENV_KEY] == "true"


def test_register_unconditionally_resets_shared_state_on_every_registration(plugin_state):
    home, path = plugin_state
    path.parent.mkdir()
    hooks = []

    class Context:
        def register_hook(self, name, callback):
            hooks.append((name, callback))

    with patch.object(plugin, "_home", return_value=home):
        for _ in range(2):
            path.write_text('{"enabled": true}')
            os.environ[plugin._ENV_KEY] = "true"
            plugin.register(Context())
            assert json.loads(path.read_text()) == {"enabled": False}
            assert plugin._ENV_KEY not in os.environ
    assert hooks == [("pre_api_request", plugin.on_pre_api_request)] * 2


def test_missing_state_preserves_legacy_environment_fallback(plugin_state):
    home, _state_path = plugin_state
    os.environ[plugin._ENV_KEY] = "yes"

    with patch.object(plugin, "_home", return_value=home):
        plugin.on_pre_api_request()

    assert os.environ[plugin._ENV_KEY] == "true"
