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
- Hermes providing the `pre_api_request` hook and `HERMES_DUMP_REQUESTS` request-capture path
- A Hermes dashboard (`hermes dashboard`)
- Python 3.11+ for the plugin runtime

Use a current Hermes release. Older releases may not provide the hook or dashboard APIs used here.

## Installation

From a checked-out copy, copy or symlink this repository into the user's Hermes plugin directory:

```bash
mkdir -p ~/.hermes/plugins
cp -R hermes-request-dump-viewer ~/.hermes/plugins/request-dump-viewer
```

For a published repository, Hermes supports installing directly from GitHub:

```bash
hermes plugins install OWNER/REPOSITORY --enable
```

After installation, start or restart the Hermes gateway and dashboard. If the dashboard is already running, force a plugin rescan:

```bash
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

The plugin is opt-in. Verify that it is enabled:

```bash
hermes plugins
```

## Usage

Open the **Request Dumps** tab in the Hermes web dashboard. Capture is disabled at gateway startup. Turn on **Preflight capture** only when investigating a request; it writes request dumps for subsequent requests until turned off or the gateway process ends.

The viewer reads dumps from Hermes' sessions directory. Redacted views are the default. **Raw downloads contain the original request object and may include private prompts, authorization headers, cookies, tokens, URLs, tool arguments, or other sensitive data.** Only use raw download and deletion controls when you understand the local dashboard's access boundary.

## Security notes

- The plugin runs Python in-process with Hermes and is not sandboxed.
- Request dumps are local files, but dashboard access should still be treated as privileged.
- Redaction is best-effort and cannot recognize every secret embedded in arbitrary prompt text or tool payloads.
- Raw JSON download requires an explicit confirmation in the UI.
- Dump deletion is restricted to files matching `request_dump_*.json` in Hermes' sessions directory.
- Do not enable preflight capture in a shared or sensitive deployment unless the resulting data is acceptable to retain locally.

## Development

Run the test suite from the repository root:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
```

The dashboard bundle is committed intentionally. The plugin does not require a Node.js build during installation or runtime.

## Compatibility and versioning

The plugin follows semantic versioning. The plugin manifest and dashboard manifest use the same release version. When Hermes changes the dashboard SDK, API route contract, request-dump format, or `pre_api_request` hook, update the compatibility notes and tests before releasing.

## License

Copyright (C) 2026 Alinsa / GIR.

This project is licensed under the GNU Affero General Public License, version 3 or any later version (AGPL-3.0-or-later). See [LICENSE](./LICENSE).
