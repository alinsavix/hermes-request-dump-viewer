"""Read-only backend for the Hermes request-dump desktop viewer."""

from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

try:
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover - local test fallback

    def get_hermes_home() -> Path:
        return Path.home() / ".hermes"


router = APIRouter()
_FILE_RE = re.compile(r"^request_dump_[A-Za-z0-9_.-]+\.json$")
_SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]{1,200}$")
_SECRET_KEYS = {
    "authorization",
    "proxy_authorization",
    "api_key",
    "x_api_key",
    "cookie",
    "set_cookie",
    "access_token",
    "client_secret",
    "password",
    "token",
    "x_auth_token",
    "refresh_token",
}
_REDACTED = "••••••••"
_MAX_FILE_BYTES = 32 * 1024 * 1024
_STATE_FILE = "request-dump-viewer-state.json"


class CaptureState(BaseModel):
    enabled: bool


def _root() -> Path:
    return Path(get_hermes_home()) / "sessions"


def _state_path() -> Path:
    return Path(get_hermes_home()) / "state" / _STATE_FILE


def _startup_enabled() -> bool:
    value = os.environ.get("HERMES_DUMP_REQUESTS", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _read_capture_state() -> tuple[bool, str]:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("enabled"), bool):
            return data["enabled"], "live"
    except FileNotFoundError:
        pass
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read capture state: {exc}") from exc
    return _startup_enabled(), "startup_env"


def _write_capture_state(enabled: bool) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"enabled": enabled}, indent=2) + "\n"
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as tmp:
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_name = tmp.name
        os.replace(tmp_name, path)
    except OSError as exc:
        if tmp_name:
            with contextlib.suppress(OSError):
                Path(tmp_name).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not save capture state: {exc}") from exc


@router.get("/capture")
def get_capture_state():
    enabled, source = _read_capture_state()
    return {"enabled": enabled, "source": source}


@router.put("/capture")
def set_capture_state(state: CaptureState):
    _write_capture_state(state.enabled)
    return {"enabled": state.enabled, "source": "live"}


def _dump_path(name: str) -> Path:
    if not _FILE_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="Invalid request dump filename")
    path = _root() / name
    if path.is_symlink() or not path.is_file():
        raise HTTPException(status_code=404, detail="Request dump not found")
    if path.stat().st_size > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Request dump exceeds 32 MiB viewer limit")
    return path


def _load(name: str) -> dict[str, Any]:
    try:
        value = json.loads(_dump_path(name).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Request dump root must be an object")
    return value


def _redact(value: Any, key: str = "") -> Any:
    if key.casefold().replace("-", "_") in _SECRET_KEYS:
        return _REDACTED
    if isinstance(value, dict):
        return {k: _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str) and "?" in value:
        parts = urlsplit(value)
        query = parse_qsl(parts.query, keep_blank_values=True)
        if any(name.casefold().replace("-", "_") in _SECRET_KEYS for name, _ in query):
            safe_query = [(name, _REDACTED if name.casefold().replace("-", "_") in _SECRET_KEYS else item) for name, item in query]
            return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(safe_query), parts.fragment))
    return value


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return json.dumps(content, ensure_ascii=False, indent=2)


def _normalized_messages(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Return one viewer shape for Chat Completions and Responses requests.

    Responses requests put the system/developer-equivalent prompt in the
    top-level ``instructions`` field and put history in ``input``.  Fold the
    instructions into a synthetic system message so the existing message
    viewer can display it without changing the Chat Completions path.
    """
    messages = body.get("messages")
    if isinstance(messages, list):
        return _link_tool_results([item for item in messages if isinstance(item, dict)])

    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [{"role": "user", "content": inputs}]
    normalized: list[dict[str, Any]] = []
    instructions = body.get("instructions")
    if instructions is not None:
        normalized.append(
            {
                "role": "system",
                "content": instructions,
                "_responses_kind": "instructions",
            }
        )

    if not isinstance(inputs, list):
        return normalized

    # Responses API output records carry only call_id; recover the human tool
    # name from the matching function_call record elsewhere in the input.
    call_names = {
        str(item.get("call_id")): str(item.get("name"))
        for item in inputs
        if isinstance(item, dict)
        and item.get("type") == "function_call"
        and item.get("call_id") is not None
        and item.get("name") is not None
    }

    for item in inputs:
        if not isinstance(item, dict):
            normalized.append({"role": "input", "content": item})
            continue
        item_type = item.get("type")
        if item_type == "function_call":
            normalized.append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": item.get("call_id"),
                            "type": "function",
                            "function": {
                                "name": item.get("name"),
                                "arguments": item.get("arguments", "{}"),
                            },
                        }
                    ],
                }
            )
        elif item_type == "function_call_output":
            call_id = item.get("call_id")
            normalized.append(
                {
                    "role": "tool",
                    "name": call_names.get(str(call_id)) if call_id is not None else None,
                    "content": item.get("output", ""),
                    "tool_call_id": call_id,
                }
            )
        elif item_type == "reasoning":
            # Keep the provider's reasoning record visible, but label it
            # explicitly.  encrypted_content is intentionally not decoded.
            normalized.append(
                {
                    "role": "reasoning",
                    "content": {
                        "summary": item.get("summary", []),
                        "encrypted_content": item.get("encrypted_content"),
                    },
                }
            )
        elif item_type == "message":
            normalized.append(
                {
                    "role": item.get("role", "assistant"),
                    "content": item.get("content", ""),
                    **({"status": item["status"]} if "status" in item else {}),
                    **({"phase": item["phase"]} if "phase" in item else {}),
                }
            )
        elif "role" in item:
            normalized.append(item)
        else:
            normalized.append(
                {
                    "role": str(item_type or "input"),
                    "content": {k: v for k, v in item.items() if k != "type"},
                }
            )
    return _link_tool_results(normalized)


def _link_tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach each result's originating call for compact UI labels."""
    calls_by_id: dict[str, dict[str, Any]] = {}
    for message in messages:
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if not isinstance(call, dict):
                continue
            call_id = call.get("id") or call.get("call_id")
            if call_id is not None:
                calls_by_id[str(call_id)] = call

    linked: list[dict[str, Any]] = []
    for message in messages:
        item = dict(message)
        call_id = item.get("tool_call_id")
        matching_call = calls_by_id.get(str(call_id)) if call_id is not None else None
        if item.get("role") == "tool" and matching_call is not None:
            item["_tool_call"] = matching_call
            fn = matching_call.get("function")
            if not item.get("name") and isinstance(fn, dict) and fn.get("name"):
                item["name"] = fn["name"]
        linked.append(item)
    return linked


def _compact_text(value: Any) -> str:
    """Return stable text for request-size estimates and UI previews."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _estimated_tokens(characters: int) -> int:
    """Cheap provider-neutral token estimate, explicitly labelled in the UI."""
    return (max(0, characters) + 3) // 4


def _message_characters(message: dict[str, Any]) -> int:
    return len(_compact_text(message))


def _prompt_category(title: str) -> str:
    value = title.casefold()
    if value == "core instructions":
        return "Core prompt"
    if "memory" in value and "tool" not in value:
        return "Persistent memory"
    if "user profile" in value:
        return "User profile"
    if "session context" in value:
        return "Session context"
    if "skill" in value or "available_skills" in value:
        return "Skills"
    if any(token in value for token in ("soul", "who you are", "identity", "voice style")):
        return "Identity & voice"
    if any(
        token in value
        for token in (
            "finishing the job",
            "parallel tool",
            "tool-use enforcement",
            "execution discipline",
            "skill safety",
            "verification",
            "prerequisite",
            "missing context",
            "missing_context",
        )
    ):
        return "Operating rules"
    if "tool" in value:
        return "Tool instructions"
    return "Injected instructions"


def _prompt_sections(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Split system/instructions messages into recognizable injected sections."""
    heading = re.compile(r"^#{1,6}\s+(.+?)\s*$")
    bare = re.compile(
        r"^(MEMORY \(your personal notes\)|USER PROFILE \(who the user is\)|Current Session Context)\s*$",
        re.IGNORECASE,
    )
    sections: list[dict[str, Any]] = []

    def append_section(title: str, lines: list[str], message_index: int) -> None:
        content = "\n".join(lines).strip()
        if not content:
            return
        sections.append(
            {
                "id": f"prompt-{message_index}-{len(sections)}",
                "title": title,
                "category": _prompt_category(title),
                "content": content,
                "characters": len(content),
                "estimated_tokens": _estimated_tokens(len(content)),
                "message_index": message_index,
            }
        )

    for message_index, message in enumerate(messages):
        if message.get("role") != "system":
            continue
        content = _content_text(message.get("content"))
        current_title = "Core instructions"
        current_lines: list[str] = []
        for line in content.splitlines():
            heading_match = heading.match(line)
            bare_match = bare.match(line)
            if heading_match or bare_match:
                append_section(current_title, current_lines, message_index)
                current_title = (heading_match.group(1) if heading_match else bare_match.group(1)).strip()
                current_lines = []
            else:
                current_lines.append(line)
        append_section(current_title, current_lines, message_index)
    return sections


def _parsed_arguments(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


def _tool_flow(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Pair tool calls with result messages using their provider call IDs."""
    results_by_id: dict[str, list[dict[str, Any]]] = {}
    all_results: list[dict[str, Any]] = []
    for message_index, message in enumerate(messages):
        if message.get("role") != "tool":
            continue
        result = {
            "call_id": message.get("tool_call_id"),
            "message_index": message_index,
            "name": message.get("name"),
            "content": message.get("content"),
        }
        all_results.append(result)
        if result["call_id"] is not None:
            results_by_id.setdefault(str(result["call_id"]), []).append(result)

    interactions: list[dict[str, Any]] = []
    known_ids: set[str] = set()
    for message_index, message in enumerate(messages):
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call_index, call in enumerate(calls):
            if not isinstance(call, dict):
                continue
            fn = call.get("function") if isinstance(call.get("function"), dict) else call
            raw_id = call.get("id") or call.get("call_id")
            call_id = str(raw_id) if raw_id is not None else f"message-{message_index}-call-{call_index}"
            if raw_id is not None:
                known_ids.add(call_id)
            results = results_by_id.get(call_id, []) if raw_id is not None else []
            status = "matched" if len(results) == 1 else "multiple_results" if len(results) > 1 else "missing_result"
            interactions.append(
                {
                    "call_id": call_id,
                    "name": fn.get("name") or call.get("name") or "tool call",
                    "call_message_index": message_index,
                    "call_index": call_index,
                    "arguments": _parsed_arguments(fn.get("arguments", call.get("arguments"))),
                    "results": [{key: result[key] for key in ("message_index", "name", "content")} for result in results],
                    "status": status,
                }
            )

    orphaned = [result for result in all_results if str(result.get("call_id")) not in known_ids]
    return interactions, orphaned


def _analyze_request(body: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Build provider-neutral composition, prompt-map, and tool-flow data."""
    system_indices = [i for i, message in enumerate(messages) if message.get("role") == "system"]
    user_indices = [i for i, message in enumerate(messages) if message.get("role") == "user"]
    current_user_indices = user_indices[-1:] if user_indices else []
    excluded = set(system_indices + current_user_indices)
    history_indices = [i for i in range(len(messages)) if i not in excluded]

    option_body = {key: value for key, value in body.items() if key not in {"messages", "input", "instructions", "tools"}}
    part_specs = [
        (
            "instructions",
            "Instructions / system",
            system_indices,
            sum(_message_characters(messages[i]) for i in system_indices),
        ),
        (
            "history",
            "Conversation history",
            history_indices,
            sum(_message_characters(messages[i]) for i in history_indices),
        ),
        (
            "current_user",
            "Current user input",
            current_user_indices,
            sum(_message_characters(messages[i]) for i in current_user_indices),
        ),
        ("tools", "Tool schemas", [], len(_compact_text(body.get("tools") or []))),
        ("options", "Request options", [], len(_compact_text(option_body))),
    ]
    parts = [
        {
            "key": key,
            "label": label,
            "characters": characters,
            "estimated_tokens": _estimated_tokens(characters),
            "message_indices": indices,
        }
        for key, label, indices, characters in part_specs
    ]
    total_characters = sum(part["characters"] for part in parts)
    interactions, orphaned = _tool_flow(messages)
    return {
        "composition": {
            "parts": parts,
            "total_characters": total_characters,
            "estimated_tokens": _estimated_tokens(total_characters),
            "estimation": "Characters use compact JSON; tokens use a provider-neutral 4 characters/token estimate.",
        },
        "prompt_sections": _prompt_sections(messages),
        "tool_interactions": interactions,
        "orphan_tool_results": orphaned,
    }


def _tool_names(messages: list[Any]) -> list[str]:
    names: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict):
                fn = call.get("function") or {}
                name = fn.get("name") if isinstance(fn, dict) else None
                if name and name not in names:
                    names.append(str(name))
    return names


def _summary(path: Path, include_preview: bool = False) -> dict[str, Any]:
    stat = path.stat()
    out: dict[str, Any] = {
        "file": path.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(),
    }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        request = data.get("request") if isinstance(data, dict) else {}
        body = request.get("body") if isinstance(request, dict) else {}
        messages = _normalized_messages(body) if isinstance(body, dict) else []
        instructions = body.get("instructions") if isinstance(body, dict) else None
        inputs = body.get("input") if isinstance(body, dict) else None
        out.update(
            {
                "timestamp": data.get("timestamp"),
                "session_id": data.get("session_id"),
                "reason": data.get("reason"),
                "method": request.get("method") if isinstance(request, dict) else None,
                # The list endpoint is fetched automatically by the dashboard;
                # never expose credentials embedded in provider URLs here.
                "url": _redact(request.get("url")) if isinstance(request, dict) else None,
                "model": body.get("model") if isinstance(body, dict) else None,
                "message_count": len(messages),
                "tool_schema_count": len(body.get("tools") or []) if isinstance(body, dict) else 0,
                "tool_names": _tool_names(messages),
                "input_format": "responses" if "input" in body else "chat_completions" if "messages" in body else "unknown",
                "instruction_length": len(instructions) if isinstance(instructions, str) else 0,
                "input_item_count": len(inputs) if isinstance(inputs, list) else (1 if isinstance(inputs, str) else 0),
            }
        )
        if include_preview:
            user = next(
                (m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"),
                None,
            )
            out["preview"] = _content_text(user.get("content"))[:240] if user else ""
    except Exception as exc:
        out["parse_error"] = str(exc)
    return out


def _dump_sort_key(data: dict[str, Any], path: Path) -> tuple[float, str]:
    """Order dumps by their embedded timestamp, falling back to mtime."""
    try:
        sort_time = datetime.fromisoformat(str(data.get("timestamp")).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        sort_time = path.stat().st_mtime
    return sort_time, path.name


@router.get("/dumps")
def list_dumps(limit: int = Query(200, ge=1, le=1000)):
    root = _root()
    if not root.exists():
        return {"items": [], "count": 0, "total_bytes": 0, "dump_count": 0}
    paths = sorted(
        (p for p in root.glob("request_dump_*.json") if not p.is_symlink() and p.is_file() and p.stat().st_size <= _MAX_FILE_BYTES),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    # Dumps are cumulative request snapshots. Keep only the newest file for
    # each session in the browser list, while retaining every file on disk for
    # the per-request diff view. Because paths are newest-first, the first
    # occurrence of a session id wins. Malformed dumps get their own filename
    # key so one bad file cannot hide another.
    summaries = [(path, _summary(path, include_preview=True)) for path in paths]
    request_counts: dict[str, int] = {}
    for _, summary in summaries:
        session_id = summary.get("session_id")
        if session_id is not None and "parse_error" not in summary:
            key = str(session_id)
            request_counts[key] = request_counts.get(key, 0) + 1

    items: list[dict[str, Any]] = []
    seen_sessions: set[str] = set()
    for path, item in summaries:
        key = str(item.get("session_id") or f"file:{path.name}")
        if key in seen_sessions:
            continue
        seen_sessions.add(key)
        item["request_count"] = request_counts.get(key, 1)
        items.append(item)
        if len(items) >= limit:
            break

    return {
        "items": items,
        "count": len(items),
        "total_bytes": sum(i["size"] for i in items),
        "dump_count": len(paths),
    }


@router.get("/sessions/{session_id}/timeline")
def get_session_timeline(session_id: str):
    """Return safe, compact metrics for each request in one session."""
    if not _SESSION_RE.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    root = _root()
    candidates = (
        sorted(
            (
                path
                for path in root.glob("request_dump_*.json")
                if path.is_file() and not path.is_symlink() and _FILE_RE.fullmatch(path.name)
            ),
            key=lambda path: path.stat().st_mtime,
        )
        if root.exists()
        else []
    )

    timeline: list[dict[str, Any]] = []
    for path in candidates:
        try:
            data = _load(path.name)
        except HTTPException:
            continue
        if data.get("session_id") != session_id:
            continue
        request = data.get("request") if isinstance(data.get("request"), dict) else {}
        body = request.get("body") if isinstance(request.get("body"), dict) else None
        messages = _normalized_messages(body) if body is not None else []
        composition = _analyze_request(body, messages)["composition"] if body is not None else None
        timestamp = data.get("timestamp")
        timeline.append(
            {
                "_sort_key": _dump_sort_key(data, path),
                "file": path.name,
                "timestamp": timestamp,
                "model": body.get("model") if body is not None else None,
                "reason": data.get("reason"),
                "message_count": len(messages),
                "size": path.stat().st_size,
                "characters": composition["total_characters"] if composition is not None else None,
                "estimated_tokens": composition["estimated_tokens"] if composition is not None else None,
            }
        )

    timeline.sort(key=lambda item: item["_sort_key"])
    for index, item in enumerate(timeline):
        item.pop("_sort_key")
        item["sequence"] = index + 1
        previous = timeline[index - 1] if index else None
        item["size_delta"] = item["size"] - previous["size"] if previous is not None else None
        current_tokens = item["estimated_tokens"]
        previous_tokens = previous["estimated_tokens"] if previous is not None else None
        item["token_delta"] = (
            current_tokens - previous_tokens if current_tokens is not None and previous_tokens is not None else None
        )
        item["previous_file"] = previous["file"] if previous is not None else None
        item["next_file"] = timeline[index + 1]["file"] if index + 1 < len(timeline) else None
    return {"session_id": session_id, "items": timeline, "count": len(timeline)}


@router.get("/sessions/{session_id}/outcome")
def get_session_outcome(session_id: str):
    """Return the final stored assistant response for a Hermes session."""
    if not _SESSION_RE.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    database = Path(get_hermes_home()) / "state.db"
    if not database.is_file():
        return {"session_id": session_id, "found": False, "reason": "Session database unavailable"}
    try:
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        session = connection.execute("SELECT source, ended_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
        message = connection.execute(
            "SELECT id, content, timestamp FROM messages "
            "WHERE session_id = ? AND role = 'assistant' AND active = 1 "
            "AND TRIM(COALESCE(content, '')) <> '' ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        connection.close()
    except sqlite3.Error:
        return {"session_id": session_id, "found": False, "reason": "Session database unreadable"}
    if message is None:
        return {
            "session_id": session_id,
            "found": False,
            "reason": "No stored assistant response",
            "source": session["source"] if session else None,
            "ended": bool(session and session["ended_at"] is not None),
        }
    return {
        "session_id": session_id,
        "found": True,
        "content": message["content"],
        "message_id": message["id"],
        "timestamp": message["timestamp"],
        "source": session["source"] if session else None,
        "ended": bool(session and session["ended_at"] is not None),
    }


@router.delete("/dumps")
def delete_all_dumps():
    """Delete every request_dump_*.json file in the sessions directory.

    Destructive and intentionally coarse (no per-file selection) — this
    mirrors the "clean up when I'm done exploring" workflow the viewer was
    built for. Filenames are re-validated against the same pattern used for
    single-file reads so this can never touch anything outside the dump
    naming convention, even though it already only globs request_dump_*.json.
    """
    root = _root()
    if not root.exists():
        return {"deleted": 0, "failed": 0, "errors": []}
    deleted = 0
    errors: list[str] = []
    for path in sorted(root.glob("request_dump_*.json")):
        if not path.is_file() or not _FILE_RE.fullmatch(path.name):
            continue
        try:
            path.unlink()
            deleted += 1
        except OSError as exc:
            errors.append(f"{path.name}: {exc}")
    return {"deleted": deleted, "failed": len(errors), "errors": errors}


@router.get("/dumps/{name}/raw")
def get_raw_dump(name: str):
    """Return the exact on-disk request dump after normal filename and size checks."""
    return _load(name)


@router.get("/dumps/{name}")
def get_dump(name: str):
    data = _load(name)
    request = data.get("request") if isinstance(data.get("request"), dict) else {}
    body = request.get("body") if isinstance(request.get("body"), dict) else {}
    messages = _normalized_messages(body)
    tools = body.get("tools") if isinstance(body.get("tools"), list) else []
    response = data.get("response")
    return {
        "meta": _redact(_summary(_dump_path(name), include_preview=False)),
        "request": {
            "method": request.get("method"),
            "url": _redact(request.get("url")),
            "headers": _redact(request.get("headers") or {}),
            "body_options": _redact({k: v for k, v in body.items() if k not in {"messages", "input", "instructions", "tools"}}),
        },
        "messages": _redact(messages),
        "tools": _redact(tools),
        "analysis": _redact(_analyze_request(body, messages)),
        "response": _redact(response),
        "error": _redact(data.get("error")),
    }


@router.get("/dumps/{name}/diff")
def get_diff(name: str):
    current_path = _dump_path(name)
    current = _load(name)
    session_id = current.get("session_id")
    session_dumps: list[tuple[tuple[float, str], Path]] = []
    for path in _root().glob("request_dump_*.json"):
        if path.is_symlink() or not path.is_file() or not _FILE_RE.fullmatch(path.name):
            continue
        try:
            candidate = _load(path.name)
            if candidate.get("session_id") == session_id:
                session_dumps.append((_dump_sort_key(candidate, path), path))
        except HTTPException:
            continue
    session_dumps.sort(key=lambda item: item[0])
    current_index = next(
        (index for index, (_, path) in enumerate(session_dumps) if path == current_path),
        None,
    )
    previous_path = session_dumps[current_index - 1][1] if current_index is not None and current_index > 0 else None
    current_body = (current.get("request") or {}).get("body") or {}
    current_messages = _normalized_messages(current_body)
    previous_messages: list[Any] = []
    if previous_path:
        previous = _load(previous_path.name)
        previous_body = (previous.get("request") or {}).get("body") or {}
        previous_messages = _normalized_messages(previous_body)
    common = 0
    for before, after in zip(previous_messages, current_messages, strict=False):
        if before != after:
            break
        common += 1
    return {
        "previous_file": previous_path.name if previous_path else None,
        "previous_sequence": current_index if current_index is not None and current_index > 0 else None,
        "common_messages": common,
        "removed_messages": _redact(previous_messages[common:]),
        "added_messages": _redact(current_messages[common:]),
        "previous_count": len(previous_messages),
        "current_count": len(current_messages),
    }
