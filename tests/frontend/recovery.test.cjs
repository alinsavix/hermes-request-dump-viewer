const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mount,
  message,
  meta,
  payload,
  row,
  deferred,
} = require("./app-harness.cjs");

test("F01 unexpected detail setup failure preserves the session shell and recovers on Refresh", async (t) => {
  const app = await mount(t, { detail: { tools: null } });
  assert.ok(app.document.querySelector(".rdv-page"));
  assert.equal(app.document.querySelectorAll(".rdv-list-item").length, 1);
  assert.match(
    app.document.querySelector("[role=alert]").textContent,
    /Request detail.*could not be displayed/,
  );
  assert.deepEqual(app.errors, []);
  assert.equal(app.caught.length, 1);
  app.detail.tools = [];
  await app.click("Refresh");
  assert.equal(app.document.querySelectorAll("[role=tab]").length, 5);
  assert.ok(!app.document.querySelector("[role=alert]"));
});

test("F01 failed tab rendering recovers when refreshed detail arrives asynchronously", async (t) => {
  const reload = deferred();
  let attempt = 0;
  const app = await mount(t, {
    tab: "overview",
    detail: { analysis: { composition: { parts: {} } } },
    fetch: (url) => {
      if (url.endsWith("/" + meta.file) && ++attempt > 1) return reload.promise;
    },
  });
  assert.ok(app.document.querySelector("[role=alert]"));
  await app.click("Refresh");
  await app.settle(() => reload.resolve({ ...app.detail, analysis: {} }));
  assert.ok(
    app.document.querySelector(".rdv-overview"),
    "new detail resets the failed tab after the pending refresh completes",
  );
  assert.ok(!app.document.querySelector("[role=alert]"));
  assert.deepEqual(app.errors, []);
});

test("F01 unexpected tab rendering failure stays local and can retry", async (t) => {
  const analysis = { composition: { parts: {} } };
  const app = await mount(t, { tab: "overview", detail: { analysis } });
  assert.ok(app.document.querySelector(".rdv-page"));
  assert.equal(app.document.querySelectorAll('[role="tab"]').length, 5);
  assert.match(
    app.document.querySelector('[role="alert"]').textContent,
    /overview.*could not be displayed/i,
  );
  assert.equal(
    app.caught.length,
    1,
    "actual invalid analysis shape triggers the boundary",
  );
  assert.deepEqual(app.errors, []);
  await app.tab("Messages");
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /hello/,
  );
  assert.equal(app.document.querySelector('[role="alert"]'), null);
  await app.tab("Overview");
  analysis.composition.parts = [];
  await app.click("Retry view");
  assert.ok(app.document.querySelector(".rdv-overview"));
  assert.equal(app.document.querySelector('[role="alert"]'), null);
});

test("F12 older deep links reconcile sidebar identity from detail and ignore cross-session completions", async (t) => {
  const older = deferred(),
    staleReload = deferred();
  const other = {
    ...meta,
    file: "request_dump_other_latest.json",
    session_id: "other",
    model: "OTHER_SESSION",
  };
  const correct = {
    ...meta,
    file: "request_dump_fixture_latest.json",
    model: "CORRECT_SESSION",
  };
  let loads = 0;
  const app = await mount(t, {
    items: [other, correct],
    fetch: (url) => {
      if (url.endsWith("/" + meta.file))
        return ++loads === 1 ? older.promise : staleReload.promise;
      if (url.endsWith("/" + other.file))
        return {
          meta: other,
          messages: [message("other request")],
          tools: [],
          analysis: {},
        };
    },
  });
  assert.equal(
    app.document.querySelectorAll(".rdv-list-item.active").length,
    0,
    "an unknown older filename must not guess the first session",
  );
  await app.settle(() => older.resolve(app.detail));
  assert.equal(
    app.document.querySelectorAll(".rdv-list-item.active").length,
    1,
  );
  assert.match(
    app.document.querySelector(".rdv-list-item.active").textContent,
    /CORRECT_SESSION/,
  );
  await app.click("Refresh");
  await app.click(
    [...app.document.querySelectorAll(".rdv-list-item")].find((node) =>
      node.textContent.includes("OTHER_SESSION"),
    ),
  );
  assert.match(
    app.document.querySelector(".rdv-list-item.active").textContent,
    /OTHER_SESSION/,
  );
  await app.settle(() => staleReload.resolve(app.detail));
  assert.match(
    app.document.querySelector(".rdv-list-item.active").textContent,
    /OTHER_SESSION/,
  );
  assert.match(
    app.document.querySelector(".rdv-title").textContent,
    /OTHER_SESSION/,
  );
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /other request/,
  );
  assert.deepEqual(app.errors, []);
});

test("F11 timeline retry clears stale errors before pending and successful responses", async (t) => {
  const retry = deferred();
  let attempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/timeline"))
        return ++attempt === 1
          ? Promise.reject(new Error("temporary timeline failure"))
          : retry.promise;
    },
  });
  assert.match(
    app.document.querySelector(".rdv-timeline-error").textContent,
    /temporary timeline failure/,
  );
  await app.click("Refresh");
  assert.equal(app.count("/timeline"), 2);
  assert.ok(
    !app.document.querySelector(".rdv-timeline-error"),
    "clear obsolete errors as soon as retry begins",
  );
  await app.settle(() => retry.resolve({ items: [meta] }));
  assert.equal(app.document.querySelector(".rdv-timeline-error"), null);
  assert.match(
    app.document.querySelector(".rdv-timeline").textContent,
    /1 request/,
  );
  assert.deepEqual(app.errors, []);
});

test("F10 failed refresh preserves healthy detail and can recover on the next Refresh", async (t) => {
  let attempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (!url.endsWith("/" + meta.file)) return;
      if (++attempt === 2)
        return Promise.reject(new Error("temporary detail refresh failure"));
    },
  });
  await app.click("Expand all");
  const node = app.document.getElementById("message-1");
  await app.click("Refresh");
  assert.equal(
    app.document.querySelectorAll("[role=tab]").length,
    5,
    "refresh failure must not wipe a previously loaded request",
  );
  assert.ok(app.document.getElementById("message-1") === node);
  assert.match(
    app.document.querySelector("[role=alert]").textContent,
    /temporary detail refresh failure/,
  );
  await app.click("Refresh");
  assert.ok(app.document.getElementById("message-1") === node);
  assert.equal(node.open, true);
  assert.ok(!app.document.querySelector("[role=alert]"));
});

test("F10 Refresh reloads detail and outcome without losing the active tab, search, or expansion", async (t) => {
  const reload = deferred();
  let detailAttempt = 0,
    outcomeAttempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/" + meta.file)) {
        detailAttempt += 1;
        if (detailAttempt > 1) return reload.promise;
      }
      if (url.endsWith("/outcome"))
        return {
          found: true,
          content:
            ++outcomeAttempt === 1
              ? "hello old outcome"
              : "hello final outcome",
        };
    },
  });
  await app.click("Expand all");
  const input = app.document.querySelector(".rdv-message-search input");
  await app.settle(() => {
    Object.getOwnPropertyDescriptor(
      app.dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, "hello");
    input.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  });
  const messageNode = app.document.getElementById("message-1");
  const outcomeNode = app.document.querySelector(".rdv-outcome-message");
  await app.click("Refresh");
  assert.equal(
    app.count("/" + meta.file),
    2,
    "explicit refresh reloads selected detail",
  );
  assert.equal(
    app.document.getElementById("message-1"),
    messageNode,
    "healthy UI stays mounted while refresh is pending",
  );
  assert.equal(messageNode.open, true);
  await app.settle(() =>
    reload.resolve({
      ...app.detail,
      messages: [message("hello updated detail")],
    }),
  );
  assert.equal(app.count("/outcome"), 2);
  assert.equal(app.document.querySelector(".rdv-outcome-message"), outcomeNode);
  assert.match(outcomeNode.textContent, /hello final outcome/);
  assert.match(messageNode.textContent, /hello updated detail/);
  assert.equal(input.value, "hello");
  assert.equal(messageNode.open, true);
  assert.match(
    app.document.querySelector("[role=tab][aria-selected=true]").textContent,
    /^Messages/,
  );
  assert.deepEqual(app.errors, []);
});

test("F07 diff errors stay in Diff with local retry and explicit Refresh recovery", async (t) => {
  const retry = deferred();
  let attempt = 0;
  const app = await mount(t, {
    tab: "diff",
    fetch: (url) => {
      if (!url.endsWith("/diff")) return;
      attempt += 1;
      if (attempt === 2) return retry.promise;
      if (attempt === 4)
        return payload([row("refreshed", message("refreshed diff"))]);
      return Promise.reject(new Error("temporary diff failure"));
    },
  });
  assert.equal(
    app.document.querySelectorAll('[role="tab"]').length,
    5,
    "healthy tabs survive a diff failure",
  );
  assert.match(
    app.document.querySelector(".rdv-detail-scroll [role=alert]").textContent,
    /temporary diff failure/,
  );
  const detailLoads = app.count("/" + meta.file);
  await app.click("Retry diff");
  assert.equal(
    app.document.querySelector(".rdv-detail-scroll [role=alert]"),
    null,
  );
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /Loading diff/,
  );
  await app.settle(() =>
    retry.resolve(payload([row("retried", message("retried diff"))])),
  );
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /retried diff/,
  );
  assert.equal(
    app.count("/" + meta.file),
    detailLoads,
    "local retry does not reload healthy detail",
  );
  await app.tab("Messages");
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /hello/,
  );
  await app.tab("Diff");
  assert.match(
    app.document.querySelector(".rdv-detail-scroll [role=alert]").textContent,
    /temporary diff failure/,
  );
  await app.click("Refresh");
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /refreshed diff/,
  );
  assert.equal(app.count("/diff"), 4);
  assert.deepEqual(app.errors, []);
});

test("F07 canceled pending diffs refetch on return and stale completions cannot replace the latest result", async (t) => {
  const waits = [deferred(), deferred(), deferred()];
  let index = 0;
  const app = await mount(t, {
    tab: "diff",
    fetch: (url) =>
      url.endsWith("/diff") ? waits[index++].promise : undefined,
  });
  assert.equal(app.count("/diff"), 1);
  await app.tab("Overview");
  await app.settle(() =>
    waits[0].resolve(payload([row("stale", message("stale first result"))])),
  );
  await app.tab("Diff");
  assert.equal(app.count("/diff"), 2, "return must start a replacement fetch");
  await app.tab("Messages");
  await app.tab("Diff");
  assert.equal(app.count("/diff"), 3);
  await app.settle(() =>
    waits[2].resolve(payload([row("fresh", message("latest result"))])),
  );
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /latest result/,
  );
  await app.settle(() => waits[1].reject(new Error("late canceled error")));
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /latest result/,
  );
  assert.equal(app.document.querySelector(".rdv-error"), null);
  assert.deepEqual(app.errors, []);
});

test("F07/F10/F12 rapid request switches reject stale diff, outcome, and timeline responses", async (t) => {
  const pendingDiff = deferred(),
    pendingOutcome = deferred(),
    pendingTimeline = deferred();
  const other = {
    ...meta,
    file: "request_dump_other.json",
    session_id: "other",
    model: "OTHER_SESSION",
  };
  const app = await mount(t, {
    tab: "diff",
    items: [meta, other],
    fetch: (url) => {
      if (url.endsWith("/" + meta.file + "/diff")) return pendingDiff.promise;
      if (url.includes("/sessions/fixture/") && url.endsWith("/outcome"))
        return pendingOutcome.promise;
      if (url.includes("/sessions/fixture/") && url.endsWith("/timeline"))
        return pendingTimeline.promise;
      if (url.endsWith("/" + other.file))
        return {
          meta: other,
          messages: [message("other request")],
          tools: [],
          analysis: {},
        };
      if (url.includes("/sessions/other/") && url.endsWith("/outcome"))
        return { found: true, content: "other outcome" };
      if (url.includes("/sessions/other/") && url.endsWith("/timeline"))
        return { items: [other] };
      if (url.endsWith("/" + other.file + "/diff"))
        return payload([row("other", message("other diff"))]);
    },
  });
  await app.click(
    [...app.document.querySelectorAll(".rdv-list-item")].find((node) =>
      node.textContent.includes("OTHER_SESSION"),
    ),
  );
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /other diff/,
  );
  await app.settle(() => {
    pendingDiff.resolve(payload([row("stale", message("stale diff"))]));
    pendingOutcome.resolve({ found: true, content: "stale outcome" });
    pendingTimeline.reject(new Error("stale timeline error"));
  });
  assert.match(
    app.document.querySelector(".rdv-detail-scroll").textContent,
    /other diff/,
  );
  assert.match(
    app.document.querySelector(".rdv-list-item.active").textContent,
    /OTHER_SESSION/,
  );
  await app.tab("Messages");
  assert.match(
    app.document.querySelector(".rdv-outcome-message").textContent,
    /other outcome/,
  );
  assert.doesNotMatch(app.document.body.textContent, /stale/);
  assert.deepEqual(app.errors, []);
});

test("F10 pending outcomes from an older refresh cannot overwrite a newer outcome", async (t) => {
  const old = deferred();
  let attempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/outcome"))
        return ++attempt === 1
          ? old.promise
          : { found: true, content: "new outcome" };
    },
  });
  await app.click("Refresh");
  assert.match(
    app.document.querySelector(".rdv-outcome-message").textContent,
    /new outcome/,
  );
  await app.settle(() => old.resolve({ found: true, content: "old outcome" }));
  assert.match(
    app.document.querySelector(".rdv-outcome-message").textContent,
    /new outcome/,
  );
  assert.doesNotMatch(
    app.document.querySelector(".rdv-outcome-message").textContent,
    /old outcome/,
  );
});

test("F09 argument paths handle null, missing, and fallback arguments without inventing properties", async (t) => {
  const calls = [
    { id: "null", function: { name: "null", arguments: null } },
    { id: "missing", function: { name: "missing" } },
    {
      id: "fallback-null",
      function: { name: "fallback", arguments: null },
      arguments: { x: 1 },
    },
  ];
  const app = await mount(t, {
    detail: { messages: [{ role: "assistant", tool_calls: calls }] },
  });
  await app.click("Expand all");
  const nodes = app.document.querySelectorAll(".rdv-tool");
  await app.click(app.button("Copy JSONPath", nodes[0]));
  assert.equal(
    app.copied.at(-1),
    "$.messages[0].tool_calls[0].function.arguments",
  );
  assert.equal(
    app.button("Copy JSONPath", nodes[1]).disabled,
    true,
    "missing arguments do not have a path",
  );
  await app.click(app.button("Copy JSONPath", nodes[2]));
  assert.equal(app.copied.at(-1), "$.messages[0].tool_calls[2].arguments");
});

test("F09 copied paths resolve against redacted detail for Responses messages, calls, and ranked schemas", async (t) => {
  const messages = [
    {
      role: "system",
      content: "instructions",
      _responses_kind: "instructions",
    },
    { role: "reasoning", content: { encrypted_content: "opaque" } },
    { role: "assistant", content: "" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "nested", function: { name: "nested", arguments: '{"x":1}' } },
        { id: "flat", name: "flat", arguments: '{"x":2}' },
        {
          id: "fallback",
          function: { name: "fallback" },
          arguments: '{"x":3}',
        },
      ],
    },
  ];
  const tools = [
    { type: "function", function: { name: "short", parameters: {} } },
    {
      type: "function",
      name: "long",
      description: "large schema ".repeat(50),
      parameters: {},
    },
  ];
  const analysis = {
    prompt_sections: [
      {
        id: "p",
        title: "Instructions",
        content: "instructions",
        message_index: 0,
      },
    ],
  };
  const app = await mount(t, { detail: { messages, tools, analysis } });
  await app.click("Copy redacted JSON");
  const document = JSON.parse(app.copied.at(-1));
  const resolve = (path) => {
    assert.match(path, /^\$(?:\.[a-z_]+|\[\d+\])*$/);
    return path
      .slice(2)
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .reduce((node, key) => node?.[key], document);
  };
  const check = async (scope, expectedPath, expectedValue) => {
    const button = app.button("Copy JSONPath", scope);
    await app.click(button);
    assert.equal(app.copied.at(-1), expectedPath);
    assert.deepEqual(resolve(app.copied.at(-1)), expectedValue);
    assert.equal(button.title, "");
    assert.ok(
      !app.document.body.textContent.includes(
        "JSONPath in copied/downloaded redacted detail, not the raw provider request",
      ),
    );
  };
  await app.click("Expand all");
  await check(
    app.document.querySelector(
      "#message-1 > .rdv-message-body > .rdv-item-actions",
    ),
    "$.messages[0]",
    messages[0],
  );
  assert.equal(
    app.document.querySelector("#message-3"),
    null,
    "collapsed followup must not renumber source indices",
  );
  await check(
    app.document.querySelector(
      "#message-4 > .rdv-message-body > .rdv-item-actions",
    ),
    "$.messages[3]",
    messages[3],
  );
  const calls = app.document.querySelectorAll(".rdv-tool");
  await check(
    calls[0],
    "$.messages[3].tool_calls[0].function.arguments",
    messages[3].tool_calls[0].function.arguments,
  );
  await check(
    calls[1],
    "$.messages[3].tool_calls[1].arguments",
    messages[3].tool_calls[1].arguments,
  );
  await check(
    calls[2],
    "$.messages[3].tool_calls[2].arguments",
    messages[3].tool_calls[2].arguments,
  );
  await app.tab("Schemas");
  const schemas = app.document.querySelectorAll(".rdv-schema");
  await check(schemas[0], "$.tools[1]", tools[1]);
  await check(schemas[1], "$.tools[0].function", tools[0].function);
  await app.tab("Prompt map");
  await check(
    app.document.querySelector(".rdv-prompt-section"),
    "$.analysis.prompt_sections[0]",
    analysis.prompt_sections[0],
  );
  assert.doesNotMatch(
    app.document.querySelector(".rdv-detail-actions").textContent,
    /JSONPath.*redacted detail.*not.*raw/i,
  );
});

test("F08 diagnostic envelopes survive nested JSON rendering and argument copying", async (t) => {
  const source = 'ERROR: job failed\n{"ok":true}\nprocess exited 1';
  const value = {
    role: "assistant",
    content: { output: source, complete: '{"parsed":true}' },
    tool_calls: [
      { id: "wrapped", function: { name: "synthetic", arguments: source } },
    ],
  };
  const app = await mount(t, {
    detail: { messages: [value] },
    diff: payload([row("wrapped", value)]),
  });
  await app.click("Expand all");
  const body = app.document.querySelector(".rdv-message-body");
  assert.ok(
    body.textContent.includes(source),
    "preserve the complete error envelope",
  );
  assert.ok(
    body.textContent.includes('{"parsed":true}'),
    "a complete JSON-looking nested string remains literal text",
  );
  await app.click("Copy arguments");
  assert.equal(app.copied.at(-1), source);
  await app.tab("Diff");
  await app.click("Expand all");
  assert.ok(
    app.document
      .querySelector(".rdv-diff-content")
      .textContent.includes(source),
  );
});

test("F01 arbitrary JSON labels render safely in Messages and expanded Diff", async (t) => {
  const content = [
    {
      name: { first: "Synthetic" },
      value: 1,
      nested: [{ type: { arbitrary: true } }],
    },
    { type: ["nested", { role: {} }], value: 2 },
    { role: { arbitrary: [{ name: [null, { type: false }] }] }, value: 3 },
    { name: 0, type: true, role: false },
  ];
  const value = {
    role: "tool",
    name: "synthetic_tool",
    content: JSON.stringify(content),
  };
  const app = await mount(t, {
    detail: { messages: [value] },
    diff: payload([row("arbitrary", value)]),
  });
  assert.deepEqual(
    app.errors,
    [],
    "valid JSON must not throw React child errors",
  );
  assert.ok(app.document.querySelector(".rdv-page"));
  await app.click("Expand all");
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /Synthetic/,
  );
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /Arbitrary/,
  );
  await app.tab("Diff");
  await app.click("Expand all");
  assert.match(
    app.document.querySelector(".rdv-diff-content").textContent,
    /Synthetic/,
  );
  assert.deepEqual(app.errors, []);
  assert.deepEqual(
    app.caught,
    [],
    "valid JSON should not need an error fallback",
  );
});
