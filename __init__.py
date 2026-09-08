"""Gateway half of request-dump-viewer: live preflight capture toggle.

The dashboard process and gateway process cannot share ``os.environ``. They do
share HERMES_HOME, so the dashboard writes a tiny atomic JSON control file and
this pre_api_request hook reflects it into the gateway environment immediately
before conversation_loop checks HERMES_DUMP_REQUESTS for the same request.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
_ENV_KEY = "HERMES_DUMP_REQUESTS"
_STATE_FILE = "request-dump-viewer-state.json"
_last_enabled: bool | None = None


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _state_path() -> Path:
    return _home() / "state" / _STATE_FILE


def _read_enabled() -> bool:
    path = _state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return bool(data.get("enabled", False)) if isinstance(data, dict) else False
    except FileNotFoundError:
        # Seed persistent state from the startup environment for compatibility
        # with users who already enabled capture through ~/.hermes/.env.
        value = os.environ.get(_ENV_KEY, "")
        return value.strip().lower() in {"1", "true", "yes", "on"}
    except Exception as exc:
        # Fail closed for routine dumps; diagnostic error dumps remain enabled
        # independently inside conversation_loop.
        logger.warning("request-dump-viewer: could not read toggle state: %s", exc)
        return False


def _reset_state_on_startup() -> None:
    """Make capture opt-in for each gateway process lifetime."""
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps({"enabled": False}, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        os.environ.pop(_ENV_KEY, None)
    except Exception as exc:
        # The pre-request hook still fails closed if the state file cannot be
        # written; keep startup resilient and make the failure visible.
        logger.warning("request-dump-viewer: could not reset capture state: %s", exc)


def on_pre_api_request(**_kwargs: Any) -> None:
    global _last_enabled
    enabled = _read_enabled()
    if enabled:
        os.environ[_ENV_KEY] = "true"
    else:
        os.environ.pop(_ENV_KEY, None)
    if enabled != _last_enabled:
        logger.info("request-dump-viewer: live preflight capture %s", "enabled" if enabled else "disabled")
        _last_enabled = enabled


def register(ctx) -> None:
    _reset_state_on_startup()
    ctx.register_hook("pre_api_request", on_pre_api_request)
