from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "__init__.py"
spec = importlib.util.spec_from_file_location("request_dump_viewer_plugin", MODULE_PATH)
plugin = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(plugin)


class CaptureToggleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = Path(self.temp_dir.name)
        self.state_path = self.home / "state" / plugin._STATE_FILE
        self.env = patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop(plugin._ENV_KEY, None)
        plugin._last_enabled = None

    def tearDown(self):
        self.env.stop()
        self.temp_dir.cleanup()

    def test_startup_resets_capture_state_and_environment(self):
        self.state_path.parent.mkdir(parents=True)
        self.state_path.write_text(json.dumps({"enabled": True}), encoding="utf-8")
        os.environ[plugin._ENV_KEY] = "true"

        with patch.object(plugin, "_home", return_value=self.home):
            plugin._reset_state_on_startup()

        self.assertEqual(json.loads(self.state_path.read_text(encoding="utf-8")), {"enabled": False})
        self.assertNotIn(plugin._ENV_KEY, os.environ)

    def test_enabled_state_is_reflected_into_gateway_environment(self):
        self.state_path.parent.mkdir(parents=True)
        self.state_path.write_text(json.dumps({"enabled": True}), encoding="utf-8")

        with patch.object(plugin, "_home", return_value=self.home):
            plugin.on_pre_api_request()

        self.assertEqual(os.environ[plugin._ENV_KEY], "true")

    def test_disabled_state_removes_gateway_environment_flag(self):
        self.state_path.parent.mkdir(parents=True)
        self.state_path.write_text(json.dumps({"enabled": False}), encoding="utf-8")
        os.environ[plugin._ENV_KEY] = "true"

        with patch.object(plugin, "_home", return_value=self.home):
            plugin.on_pre_api_request()

        self.assertNotIn(plugin._ENV_KEY, os.environ)

    def test_malformed_state_fails_closed(self):
        self.state_path.parent.mkdir(parents=True)
        self.state_path.write_text("not-json", encoding="utf-8")
        os.environ[plugin._ENV_KEY] = "true"

        with patch.object(plugin, "_home", return_value=self.home):
            plugin.on_pre_api_request()

        self.assertNotIn(plugin._ENV_KEY, os.environ)

    def test_missing_state_preserves_legacy_environment_fallback(self):
        os.environ[plugin._ENV_KEY] = "yes"

        with patch.object(plugin, "_home", return_value=self.home):
            plugin.on_pre_api_request()

        self.assertEqual(os.environ[plugin._ENV_KEY], "true")


if __name__ == "__main__":
    unittest.main()
