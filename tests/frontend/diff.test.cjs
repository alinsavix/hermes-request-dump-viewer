const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const React = require("react");
const { createRoot } = require("react-dom/client");

const message = (content) => ({ role: "user", content });
const row = (id, before_index, after_index, status, before, after) => ({
  kind: "message",
  id,
  before_index,
  after_index,
  status,
  before,
  after,
});
const payload = (timeline, summary = {}) => ({
  schema_version: 2,
  previous_file: "request_dump_before.json",
  previous_sequence: 1,
  summary: {
    unchanged: 0,
    modified: 0,
    moved: 0,
    added: 0,
    removed: 0,
    ...summary,
  },
  timeline,
});

async function mount(t, diff, messages = []) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/request-dumps?dump=request_dump_after.json&tab=diff",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const errors = [];
  dom.window.addEventListener("error", (event) => errors.push(event.error));
  const meta = {
    file: "request_dump_after.json",
    session_id: "fixture",
    model: "test",
    sequence: 2,
  };
  const requests = [];
  dom.window.__HERMES_PLUGIN_SDK__ = {
    React,
    fetchJSON: async (url) => {
      requests.push(url);
      if (url.endsWith("/diff")) return diff;
      if (url.endsWith("/capture")) return { enabled: false };
      if (url.endsWith("/timeline")) return { items: [meta] };
      if (url.endsWith("/outcome")) return { found: false };
      if (url.endsWith("/dumps")) return { items: [meta], dump_count: 2 };
      if (url.endsWith(".json"))
        return { meta, messages, tools: [], analysis: {}, request: {} };
      throw new Error("Unexpected endpoint: " + url);
    },
  };
  let Page;
  dom.window.__HERMES_PLUGINS__ = {
    register: (_name, component) => {
      Page = component;
    },
  };
  // Execute the shipped bundle unchanged; mount the same registered root as the dashboard.
  dom.window.eval(
    fs.readFileSync(
      path.join(__dirname, "../../dashboard/dist/index.js"),
      "utf8",
    ),
  );
  const root = createRoot(dom.window.document.getElementById("root"), {
    onUncaughtError: (error) => errors.push(error),
  });
  t.after(async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
  });
  await React.act(async () => root.render(React.createElement(Page)));
  assert.ok(
    requests.some((url) => url.endsWith("/diff")),
    "must exercise the actual diff-fetch path",
  );
  assert.deepEqual(errors, [], "no frontend runtime exceptions");
  return { document: dom.window.document, dom, errors };
}

test("diff renders an aligned timeline with both positions, not separate piles", async (t) => {
  const { document } = await mount(
    t,
    payload(
      [
        row("gone", 0, null, ["removed"], message("old question"), null),
        row(
          "kept",
          1,
          0,
          ["unchanged"],
          message("retained question"),
          message("retained question"),
        ),
        row("new", null, 1, ["added"], null, message("new question")),
      ],
      { unchanged: 1, removed: 1, added: 1 },
    ),
  );
  const timeline = document.querySelector('[aria-label="Message changes"]');
  assert.ok(timeline, "one aligned message timeline must render");
  assert.deepEqual(
    [...timeline.querySelectorAll("[data-diff-id]")].map(
      (el) => el.dataset.diffId,
    ),
    ["gone", "kept", "new"],
  );
  assert.deepEqual(
    [...timeline.querySelectorAll(".rdv-diff-position")].map(
      (el) => el.textContent,
    ),
    ["#1 → —", "#2 → #1", "— → #2"],
  );
  assert.doesNotMatch(document.body.textContent, /#NaN|undefined/);
});

test("unchanged runs collapse and expand without losing individual positions", async (t) => {
  const rows = Array.from({ length: 120 }, (_, i) =>
    row(
      "kept-" + i,
      i + 2,
      i,
      ["unchanged"],
      message("kept " + i),
      message("kept " + i),
    ),
  );
  const { document, dom } = await mount(t, payload(rows, { unchanged: 120 }));
  const group = document.querySelector(".rdv-diff-unchanged");
  assert.ok(group, "unchanged run must be a single expandable group");
  assert.equal(group.open, false);
  assert.equal(
    document.querySelectorAll("[data-diff-id]").length,
    0,
    "collapsed group must not mount 120 content trees",
  );
  assert.match(group.textContent, /120 unchanged/);
  await React.act(async () => {
    group.open = true;
    group.dispatchEvent(new dom.window.Event("toggle"));
  });
  assert.equal(group.querySelectorAll("[data-diff-id]").length, 120);
  assert.match(group.textContent, /#3 → #1/);
  assert.equal(
    group.querySelector("summary").textContent,
    "120 unchanged messages · #3–#122 → #1–#120",
  );
});

test("removed runs collapse without swallowing intervening rows or index gaps", async (t) => {
  const { document, dom } = await mount(
    t,
    payload(
      [
        row("r1", 19, null, ["removed"], message("first removed"), null),
        row("r2", 20, null, ["removed"], message("second removed"), null),
        row("added", null, 0, ["added"], null, message("new")),
        row("r3", 21, null, ["removed"], message("third removed"), null),
        row("r4", 23, null, ["removed"], message("fourth removed"), null),
      ],
      { removed: 4, added: 1 },
    ),
  );
  const groups = document.querySelectorAll(".rdv-diff-removed");
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.open, false);
  assert.equal(
    group.querySelector("summary").textContent,
    "2 removed messages · #20–#21",
  );
  assert.equal(document.querySelector('[data-diff-id="r1"]'), null);
  assert.ok(document.querySelector('[data-diff-id="r3"]'));
  assert.ok(document.querySelector('[data-diff-id="r4"]'));
  await React.act(async () => {
    group.open = true;
    group.dispatchEvent(new dom.window.Event("toggle"));
  });
  assert.deepEqual(
    [...group.querySelectorAll(".rdv-diff-position")].map(
      (el) => el.textContent,
    ),
    ["#20 → —", "#21 → —"],
  );
  assert.deepEqual(
    [...document.querySelectorAll("[data-diff-id]")].map(
      (el) => el.dataset.diffId,
    ),
    ["r1", "r2", "added", "r3", "r4"],
  );
});

test("Expand all opens lazy diff groups, rows and nested details in one click", async (t) => {
  const nested = message({
    items: Array.from({ length: 4 }, (_, i) => ({
      children: [{ value: "deep-content-" + i }],
    })),
  });
  const rows = [
    row("kept-a", 0, 0, ["unchanged"], nested, nested),
    row("kept-b", 1, 1, ["unchanged"], nested, nested),
    row("removed-a", 2, null, ["removed"], nested, null),
    row("removed-b", 3, null, ["removed"], nested, null),
    row("changed", 4, 2, ["modified"], nested, nested),
  ];
  const { document, dom } = await mount(t, payload(rows), [nested]);
  const click = async (element) =>
    React.act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      // jsdom schedules native details toggle events in a later task.
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
  const control = (name) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent === name,
    );
  const timeline = document.querySelector('[aria-label="Message changes"]');
  await click(control("Expand all"));
  assert.equal(timeline.querySelectorAll(".rdv-diff-row").length, 5);
  assert.equal(
    timeline.querySelectorAll(".rdv-diff-content").length,
    5,
    "first click mounts row contents",
  );
  assert.ok(timeline.querySelectorAll(".rdv-node").length > 4);
  assert.ok(
    [...timeline.querySelectorAll("details")].every((el) => el.open),
    "all nested details are open",
  );
  assert.match(timeline.textContent, /deep-content-3/);
  const nestedNode = timeline.querySelector(".rdv-node");
  await click(nestedNode.querySelector("summary"));
  assert.equal(nestedNode.open, false, "manual nested collapse still works");
  await click(nestedNode.querySelector("summary"));
  assert.equal(nestedNode.open, true);
  const group = timeline.querySelector(".rdv-diff-group");
  await click(group.querySelector("summary"));
  assert.equal(group.open, false);
  await click(group.querySelector("summary"));
  assert.equal(group.open, true);
  const child = group.querySelector(".rdv-diff-row");
  await click(child.querySelector("summary"));
  assert.equal(child.open, false);
  await click(control("Expand all"));
  assert.ok(
    [...timeline.querySelectorAll("details")].every((el) => el.open),
    "repeated command overrides manual collapse",
  );
  await click(control("Collapse all"));
  assert.ok([...timeline.querySelectorAll("details")].every((el) => !el.open));
  assert.equal(timeline.querySelectorAll(".rdv-diff-content").length, 0);
  await click(group.querySelector("summary"));
  assert.equal(group.open, true, "manual reopen after Collapse all works");
  const reopenedChild = group.querySelector(".rdv-diff-row");
  assert.equal(reopenedChild.open, false);
  await click(reopenedChild.querySelector("summary"));
  assert.equal(reopenedChild.open, true);
  assert.ok(reopenedChild.querySelector(".rdv-diff-content"));
  // The diff command must not leak into other tabs; legacy controls and
  // DataTree's default expansion remain usable in Messages.
  await click(
    [...document.querySelectorAll("button")].find((el) =>
      /^Messages/.test(el.textContent),
    ),
  );
  const scroll = document.querySelector(".rdv-detail-scroll");
  assert.ok(scroll.querySelector(".rdv-node"));
  await click(control("Expand all"));
  assert.ok([...scroll.querySelectorAll("details")].every((el) => el.open));
  await click(control("Collapse all"));
  assert.ok([...scroll.querySelectorAll("details")].every((el) => !el.open));
  const messageNode = scroll.querySelector(".rdv-node");
  await click(messageNode.querySelector("summary"));
  assert.equal(messageNode.open, true);
});

test("an old backend payload shows a version warning instead of blanking the dashboard", async (t) => {
  const { document } = await mount(t, {
    previous_file: "request_dump_before.json",
    removed_messages: [],
    added_messages: [],
  });
  assert.match(document.body.textContent, /restart the dashboard.*refresh/i);
  assert.ok(document.querySelector(".rdv-page"));
});

test("F17 a moved tool source transfers keyboard focus to the opened destination summary", async (t) => {
  const call = (args) => ({
    role: "assistant",
    tool_calls: [
      { id: "call-1", function: { name: "skill_view", arguments: args } },
    ],
  });
  const { document, dom } = await mount(
    t,
    payload(
      [
        {
          kind: "move_source",
          id: "source",
          target_id: "changed",
          before_index: 0,
          after_index: 2,
        },
        row(
          "changed",
          0,
          2,
          ["modified", "moved"],
          call('{"name":"before-skill"}'),
          call('{"name":"after-skill"}'),
        ),
      ],
      { modified: 1, moved: 1 },
    ),
  );
  const link = document.querySelector('[href="#diff-changed"]');
  assert.ok(link, "source marker must link to destination");
  assert.equal(document.querySelectorAll('[data-diff-id="changed"]').length, 1);
  assert.match(document.body.textContent, /skill_view/);
  await React.act(async () => {
    link.focus();
    // jsdom does not synthesize native activation from Enter. Dispatch the
    // keyboard activation click (detail=0) that the browser would generate.
    link.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    link.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 0,
      }),
    );
    document
      .getElementById("diff-changed")
      .dispatchEvent(new dom.window.Event("toggle"));
  });
  assert.equal(document.getElementById("diff-changed").open, true);
  assert.ok(
    document.activeElement ===
      document.querySelector("#diff-changed > summary"),
    "keyboard focus follows the move to its destination summary",
  );
  assert.match(
    document.querySelector(".rdv-diff-pair").textContent,
    /before-skill.*after-skill/s,
  );
  assert.doesNotMatch(document.body.textContent, /#NaN/);
});

test("first request and identical empty requests remain readable", async (t) => {
  await t.test("first request", async (t) => {
    const { document } = await mount(t, {
      ...payload([]),
      previous_file: null,
    });
    assert.match(document.body.textContent, /First dump in this session/);
  });
  await t.test("identical empty requests", async (t) => {
    const { document } = await mount(t, payload([]));
    assert.ok(document.querySelector('[aria-label="Message changes"]'));
    assert.match(document.body.textContent, /0 unchanged/);
  });
});
