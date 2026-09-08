# Hermes Request Dump Viewer

A Hermes Agent plugin for inspecting captured LLM request dumps in the Hermes web dashboard.

It adds:

- A **Request Dumps** dashboard tab
- Redacted request inspection for Chat Completions and Responses-style requests
- Prompt composition, tool-flow, timeline, diff, and session-outcome views
- Explicitly confirmed raw JSON downloads
- A live opt-in preflight-capture toggle
- Safe dump deletion with filename, path, symlink, and size checks

## Requirements

- Hermes Agent with the general plugin system and web-dashboard plugin system
- A current Hermes release providing the `pre_api_request` hook and
  `HERMES_DUMP_REQUESTS` request-capture path
- A Hermes dashboard (`hermes dashboard`)
- Python 3.11+

Older Hermes releases may not provide the hook or dashboard APIs used here.

## Installation

Install the published plugin directly from GitHub:

```bash
hermes plugins install alinsavix/hermes-request-dump-viewer --enable
```

For a reproducible installation, pin an exact 40-character commit SHA:

```bash
hermes plugins install alinsavix/hermes-request-dump-viewer \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --enable
```

Restart the Hermes gateway and dashboard after installation. If the dashboard
is already running, force a plugin rescan:

```bash
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

The plugin is opt-in. Verify that it is enabled:

```bash
hermes plugins
```

## Usage

Open the **Request Dumps** tab in the Hermes web dashboard. Capture is disabled
at gateway startup. Turn on **Preflight capture** only when investigating a
request; it writes request dumps for subsequent requests until turned off or
the gateway process ends.

The viewer reads dumps from Hermes' sessions directory. Redacted views are the
default. **Raw downloads contain the original request object and may include
private prompts, authorization headers, cookies, tokens, URLs, tool arguments,
or other sensitive data.** Only use raw download and deletion controls when
you understand the local dashboard's access boundary.

## Screenshots

Screenshots will be added once representative request dumps are available in
the public release environment. They should show the redacted default view,
the tool-flow and schema tabs, and the prompt-composition view without
exposing private prompts, credentials, tokens, or tool arguments.

## Security notes

- The plugin runs Python in-process with Hermes and is not sandboxed.
- Request dumps are local files, but dashboard access should still be treated as privileged.
- Redaction is best-effort and cannot recognize every secret embedded in arbitrary prompt text or tool payloads.
- Raw JSON download requires an explicit confirmation in the UI.
- Dump deletion is restricted to files matching `request_dump_*.json` in Hermes' sessions directory.
- Do not enable preflight capture in a shared or sensitive deployment unless the resulting data is acceptable to retain locally.

## Compatibility and versioning

The plugin follows semantic versioning. The plugin manifest and dashboard
manifest use the same release version. When Hermes changes the dashboard SDK,
API route contract, request-dump format, or `pre_api_request` hook, update the
compatibility notes and tests before releasing.

## License

Copyright (C) 2026 TDV Alinsa.

This project is licensed under the GNU Affero General Public License, version 3
or any later version (AGPL-3.0-or-later). See [LICENSE](./LICENSE).
