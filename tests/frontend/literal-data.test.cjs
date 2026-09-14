const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount, payload, row } = require("./app-harness.cjs");

test("R02 structured boundaries preserve nested string types and literal escapes", async (t) => {
  const literals = [
    "9007199254740993",
    "123",
    "true",
    "null",
    '{"nested":true}',
    "[1,2]",
    String.raw`C:\new\test`,
    String.raw`literal\r\n\t`,
    "actual\nnewline\ttab",
  ];
  const value = {
    role: "tool",
    name: "synthetic",
    content: JSON.stringify({ literals, count: 3, ok: true }),
  };
  const app = await mount(t, {
    detail: {
      messages: [value, { role: "user", content: String.raw`C:\new\test` }],
    },
    diff: payload([row("literal", value)]),
  });
  await app.click("Expand all");
  const body = app.document.querySelector(".rdv-message-body");
  const strings = [...body.querySelectorAll(".rdv-scalar-text")].map(
    (node) => node.textContent,
  );
  assert.deepEqual(
    strings,
    literals,
    "string leaves stay strings, not JSON values",
  );
  assert.equal(body.querySelector(".rdv-number").textContent, "3");
  assert.equal(body.querySelector(".rdv-bool").textContent, "true");
  assert.equal(
    app.document.querySelector("#message-2 .rdv-content").textContent,
    String.raw`C:\new\test`,
  );
  await app.tab("Diff");
  await app.click("Expand all");
  assert.deepEqual(
    [
      ...app.document.querySelectorAll(
        ".rdv-diff-content .rdv-array .rdv-scalar-text",
      ),
    ].map((node) => node.textContent),
    literals,
  );
  assert.deepEqual(app.errors, []);
});

test("R02 Copy arguments copies original strings exactly, including whitespace and large numbers", async (t) => {
  const sources = [
    ' { "id":9007199254740993, "n":1.2300 }\n',
    '"quoted string"',
    String.raw`C:\new\test`,
    '{"safe":1}',
    { safe: 2 },
  ];
  const app = await mount(t, {
    detail: {
      messages: [
        {
          role: "assistant",
          tool_calls: sources.map((arguments, i) => ({
            id: String(i),
            function: { name: "lookup", arguments },
          })),
        },
      ],
    },
  });
  await app.click("Expand all");
  const calls = app.document.querySelectorAll(".rdv-tool");
  for (let i = 0; i < sources.length; i++) {
    await app.click(app.button("Copy arguments", calls[i]));
    assert.equal(
      app.copied.at(-1),
      typeof sources[i] === "string"
        ? sources[i]
        : JSON.stringify(sources[i], null, 2),
    );
  }
});

test("R02 lossy JSON numbers fall back to exact raw text while safe JSON stays structured", async (t) => {
  const raw = [
    ' {"id":9007199254740993}\n',
    '{"id":9007199254740992}',
    '{"id":-9007199254740993}',
    '{"x":0.123456789012345678901}',
    '{"x":1e400}',
    '{"x":1e-400}',
    '{"x":-0}',
    '{"x":1.2300}',
  ];
  const safe =
    ' { "id": 9007199254740991, "decimal": 1.25, "literal": "123 \\\"quoted\\\" \\n text" } ';
  const messages = raw
    .concat(safe)
    .map((content) => ({ role: "tool", name: "synthetic", content }));
  messages.push({
    role: "assistant",
    tool_calls: raw.map((arguments, i) => ({
      id: String(i),
      function: { name: "lookup", arguments },
    })),
  });
  const app = await mount(t, { detail: { messages } });
  await app.click("Expand all");
  for (let i = 0; i < raw.length; i++) {
    const body = app.document.querySelector(
      `#message-${i + 1} .rdv-message-body`,
    );
    assert.equal(body.querySelector(".rdv-scalar-text")?.textContent, raw[i]);
    assert.equal(body.querySelector(".rdv-number"), null);
    const call = app.document.querySelectorAll(".rdv-tool")[i];
    assert.equal(call.querySelector(".rdv-scalar-text")?.textContent, raw[i]);
    assert.ok(
      call.querySelector("summary").textContent.includes(raw[i].trim()),
      "summary must not round the number either",
    );
  }
  const safeBody = app.document.querySelector(
    `#message-${raw.length + 1} .rdv-message-body`,
  );
  assert.deepEqual(
    [...safeBody.querySelectorAll(".rdv-number")].map(
      (node) => node.textContent,
    ),
    ["9007199254740991", "1.25"],
  );
  assert.deepEqual(app.errors, []);
});

test("R02 tool arguments decode once at explicit boundaries in Messages and both Diff sides", async (t) => {
  const args = JSON.stringify({
    literal: '{"nested":true}',
    path: String.raw`C:\new\test`,
    count: 7,
  });
  const value = {
    role: "assistant",
    tool_calls: [
      { id: "nested", function: { name: "lookup", arguments: args } },
      { id: "flat", name: "lookup", arguments: args },
    ],
  };
  const change = {
    ...row("arguments", value),
    before: value,
    before_index: 0,
    status: ["modified"],
  };
  const app = await mount(t, {
    detail: { messages: [value] },
    diff: payload([change]),
  });
  await app.click("Expand all");
  assert.equal(
    app.document.querySelectorAll(".rdv-tool-data .rdv-number").length,
    2,
  );
  assert.deepEqual(
    [...app.document.querySelectorAll(".rdv-tool-data .rdv-scalar-text")].map(
      (node) => node.textContent,
    ),
    [
      '{"nested":true}',
      String.raw`C:\new\test`,
      '{"nested":true}',
      String.raw`C:\new\test`,
    ],
  );
  await app.tab("Diff");
  await app.click("Expand all");
  assert.equal(
    app.document.querySelectorAll(".rdv-diff-content .rdv-number").length,
    4,
    "both argument formats remain structured on both sides",
  );
  assert.equal(
    app.document.querySelectorAll(".rdv-diff-content .rdv-bool").length,
    0,
    "nested literal JSON never becomes a tree",
  );
  assert.deepEqual(app.errors, []);
});
