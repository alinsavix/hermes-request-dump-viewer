(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const REGISTRY = window.__HERMES_PLUGINS__;
  if (!SDK || !REGISTRY) return;

  const React = SDK.React;
  const h = React.createElement;
  const useState = React.useState;
  const useEffect = React.useEffect;
  const useMemo = React.useMemo;

  function api(path, options) {
    return SDK.fetchJSON("/api/plugins/request-dump-viewer" + path, options);
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + " " + units[i];
  }

  function when(value) {
    if (!value) return "unknown time";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  function text(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }

  function parsed(value) {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch (_) {
      // Some tool adapters wrap JSON in an untrusted-result envelope.
      const start = value.indexOf("{");
      const end = value.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(value.slice(start, end + 1)); } catch (_) {}
      }
      return value;
    }
  }

  function expandedText(value) {
    if (typeof value !== "string") return value;
    // Some nested payloads are JSON-encoded more than once. Parse the outer
    // container first, then turn literal escaped newlines in leaf text into
    // the lines a human expects to read.
    return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }

  function isScalar(value) {
    return value == null || typeof value !== "object";
  }

  function labelFor(key) {
    return String(key).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function copyText(value) {
    const output = typeof value === "string" ? value : text(value);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(output);
    const area = document.createElement("textarea");
    area.value = output; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    return Promise.resolve();
  }

  function downloadJSON(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = name; link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }

  function estimatedSchemaCharacters(tool) {
    try { return JSON.stringify(tool).length; } catch (_) { return text(tool).length; }
  }

  function urlState() {
    const params = new URLSearchParams(window.location.search);
    return { dump: params.get("dump"), tab: params.get("tab") || "overview", message: params.get("message") };
  }

  function updateURL(values) {
    const params = new URLSearchParams(window.location.search);
    Object.keys(values).forEach(function (key) {
      if (values[key] == null || values[key] === "") params.delete(key); else params.set(key, values[key]);
    });
    window.history.replaceState(null, "", window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash);
  }

  function JsonBlock(props) {
    return h("pre", { className: "rdv-json", style: props.unlimited ? null : { maxHeight: "28rem" } }, text(props.value));
  }

  function Scalar(props) {
    const raw = props.value;
    const state = useState(false), open = state[0], setOpen = state[1];
    if (raw == null) return h("span", { className: "rdv-null" }, "null");
    if (typeof raw === "boolean") return h("span", { className: "rdv-bool" }, raw ? "true" : "false");
    if (typeof raw === "number") return h("span", { className: "rdv-number" }, String(raw));
    const value = expandedText(String(raw));
    const long = value.length > 2400;
    const shown = long && !open ? value.slice(0, 2400) + "\n\n… " + (value.length - 2400).toLocaleString() + " more characters" : value;
    return h("div", { className: "rdv-scalar" },
      h("pre", { className: "rdv-scalar-text" }, shown || "(empty)"),
      long && h("button", { className: "rdv-link", onClick: function () { setOpen(!open); } }, open ? "Collapse" : "Show all " + value.length.toLocaleString() + " characters")
    );
  }

  function DataTree(props) {
    let value = props.value;
    if (typeof value === "string") value = parsed(value);
    if (isScalar(value)) return h(Scalar, { value: value });

    if (Array.isArray(value)) {
      if (!value.length) return h("span", { className: "rdv-empty-value" }, "Empty list");
      return h("div", { className: "rdv-array" }, value.map(function (item, i) {
        const title = item && typeof item === "object" ? (item.name || item.type || item.role || "Item " + (i + 1)) : "Item " + (i + 1);
        return h("details", { className: "rdv-node", open: value.length <= 3, key: i },
          h("summary", null, h("span", null, title), h("small", null, "#" + (i + 1))),
          h("div", { className: "rdv-node-body" }, h(DataTree, { value: item }))
        );
      }));
    }

    const entries = Object.entries(value);
    if (!entries.length) return h("span", { className: "rdv-empty-value" }, "Empty object");
    return h("dl", { className: "rdv-fields" }, entries.map(function (entry) {
      const key = entry[0], child = entry[1];
      const simple = isScalar(child) && !(typeof child === "string" && child.length > 160);
      return h("div", { className: "rdv-field " + (simple ? "is-simple" : "is-complex"), key: key },
        h("dt", null, labelFor(key)),
        h("dd", null, h(DataTree, { value: child }))
      );
    }));
  }

  function Content(props) {
    const pair = useState(false), expanded = pair[0], setExpanded = pair[1];
    const raw = props.value;
    const structured = typeof raw === "object" || (typeof raw === "string" && /^[\s]*[\[{]/.test(raw));
    if (structured) return h(DataTree, { value: raw });
    const value = expandedText(text(raw));
    const long = value.length > 2200;
    const shown = long && !expanded ? value.slice(0, 2200) + "\n\n… " + (value.length - 2200).toLocaleString() + " more characters" : value;
    return h(React.Fragment, null,
      h("pre", { className: "rdv-content" }, shown || "(empty)"),
      long && h("button", { className: "rdv-link", onClick: function () { setExpanded(!expanded); } }, expanded ? "Collapse" : "Show all " + value.length.toLocaleString() + " characters")
    );
  }

  function toolArgumentPreview(value) {
    const parsedValue = parsed(value);
    if (parsedValue == null || parsedValue === "") return "";
    let important = parsedValue;
    if (parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)) {
      // Prefer the argument that identifies the operation, rather than dumping
      // the entire argument object into a compact header.
      const preferred = ["path", "file_path", "query", "name", "url", "command", "goal", "message", "text", "content"];
      const key = preferred.find(function (candidate) {
        return parsedValue[candidate] != null && parsedValue[candidate] !== "";
      });
      if (key) important = parsedValue[key];
      else {
        const first = Object.values(parsedValue).find(function (candidate) {
          return candidate != null && typeof candidate !== "object" && candidate !== "";
        });
        if (first !== undefined) important = first;
      }
    }
    let compact;
    if (typeof important === "string") {
      compact = important;
    } else {
      try { compact = JSON.stringify(important); } catch (_) { compact = String(important); }
    }
    compact = String(compact).replace(/\s+/g, " ").trim();
    return compact.length > 120 ? compact.slice(0, 117).trimEnd() + "…" : compact;
  }

  function toolHeader(call) {
    const fn = (call && call.function) || call || {};
    const name = fn.name || (call && call.name) || "tool call";
    if (name === "execute_code" || name === "terminal") return name;
    const args = toolArgumentPreview(fn.arguments == null ? call && call.arguments : fn.arguments);
    return args ? name + "(" + args + ")" : name;
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "";
    if (value < 1) return Math.round(value * 1000) + " ms";
    return value.toFixed(value < 10 ? 2 : 1) + " s";
  }

  function toolResultSummary(message) {
    const name = message && message.name;
    const value = parsed(message && message.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    if (name === "execute_code" || name === "terminal") {
      const pieces = [];
      const success = name === "terminal" ? value.exit_code === 0 : value.status === "success";
      const failure = name === "terminal" ? value.exit_code != null && value.exit_code !== 0 : value.status === "failure";
      if (success) pieces.push("success");
      else if (failure) pieces.push("failure");
      else if (value.status) pieces.push(String(value.status));
      const bytes = value.stdout_bytes_captured != null ? value.stdout_bytes_captured : value.stdout_bytes_total;
      if (bytes != null) {
        pieces.push(Number(bytes).toLocaleString() + " bytes");
      } else if (value.output != null) {
        pieces.push(new TextEncoder().encode(String(value.output)).length.toLocaleString() + " bytes");
      }
      const duration = formatDuration(value.duration_seconds);
      if (duration) pieces.push(duration);
      return pieces.join(" · ");
    }
    if (name === "web_search") {
      const results = value.data && Array.isArray(value.data.web) ? value.data.web.length : null;
      if (value.success === true && results != null) return "success · " + results + " result" + (results === 1 ? "" : "s");
      if (value.success === false) return "failure";
      if (results != null) return results + " result" + (results === 1 ? "" : "s");
    }
    if (name === "write_file") {
      const file = value.resolved_path || (Array.isArray(value.files_modified) && value.files_modified[0]);
      const bytes = value.bytes_written;
      if (file && bytes != null) return file + " · " + Number(bytes).toLocaleString() + " bytes";
      if (file) return String(file);
      if (bytes != null) return Number(bytes).toLocaleString() + " bytes";
    }
    if (name === "skills_list") {
      const outcome = value.success === true ? "success" : value.success === false ? "failure" : "";
      const count = Array.isArray(value.skills) ? value.skills.length : null;
      if (outcome && count != null) return outcome + " · " + count + " skill" + (count === 1 ? "" : "s");
      if (outcome) return outcome;
    }
    return value.status ? String(value.status) : "";
  }

  function ToolCall(props) {
    const call = props.call || {};
    const fn = call.function || {};
    return h("details", { className: "rdv-tool" },
      h("summary", null, "⚙ " + toolHeader(call)),
      h("div", { className: "rdv-item-actions" },
        h("button", { onClick: function () { copyText(parsed(fn.arguments == null ? call.arguments : fn.arguments)); } }, "Copy arguments"),
        h("button", { onClick: function () { copyText(props.path || "$"); } }, "Copy JSONPath")
      ),
      h("div", { className: "rdv-tool-data" }, h(DataTree, { value: parsed(fn.arguments == null ? call.arguments : fn.arguments) }))
    );
  }

  function messageSummary(message, calls) {
    if (message.role === "reasoning" && message.content && typeof message.content === "object" && message.content.encrypted_content) {
      return "Encrypted reasoning · " + bytes(String(message.content.encrypted_content).length);
    }
    let value = message.role === "tool" ? toolResultSummary(message) : text(message.content).replace(/\s+/g, " ").trim();
    if (!value && calls.length) value = calls.map(function (call) {
      const fn = (call && call.function) || call || {};
      return toolHeader(call);
    }).join(", ");
    if (!value) value = "(empty)";
    return value.length > 220 ? value.slice(0, 220).trimEnd() + "…" : value;
  }

  function Message(props) {
    const message = props.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const path = "$.request.body.messages[" + props.index + "]";
    const encrypted = message.role === "reasoning" && message.content && typeof message.content === "object" && message.content.encrypted_content;
    return h("details", { id: "message-" + (props.index + 1), className: "rdv-message " + (props.added ? "is-added" : "") + (props.removed ? " is-removed" : "") },
      h("summary", { className: "rdv-message-summary" },
        h("span", { className: "rdv-role" }, message.role === "tool" ? "tool result" : (message.role || "unknown")),
        h("span", { className: "rdv-index" }, "#" + (props.index + 1)),
        message.name && h("strong", { className: "rdv-tool-name" }, message.name),
        message.status && h("span", { className: "rdv-status" }, message.status),
        message.phase && h("span", { className: "rdv-status" }, message.phase),
        message._responses_kind === "instructions" && h("span", { className: "rdv-change" }, "Responses instructions"),
        props.added && h("span", { className: "rdv-change" }, "added"),
        props.removed && h("span", { className: "rdv-change" }, "removed"),
        calls.length > 0 && h("span", { className: "rdv-call-count" }, calls.length + " tool call" + (calls.length === 1 ? "" : "s")),
        h("span", { className: "rdv-message-preview" }, messageSummary(message, calls))
      ),
      h("div", { className: "rdv-message-body" },
        h("div", { className: "rdv-item-actions" },
          h("button", { onClick: function () { copyText(message); } }, "Copy message"),
          h("button", { onClick: function () { copyText(path); } }, "Copy JSONPath"),
          h("button", { onClick: function () { updateURL({ tab: "messages", message: props.index + 1 }); copyText(window.location.href); } }, "Copy link")
        ),
        encrypted ? h("div", { className: "rdv-encrypted" },
          h("strong", null, "encrypted reasoning"),
          h("span", null, bytes(String(message.content.encrypted_content).length) + " opaque provider payload"),
          message.content.summary && h(DataTree, { value: message.content.summary })
        ) : h(Content, { value: message.content }),
        calls.map(function (call, i) { return h(ToolCall, { call: call, path: path + ".tool_calls[" + i + "]", key: call.id || i }); }),
        message.tool_call_id && h("div", { className: "rdv-tool-id" }, "tool_call_id: " + message.tool_call_id)
      )
    );
  }

  function Meta(props) {
    const d = props.detail, meta = d.meta || {}, req = d.request || {};
    const rows = [
      ["Timestamp", when(meta.timestamp || meta.modified)], ["Session", meta.session_id || "—"],
      ["Model", meta.model || (req.body_options || {}).model || "—"], ["Reason", meta.reason || "—"],
      ["Request", (req.method || "POST") + " " + (req.url || "—")], ["Messages", String(meta.message_count == null ? d.messages.length : meta.message_count)],
      ["Tool schemas", String(meta.tool_schema_count == null ? d.tools.length : meta.tool_schema_count)],
      ["Input format", meta.input_format || "—"],
      meta.input_format === "responses" && ["Instructions", (meta.instruction_length || 0).toLocaleString() + " characters"],
      meta.input_format === "responses" && ["Input items", String(meta.input_item_count || 0)],
      ["File", meta.file + " · " + bytes(meta.size)]
    ];
    return h("div", { className: "rdv-stack" },
      h("div", { className: "rdv-meta" }, rows.filter(Boolean).map(function (row) { return h(React.Fragment, { key: row[0] }, h("dt", null, row[0]), h("dd", null, row[1])); })),
      h("details", null, h("summary", null, "Headers (secrets masked)"), h("div", { className: "rdv-data-panel" }, h(DataTree, { value: req.headers || {} }))),
      h("details", { open: true }, h("summary", null, "Request options"), h("div", { className: "rdv-data-panel" }, h(DataTree, { value: req.body_options || {} }))),
      d.error != null && h("details", { open: true }, h("summary", null, "Error"), h("div", { className: "rdv-data-panel" }, h(DataTree, { value: d.error }))),
      d.response != null && h("details", null, h("summary", null, "Response"), h("div", { className: "rdv-data-panel" }, h(DataTree, { value: d.response })))
    );
  }

  function OutcomeMessage(props) {
    const value = props.value;
    if (!value || !value.found) return null;
    const preview = text(value.content).replace(/\s+/g, " ").trim();
    return h("details", { className: "rdv-message rdv-outcome-message" },
      h("summary", { className: "rdv-message-summary" },
        h("span", { className: "rdv-role" }, "assistant"),
        h("span", { className: "rdv-change" }, "session outcome"),
        h("span", { className: "rdv-message-preview" }, preview.length > 220 ? preview.slice(0, 220) + "…" : preview)
      ),
      h("div", { className: "rdv-message-body" },
        h("div", { className: "rdv-outcome-note" },
          h("strong", null, "Stored session outcome"),
          h("span", null, "Not part of the provider request · " + (value.source || "session") + (value.ended ? " · completed" : " · active"))
        ),
        h("div", { className: "rdv-item-actions" }, h("button", { onClick: function () { copyText(value.content); } }, "Copy response")),
        h(Content, { value: value.content })
      )
    );
  }

  function Composition(props) {
    const data = ((props.analysis || {}).composition) || {};
    const parts = data.parts || [];
    const total = data.total_characters || 0;
    if (!parts.length) return h("div", { className: "rdv-empty" }, "No composition analysis available for this dump.");
    return h("div", { className: "rdv-analysis rdv-stack" },
      h("section", { className: "rdv-analysis-hero" },
        h("div", null, h("small", null, "Estimated request size"), h("strong", null, total.toLocaleString()), h("span", null, " characters")),
        h("div", null, h("small", null, "Estimated tokens"), h("strong", null, (data.estimated_tokens || 0).toLocaleString()), h("span", null, " tokens"))
      ),
      h("div", { className: "rdv-composition-bar", "aria-label": "Request composition" }, parts.map(function (part) {
        const pct = total ? (part.characters / total) * 100 : 0;
        return h("div", {
          key: part.key,
          className: "rdv-composition-segment is-" + part.key,
          style: { width: pct + "%" },
          title: part.label + ": " + part.characters.toLocaleString() + " characters (" + pct.toFixed(1) + "%)"
        });
      })),
      h("div", { className: "rdv-composition-grid" }, parts.map(function (part) {
        const pct = total ? (part.characters / total) * 100 : 0;
        return h("article", { className: "rdv-composition-card", key: part.key },
          h("div", { className: "rdv-composition-card-head" },
            h("i", { className: "rdv-composition-dot is-" + part.key }),
            h("strong", null, part.label),
            h("span", null, pct.toFixed(1) + "%")
          ),
          h("b", null, part.characters.toLocaleString()),
          h("small", null, " characters · ≈" + (part.estimated_tokens || 0).toLocaleString() + " tokens"),
          part.message_indices && part.message_indices.length > 0 && h("code", null, "Messages " + part.message_indices.map(function (i) { return "#" + (i + 1); }).join(", "))
        );
      })),
      h("p", { className: "rdv-analysis-note" }, data.estimation || "Token counts are estimates.")
    );
  }

  function Overview(props) {
    const detail = props.detail;
    const analysis = detail.analysis || {};
    const composition = analysis.composition || {};
    const parts = (composition.parts || []).slice().sort(function (a, b) { return b.characters - a.characters; });
    const sections = (analysis.prompt_sections || []).slice().sort(function (a, b) { return b.characters - a.characters; });
    const schemas = detail.tools.map(function (tool) {
      const fn = tool.function || tool;
      return { name: fn.name || "Unnamed tool", characters: estimatedSchemaCharacters(tool) };
    }).sort(function (a, b) { return b.characters - a.characters; });
    const warnings = [];
    const missing = (analysis.tool_interactions || []).filter(function (flow) { return flow.status !== "matched"; });
    if (missing.length) warnings.push(missing.length + " tool call" + (missing.length === 1 ? "" : "s") + " without exactly one result");
    if ((analysis.orphan_tool_results || []).length) warnings.push(analysis.orphan_tool_results.length + " orphaned tool result" + (analysis.orphan_tool_results.length === 1 ? "" : "s"));
    return h("div", { className: "rdv-overview rdv-stack" },
      h(Composition, { analysis: analysis }),
      warnings.length > 0 && h("section", { className: "rdv-overview-warnings" }, h("h3", null, "Warnings"), warnings.map(function (warning) { return h("p", { key: warning }, warning); })),
      h("section", { className: "rdv-overview-rankings" },
        h("article", null, h("h3", null, "Largest sources"), parts.slice(0, 5).map(function (part) { return h("button", { key: part.key, onClick: function () { props.onTab(part.key === "tools" ? "tools" : part.key === "instructions" ? "prompt" : "messages"); } }, h("strong", null, part.label), h("span", null, "≈" + (part.estimated_tokens || 0).toLocaleString() + " tok")); })),
        h("article", null, h("h3", null, "Largest injected sections"), sections.slice(0, 5).map(function (section) { return h("button", { key: section.id, onClick: function () { props.onTab("prompt"); } }, h("strong", null, section.title), h("span", null, "≈" + (section.estimated_tokens || 0).toLocaleString() + " tok")); })),
        h("article", null, h("h3", null, "Largest tool schemas"), schemas.slice(0, 5).map(function (schema) { return h("button", { key: schema.name, onClick: function () { props.onTab("tools"); } }, h("strong", null, schema.name), h("span", null, "≈" + Math.ceil(schema.characters / 4).toLocaleString() + " tok")); }))
      )
    );
  }

  function PromptMap(props) {
    const sections = ((props.analysis || {}).prompt_sections) || [];
    if (!sections.length) return h("div", { className: "rdv-empty" }, "No system or instructions sections found.");
    const totals = sections.reduce(function (out, section) {
      out.characters += section.characters || 0;
      out.tokens += section.estimated_tokens || 0;
      return out;
    }, { characters: 0, tokens: 0 });
    return h("div", { className: "rdv-analysis rdv-stack" },
      h("div", { className: "rdv-prompt-summary" },
        h("strong", null, sections.length + " injected section" + (sections.length === 1 ? "" : "s")),
        h("span", null, totals.characters.toLocaleString() + " characters · ≈" + totals.tokens.toLocaleString() + " tokens")
      ),
      h("div", { className: "rdv-prompt-map" }, sections.map(function (section, i) {
        return h("details", { className: "rdv-prompt-section", key: section.id || i, open: i === 0 },
          h("summary", null,
            h("span", { className: "rdv-prompt-order" }, String(i + 1).padStart(2, "0")),
            h("span", { className: "rdv-prompt-heading" }, h("strong", null, section.title), h("small", null, section.category)),
            h("span", { className: "rdv-prompt-size" }, (section.characters || 0).toLocaleString() + " chars", h("small", null, "≈" + (section.estimated_tokens || 0).toLocaleString() + " tok")),
            h("code", null, "msg #" + ((section.message_index || 0) + 1))
          ),
          h("div", { className: "rdv-item-actions" },
            h("button", { onClick: function () { copyText(section.content); } }, "Copy section"),
            h("button", { onClick: function () { copyText("$.analysis.prompt_sections[" + i + "]"); } }, "Copy JSONPath")
          ),
          h("div", { className: "rdv-prompt-content" }, h(Content, { value: section.content }))
        );
      }))
    );
  }

  function ToolFlow(props) {
    const analysis = props.analysis || {};
    const flows = analysis.tool_interactions || [];
    const orphans = analysis.orphan_tool_results || [];
    if (!flows.length && !orphans.length) return h("div", { className: "rdv-empty" }, "No tool calls or tool results in this request.");
    return h("div", { className: "rdv-analysis rdv-flow-list" },
      flows.map(function (flow, i) {
        return h("article", { className: "rdv-flow-card is-" + flow.status, key: flow.call_id || i },
          h("header", null,
            h("span", { className: "rdv-flow-number" }, String(i + 1).padStart(2, "0")),
            h("div", null, h("strong", null, flow.name), h("code", null, flow.call_id)),
            h("span", { className: "rdv-flow-status" }, flow.status === "matched" ? "Matched" : flow.status === "multiple_results" ? "Multiple results" : "Missing result")
          ),
          h("div", { className: "rdv-flow-stage is-call" },
            h("div", { className: "rdv-flow-stage-head" }, h("strong", null, "Call"), h("span", null, "assistant message #" + (flow.call_message_index + 1))),
            h("div", { className: "rdv-flow-data" }, h(DataTree, { value: flow.arguments }))
          ),
          h("div", { className: "rdv-flow-connector" }, h("span", null, "↓"), h("small", null, "tool_call_id")),
          flow.results && flow.results.length ? flow.results.map(function (result, resultIndex) {
            return h("div", { className: "rdv-flow-stage is-result", key: result.message_index + "-" + resultIndex },
              h("div", { className: "rdv-flow-stage-head" }, h("strong", null, "Result"), h("span", null, (result.name || flow.name) + " · tool message #" + (result.message_index + 1))),
              h("div", { className: "rdv-item-actions" }, h("button", { onClick: function () { copyText(parsed(result.content)); } }, "Copy result")),
              h("div", { className: "rdv-flow-data" }, h(DataTree, { value: parsed(result.content) }))
            );
          }) : h("div", { className: "rdv-flow-missing" }, "No tool result with this call ID appears in the request."),
          flow.results && flow.results.length > 1 && h("div", { className: "rdv-flow-warning" }, flow.results.length + " result messages share this call ID.")
        );
      }),
      orphans.length > 0 && h("section", { className: "rdv-orphans" },
        h("h3", null, "Orphaned tool results (" + orphans.length + ")"),
        h("p", null, "These result messages have no matching tool call in this request."),
        orphans.map(function (result, i) {
          return h("details", { className: "rdv-flow-card is-orphan", key: (result.call_id || "none") + i },
            h("summary", null, h("strong", null, result.name || "Unknown tool"), h("code", null, result.call_id || "no call ID"), h("span", null, "message #" + (result.message_index + 1))),
            h("div", { className: "rdv-flow-data" }, h(DataTree, { value: parsed(result.content) }))
          );
        })
      )
    );
  }

  function Timeline(props) {
    const state = useState(null), timeline = state[0], setTimeline = state[1];
    const errorState = useState(null), error = errorState[0], setError = errorState[1];
    useEffect(function () {
      if (!props.sessionId) return;
      let live = true;
      api("/sessions/" + encodeURIComponent(props.sessionId) + "/timeline").then(function (value) { if (live) setTimeline(value); }).catch(function (err) { if (live) setError(err); });
      return function () { live = false; };
    }, [props.sessionId, props.refreshKey]);
    if (error) return h("div", { className: "rdv-timeline-error" }, "Timeline unavailable: " + (error.message || error));
    if (!timeline) return h("div", { className: "rdv-timeline-loading" }, "Loading request timeline…");
    const requests = timeline.items || timeline.requests || [];
    const current = requests.find(function (item) { return item.file === props.selected; }) || {};
    return h("section", { className: "rdv-timeline" },
      h("div", { className: "rdv-timeline-head" },
        h("strong", null, requests.length + " request" + (requests.length === 1 ? "" : "s")),
        h("span", null, current.sequence ? "Request " + current.sequence + " of " + requests.length : "")
      ),
      h("div", { className: "rdv-timeline-nav" },
        h("button", { disabled: !current.previous_file, onClick: function () { props.onSelect(current.previous_file); } }, "← Previous"),
        h("div", { className: "rdv-timeline-strip" }, requests.map(function (item) {
          const delta = item.token_delta == null ? "" : (item.token_delta >= 0 ? "+" : "") + item.token_delta.toLocaleString() + " tok";
          return h("button", { key: item.file, title: when(item.timestamp || item.modified) + (delta ? " · " + delta : ""), className: item.file === props.selected ? "active" : "", onClick: function () { props.onSelect(item.file); } }, String(item.sequence || "•"));
        })),
        h("button", { disabled: !current.next_file, onClick: function () { props.onSelect(current.next_file); } }, "Next →")
      ),
      current.file && h("div", { className: "rdv-timeline-current" },
        h("span", null, when(current.timestamp || current.modified)),
        h("span", null, current.model || "unknown model"),
        h("span", null, bytes(current.size)),
        current.size_delta != null && h("span", { className: current.size_delta >= 0 ? "is-growth" : "is-shrink" }, (current.size_delta >= 0 ? "+" : "") + bytes(current.size_delta) + " from previous")
      )
    );
  }

  function Diff(props) {
    const d = props.value;
    if (props.loading) return h("div", { className: "rdv-empty" }, "Loading diff…");
    if (!d) return h("div", { className: "rdv-empty" }, "No diff loaded.");
    if (!d.previous_file) return h("div", { className: "rdv-empty" }, "First dump in this session — nothing earlier to compare.");
    return h("div", { className: "rdv-stack" },
      h("div", { className: "rdv-diff-meta" }, d.common_messages + " unchanged prefix messages", h("code", null, "Compared with " + d.previous_file)),
      d.removed_messages.length > 0 && h("section", null, h("h3", null, "Removed or changed (" + d.removed_messages.length + ")"), d.removed_messages.map(function (m, i) { return h(Message, { key: "r" + i, message: m, index: d.common_messages + i, removed: true }); })),
      d.added_messages.length > 0 && h("section", null, h("h3", null, "Added or changed (" + d.added_messages.length + ")"), d.added_messages.map(function (m, i) { return h(Message, { key: "a" + i, message: m, index: d.common_messages + i, added: true }); })),
      !d.removed_messages.length && !d.added_messages.length && h("div", { className: "rdv-empty" }, "Requests have identical messages.")
    );
  }

  function collapseReasoningFollowups(messages) {
    const visible = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i] || {};
      const next = messages[i + 1] || {};
      const encryptedReasoning = message.role === "reasoning" && message.content && typeof message.content === "object" && message.content.encrypted_content;
      const emptyContent = next.content == null || next.content === "" || (Array.isArray(next.content) && next.content.length === 0);
      const emptyFollowup = next.role === "assistant" && emptyContent && !next.tool_calls && !next.name;
      visible.push({ message: message, index: i });
      if (encryptedReasoning && emptyFollowup) i += 1;
    }
    return visible;
  }

  function Detail(props) {
    const state = useState(null), detail = state[0], setDetail = state[1];
    const errState = useState(null), error = errState[0], setError = errState[1];
    const tabState = useState("overview"), tab = tabState[0], setTab = tabState[1];
    const searchState = useState(""), search = searchState[0], setSearch = searchState[1];
    const matchState = useState(-1), matchCursor = matchState[0], setMatchCursor = matchState[1];
    const outcomeState = useState(null), outcome = outcomeState[0], setOutcome = outcomeState[1];
    const diffState = useState(null), diff = diffState[0], setDiff = diffState[1];
    const diffLoadState = useState(false), diffLoading = diffLoadState[0], setDiffLoading = diffLoadState[1];

    function selectTab(value) { setTab(value); updateURL({ tab: value, message: null }); }
    function setDetails(open) {
      document.querySelectorAll(".rdv-detail-scroll details").forEach(function (node) { node.open = open; });
    }

    useEffect(function () { const value = urlState().tab; setTab(value === "outcome" ? "messages" : value); }, []);
    useEffect(function () {
      let live = true; setDetail(null); setOutcome(null); setError(null); setDiff(null); updateURL({ dump: props.name });
      api("/dumps/" + encodeURIComponent(props.name)).then(function (v) {
        if (!live) return;
        setDetail(v);
        return api("/sessions/" + encodeURIComponent(v.meta.session_id) + "/outcome")
          .then(function (result) { if (live) setOutcome(result); })
          .catch(function (e) { if (live) setOutcome({ found: false, reason: e.message || String(e) }); });
      }).catch(function (e) { if (live) setError(e); });
      return function () { live = false; };
    }, [props.name]);

    useEffect(function () {
      if (tab !== "diff" || diff || diffLoading) return;
      let live = true; setDiffLoading(true);
      api("/dumps/" + encodeURIComponent(props.name) + "/diff").then(function (v) { if (live) setDiff(v); }).catch(function (e) { if (live) setError(e); }).finally(function () { if (live) setDiffLoading(false); });
      return function () { live = false; };
    }, [props.name, tab, diff]);

    useEffect(function () {
      if (!detail || tab !== "messages") return;
      const message = urlState().message;
      if (!message) return;
      const node = document.getElementById("message-" + message);
      if (node) { node.open = true; node.scrollIntoView({ block: "center" }); }
    }, [detail, tab]);

    if (error) return h("div", { className: "rdv-empty rdv-error" }, "Could not load dump: " + (error.message || error));
    if (!detail) return h("div", { className: "rdv-empty" }, "Loading request dump…");
    const analysis = detail.analysis || {};
    const displayMessages = collapseReasoningFollowups(detail.messages);
    const tabs = [
      ["overview", "Overview"],
      ["messages", "Messages (" + displayMessages.length + ")"],
      ["prompt", "Prompt map (" + ((analysis.prompt_sections || []).length) + ")"],
      ["flow", "Tool flow (" + ((analysis.tool_interactions || []).length) + ")"],
      ["tools", "Schemas (" + detail.tools.length + ")"],
      ["meta", "Request"],
      ["diff", "Diff"]
    ];
    const needle = search.trim().toLowerCase();
    const visible = displayMessages.filter(function (x) { return !needle || text(x.message).toLowerCase().indexOf(needle) >= 0; });
    const outcomeMatches = Boolean(outcome && outcome.found && (!needle || text(outcome.content).toLowerCase().indexOf(needle) >= 0));
    const rankedTools = detail.tools.map(function (tool, i) { return { tool: tool, index: i, characters: estimatedSchemaCharacters(tool) }; }).sort(function (a, b) { return b.characters - a.characters; });

    return h("main", { className: "rdv-detail" },
      h(Timeline, { sessionId: detail.meta.session_id, selected: props.name, onSelect: props.onSelect, refreshKey: props.refreshKey }),
      h("div", { className: "rdv-detail-head" },
        h("button", { className: "rdv-sidebar-toggle", onClick: props.onToggleList, title: "Show or hide sessions" }, "☰"),
        h("div", { className: "rdv-title" }, h("strong", null, detail.meta.model || "Request dump"), h("code", null, detail.meta.file)),
        h("div", { className: "rdv-tabs", role: "tablist" }, tabs.map(function (item) { return h("button", { key: item[0], role: "tab", "aria-selected": tab === item[0], className: tab === item[0] ? "active" : "", onClick: function () { selectTab(item[0]); } }, item[1]); }))
      ),
      h("div", { className: "rdv-detail-actions" },
        h("button", { onClick: function () { setDetails(true); } }, "Expand all"),
        h("button", { onClick: function () { setDetails(false); } }, "Collapse all"),
        h("button", { onClick: function () { copyText(detail); } }, "Copy redacted JSON"),
        h("button", { onClick: function () { downloadJSON(detail.meta.file.replace(/\.json$/, "-redacted.json"), detail); } }, "Download redacted"),
        h("button", { title: "Contains the complete unredacted provider request, including sensitive values", onClick: function () {
          if (!window.confirm("Download the complete unredacted request? It may contain credentials, tokens, personal data, and other sensitive values.")) return;
          api("/dumps/" + encodeURIComponent(props.name) + "/raw").then(function (raw) { downloadJSON(detail.meta.file, raw); }).catch(setError);
        } }, "Download raw (sensitive)")
      ),
      tab === "messages" && h("div", { className: "rdv-message-search" },
        h("input", { value: search, onChange: function (e) { setSearch(e.target.value); setMatchCursor(-1); }, onKeyDown: function (e) {
          if (e.key !== "Enter" || !visible.length) return;
          e.preventDefault();
          const next = (matchCursor + (e.shiftKey ? visible.length - 1 : 1)) % visible.length;
          setMatchCursor(next);
          const node = document.getElementById("message-" + (visible[next].index + 1));
          if (node) { node.open = true; node.scrollIntoView({ block: "center", behavior: "smooth" }); }
        }, placeholder: "Search messages… Enter/Shift+Enter moves between matches" }),
        needle && h("span", { className: "rdv-search-count" }, visible.length + " match" + (visible.length === 1 ? "" : "es"))
      ),
      h("div", { className: "rdv-detail-scroll" },
        tab === "overview" ? h(Overview, { detail: detail, onTab: selectTab }) :
        tab === "messages" ? h(React.Fragment, null,
          visible.length ? visible.map(function (x) { return h(Message, { key: x.index, message: x.message, index: x.index }); }) : (!outcomeMatches && h("div", { className: "rdv-empty" }, "No matching messages.")),
          outcomeMatches && h(OutcomeMessage, { value: outcome })
        ) :
        tab === "prompt" ? h(PromptMap, { analysis: analysis }) :
        tab === "flow" ? h(ToolFlow, { analysis: analysis }) :
        tab === "tools" ? (rankedTools.length ? h("div", { className: "rdv-schema-list" }, rankedTools.map(function (entry, rank) {
          const fn = entry.tool.function || entry.tool;
          return h("details", { className: "rdv-schema", key: fn.name || entry.index },
            h("summary", null, h("strong", null, "#" + (rank + 1) + " " + (fn.name || "Tool " + (entry.index + 1))), h("span", null, "≈" + Math.ceil(entry.characters / 4).toLocaleString() + " tok · " + (fn.description || ""))),
            h("div", { className: "rdv-item-actions" }, h("button", { onClick: function () { copyText(fn); } }, "Copy schema"), h("button", { onClick: function () { copyText("$.request.body.tools[" + entry.index + "]"); } }, "Copy JSONPath")),
            h("div", { className: "rdv-schema-body" }, h(DataTree, { value: fn }))
          );
        })) : h("div", { className: "rdv-empty" }, "No tool schemas in this request.")) :
        tab === "meta" ? h(Meta, { detail: detail }) : h(Diff, { value: diff, loading: diffLoading })
      )
    );
  }

  function Page() {
    const initial = urlState();
    const itemsState = useState([]), items = itemsState[0], setItems = itemsState[1];
    const countState = useState(0), dumpCount = countState[0], setDumpCount = countState[1];
    const selectedState = useState(initial.dump), selected = selectedState[0], setSelected = selectedState[1];
    const selectedSessionState = useState(null), selectedSession = selectedSessionState[0], setSelectedSession = selectedSessionState[1];
    const listState = useState(!window.matchMedia("(max-width: 800px)").matches), listOpen = listState[0], setListOpen = listState[1];
    const widthState = useState(340), listWidth = widthState[0], setListWidth = widthState[1];
    const refreshState = useState(0), refreshKey = refreshState[0], setRefreshKey = refreshState[1];
    const searchState = useState(""), search = searchState[0], setSearch = searchState[1];
    const busyState = useState(true), busy = busyState[0], setBusy = busyState[1];
    const errState = useState(null), error = errState[0], setError = errState[1];
    const captureState = useState(null), capture = captureState[0], setCapture = captureState[1];
    const toggleState = useState(false), toggling = toggleState[0], setToggling = toggleState[1];
    const captureErrorState = useState(null), captureError = captureErrorState[0], setCaptureError = captureErrorState[1];
    const confirmDeleteState = useState(false), confirmDelete = confirmDeleteState[0], setConfirmDelete = confirmDeleteState[1];
    const deletingState = useState(false), deleting = deletingState[0], setDeleting = deletingState[1];
    const deleteErrorState = useState(null), deleteError = deleteErrorState[0], setDeleteError = deleteErrorState[1];

    function load() {
      setBusy(true); setError(null);
      api("/dumps").then(function (data) {
        const next = data.items || []; setItems(next); setDumpCount(data.dump_count || next.length);
        setSelected(function (old) { return old || (next[0] || {}).file || null; });
        setSelectedSession(function (old) { return old || ((next.find(function (i) { return i.file === (initial.dump || ""); }) || next[0] || {}).session_id) || null; });
        setRefreshKey(function (value) { return value + 1; });
      }).catch(setError).finally(function () { setBusy(false); });
    }
    function loadCapture() {
      return api("/capture").then(setCapture).catch(setCaptureError);
    }

    function toggleCapture() {
      if (!capture || toggling) return;
      const enabled = !capture.enabled;
      setToggling(true); setCaptureError(null);
      api("/capture", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: enabled }) })
        .then(setCapture)
        .catch(setCaptureError)
        .finally(function () { setToggling(false); });
    }

    useEffect(function () { load(); loadCapture(); }, []);

    function selectDump(file, sessionId) {
      setSelected(file); if (sessionId) setSelectedSession(sessionId); updateURL({ dump: file });
      if (window.matchMedia("(max-width: 800px)").matches) setListOpen(false);
    }

    function beginResize(event) {
      event.preventDefault();
      const startX = event.clientX, startWidth = listWidth;
      function move(e) { setListWidth(Math.max(240, Math.min(620, startWidth + e.clientX - startX))); }
      function up() { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }

    useEffect(function () {
      function keydown(event) {
        if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
        if (event.key === "/") { event.preventDefault(); const input = document.querySelector(".rdv-list-search input"); if (input) input.focus(); }
        if (event.key.toLowerCase() === "b") setListOpen(function (value) { return !value; });
        if (event.altKey && event.key === "ArrowLeft") { const button = document.querySelector(".rdv-timeline-nav>button:first-child:not(:disabled)"); if (button) button.click(); }
        if (event.altKey && event.key === "ArrowRight") { const button = document.querySelector(".rdv-timeline-nav>button:last-child:not(:disabled)"); if (button) button.click(); }
      }
      window.addEventListener("keydown", keydown); return function () { window.removeEventListener("keydown", keydown); };
    }, []);

    function deleteAllDumps() {
      if (!confirmDelete) { setConfirmDelete(true); return; }
      setDeleting(true); setDeleteError(null);
      api("/dumps", { method: "DELETE" })
        .then(function () {
          setConfirmDelete(false);
          load();
        })
        .catch(setDeleteError)
        .finally(function () { setDeleting(false); });
    }

    useEffect(function () {
      if (!confirmDelete) return;
      const timer = setTimeout(function () { setConfirmDelete(false); }, 5000);
      return function () { clearTimeout(timer); };
    }, [confirmDelete]);

    const visible = useMemo(function () {
      const q = search.trim().toLowerCase();
      if (!q) return items;
      return items.filter(function (i) { return [i.session_id, i.model, i.reason, i.preview, i.url].concat(i.tool_names || []).some(function (v) { return String(v || "").toLowerCase().indexOf(q) >= 0; }); });
    }, [items, search]);

    if (error) return h("div", { className: "rdv-empty rdv-error" }, "Could not scan request dumps: " + (error.message || error));
    return h("div", { className: "rdv-page " + (listOpen ? "is-list-open" : "is-list-hidden"), style: { "--rdv-list-width": listWidth + "px" } },
      h("header", { className: "rdv-top" },
        h("div", { className: "rdv-top-title" }, h("button", { className: "rdv-sidebar-toggle", onClick: function () { setListOpen(!listOpen); }, title: "Toggle sessions (B)" }, "☰"), h("div", null, h("h1", null, "Request Dumps"), h("span", null, items.length + " sessions · " + dumpCount + " requests"))),
        h("div", { className: "rdv-top-actions" },
          captureError && h("span", { className: "rdv-capture-error", title: String(captureError.message || captureError) }, "Toggle error"),
          deleteError && h("span", { className: "rdv-capture-error", title: String(deleteError.message || deleteError) }, "Delete failed"),
          h("label", { className: "rdv-capture " + (capture && capture.enabled ? "is-on" : "is-off") },
            h("span", { className: "rdv-capture-label" }, "Capture", h("small", null, capture == null ? "checking…" : capture.enabled ? "live" : "paused")),
            h("button", { type: "button", role: "switch", "aria-checked": Boolean(capture && capture.enabled), disabled: capture == null || toggling, onClick: toggleCapture }, h("span", null))
          ),
          h("button", {
            className: "rdv-delete-all " + (confirmDelete ? "is-confirm" : ""),
            onClick: deleteAllDumps,
            disabled: deleting || dumpCount === 0,
          }, deleting ? "Deleting…" : confirmDelete ? "Really delete all " + dumpCount + "?" : "Delete all dumps"),
          h("button", { onClick: function () { load(); loadCapture(); }, disabled: busy }, busy ? "Scanning…" : "Refresh")
        )
      ),
      !items.length && busy ? h("div", { className: "rdv-empty" }, "Scanning request dumps…") :
      !items.length ? h("div", { className: "rdv-empty" }, "No request dumps found.") :
      h("div", { className: "rdv-workspace" },
        listOpen && h("button", { className: "rdv-mobile-backdrop", onClick: function () { setListOpen(false); }, "aria-label": "Close session list" }),
        h("aside", { className: "rdv-list" },
          h("div", { className: "rdv-list-search" }, h("input", { value: search, onChange: function (e) { setSearch(e.target.value); }, placeholder: "Filter dumps…" })),
          h("div", { className: "rdv-list-scroll" }, visible.map(function (item) { return h("button", { key: item.file, className: "rdv-list-item " + (selectedSession === item.session_id || selected === item.file ? "active" : ""), onClick: function () { selectDump(item.file, item.session_id); } },
            h("div", { className: "rdv-list-line" }, h("strong", null, item.model || "unknown model"), h("span", null, bytes(item.size))),
            h("p", null, item.preview || item.reason || item.file),
            h("small", null, when(item.timestamp || item.modified) + " · " + (item.message_count || 0) + " msg · " + (item.request_count || 1) + " req"),
            item.parse_error && h("em", null, item.parse_error)
          ); }))
        ),
        h("div", { className: "rdv-resize-handle", onPointerDown: beginResize, title: "Drag to resize sessions" }),
        selected ? h(Detail, { name: selected, key: selected, onSelect: function (file) { selectDump(file, selectedSession); }, onToggleList: function () { setListOpen(!listOpen); }, refreshKey: refreshKey }) : h("div", { className: "rdv-empty" }, "Select a dump.")
      )
    );
  }

  REGISTRY.register("request-dump-viewer", Page);
})();
