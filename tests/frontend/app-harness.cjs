const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const React = require("react");
// React DOM detects browser input event support at import time.
const boot = new JSDOM("<html></html>");
global.window = boot.window;
global.document = boot.window.document;
const { createRoot } = require("react-dom/client");
boot.window.close();

const message = (content) => ({ role: "user", content });
const meta = {
  file: "request_dump_after.json",
  session_id: "fixture",
  model: "synthetic",
  sequence: 2,
};
const payload = (timeline = []) => ({
  schema_version: 2,
  previous_file: "request_dump_before.json",
  previous_sequence: 1,
  summary: { unchanged: 0, modified: 0, moved: 0, added: 0, removed: 0 },
  timeline,
});
const row = (id, value) => ({
  kind: "message",
  id,
  before_index: null,
  after_index: 0,
  status: ["added"],
  before: null,
  after: value,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
async function mount(t, options = {}) {
  const dom = new JSDOM('<div id="root"></div>', {
    url:
      "http://example.test/request-dumps?dump=" +
      (options.name || meta.file) +
      "&tab=" +
      (options.tab || "messages"),
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.TextEncoder = TextEncoder;
  const scrolled = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };
  const errors = [],
    caught = [],
    copied = [],
    requests = [];
  dom.window.addEventListener("error", (e) => {
    errors.push(e.error);
    e.preventDefault();
  });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        copied.push(value);
      },
    },
  });
  const detail = {
    meta,
    messages: [message("hello")],
    tools: [],
    analysis: {},
    request: {
      method: "POST",
      url: "https://example.test/v1/responses",
      body_options: {},
    },
    ...options.detail,
  };
  dom.window.__HERMES_PLUGIN_SDK__ = {
    React,
    fetchJSON: async (url, init) => {
      requests.push(url);
      assert.ok(
        !init || !init.method || init.method === "GET",
        "synthetic harness forbids mutations",
      );
      if (options.fetch) {
        const value = options.fetch(url, init);
        if (value !== undefined) return value;
      }
      if (url.endsWith("/diff")) return options.diff || payload();
      if (url.endsWith("/capture")) return { enabled: false };
      if (url.endsWith("/timeline")) return { items: [meta] };
      if (url.endsWith("/outcome")) return { found: false };
      if (url.endsWith("/dumps"))
        return { items: options.items || [meta], dump_count: 2 };
      if (url.endsWith(".json")) return detail;
      throw new Error("Unexpected endpoint: " + url);
    },
  };
  let App;
  dom.window.__HERMES_PLUGINS__ = {
    register: (_, component) => {
      App = component;
    },
  };
  dom.window.eval(
    fs.readFileSync(
      path.join(__dirname, "../../dashboard/dist/index.js"),
      "utf8",
    ),
  );
  const root = createRoot(dom.window.document.getElementById("root"), {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => caught.push(error),
  });
  t.after(async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
  });
  await React.act(async () => root.render(React.createElement(App)));
  const document = dom.window.document;
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find(
      (el) => el.textContent === label,
    );
  const click = async (target) => {
    const el = typeof target === "string" ? button(target) : target;
    assert.ok(el, "control exists: " + target);
    await React.act(async () => {
      el.click();
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
  };
  const tab = (prefix) =>
    click(
      [...document.querySelectorAll('[role="tab"]')].find((el) =>
        el.textContent.startsWith(prefix),
      ),
    );
  const settle = async (fn) =>
    React.act(async () => {
      fn();
    });
  const count = (suffix) =>
    requests.filter((url) => url.endsWith(suffix)).length;
  return {
    dom,
    document,
    errors,
    caught,
    copied,
    requests,
    detail,
    scrolled,
    click,
    button,
    tab,
    settle,
    count,
  };
}
module.exports = { mount, message, meta, payload, row, deferred, React };
