const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount } = require("./app-harness.cjs");

const markup =
  '<img src=x onerror="window.labelExecuted=true"><script>window.labelExecuted=true</script>';
const cases = [
  ["object", { nested: { text: markup }, count: 2 }],
  ["array", ["first", { text: markup }, null, false, 7]],
  ["empty object", {}],
  ["empty array", []],
  ["null", null],
  ["true", true],
  ["false", false],
  ["number", 12.5],
  ["zero", 0],
  ["markup string", markup],
  ["empty string", ""],
  ["missing", undefined],
];

test("full App renders malformed message labels as text without losing the original message", async (t) => {
  for (const field of ["role", "status", "phase"]) {
    for (const [kind, value] of cases) {
      await t.test(`${field}: ${kind}`, async (t) => {
        const message = {
          role: "user",
          content: "synthetic content",
          [field]: value,
        };
        const original = JSON.stringify(message);
        const app = await mount(t, { detail: { messages: [message] } });
        assert.deepEqual(app.errors, [], "no uncaught render errors");
        assert.deepEqual(app.caught, [], "no error-boundary fallback");
        assert.equal(app.document.querySelector('[role="alert"]'), null);
        const summary = app.document.querySelector("#message-1 > summary");
        assert.ok(summary, "the real App renders its message header");
        const label = summary.querySelector(
          field === "role" ? ".rdv-role" : ".rdv-status",
        );
        const expected =
          value == null
            ? ""
            : typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2);
        if (field === "role") {
          assert.equal(label.textContent, expected || "unknown");
        } else if (value == null || value === "") {
          assert.equal(label, null, "absent labels do not create a badge");
        } else {
          assert.equal(label?.textContent, expected);
        }
        assert.equal(
          summary.querySelector("img, script, [onerror]"),
          null,
          "markup stays text, not executable DOM",
        );
        assert.equal(app.dom.window.labelExecuted, undefined);
        await app.click("Expand all");
        await app.click("Copy message");
        assert.deepEqual(JSON.parse(app.copied.at(-1)), JSON.parse(original));
        assert.equal(
          JSON.stringify(app.detail.messages[0]),
          original,
          "rendering does not normalize the stored data",
        );
      });
    }
  }
});

test("full App keeps ordinary role, status, phase and tool labels unchanged", async (t) => {
  const roles = ["system", "developer", "user", "assistant", "reasoning", "tool"];
  const messages = roles.map((role) => ({
    role,
    status: "completed",
    phase: "final_answer",
    content: "synthetic content",
    ...(role === "tool" ? { name: "lookup" } : {}),
  }));
  messages.push({
    role: "assistant",
    tool_calls: [
      { id: "lookup", function: { name: "lookup", arguments: '{"query":"test"}' } },
      { id: "terminal", function: { name: "terminal", arguments: '{"command":"test"}' } },
      { id: "execute", function: { name: "execute_code", arguments: '{"code":"test"}' } },
    ],
  });
  const app = await mount(t, { detail: { messages } });
  for (let i = 0; i < roles.length; i++) {
    const summary = app.document.querySelector(`#message-${i + 1} > summary`);
    assert.equal(
      summary.querySelector(".rdv-role").textContent,
      roles[i] === "tool" ? "tool result" : roles[i],
    );
    assert.deepEqual(
      [...summary.querySelectorAll(".rdv-status")].map((node) => node.textContent),
      ["completed", "final_answer"],
    );
  }
  assert.equal(
    app.document.querySelector("#message-6 .rdv-message-preview").textContent,
    "lookup",
  );
  assert.deepEqual(
    [...app.document.querySelectorAll(".rdv-tool > summary")].map((node) => node.textContent),
    ["⚙ lookup(test)", "⚙ terminal", "⚙ execute_code"],
  );
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.caught, []);
});

test("full App highlights only human prompts and direct assistant responses", async (t) => {
  const app = await mount(t, {
    detail: {
      messages: [
        { role: "user", content: "Please inspect the moon." },
        { role: "assistant", content: "The moon is round." },
        {
          role: "assistant",
          tool_calls: [
            { id: "inspect", function: { name: "skill_view", arguments: "{}" } },
          ],
        },
        { role: "assistant", content: "" },
        { role: "tool", content: "tool output" },
        { role: "system", content: "system context" },
      ],
    },
  });
  assert.ok(app.document.querySelector("#message-1.rdv-message-user"));
  assert.ok(
    app.document.querySelector("#message-2.rdv-message-assistant-response"),
  );
  for (const index of [3, 4, 5, 6]) {
    assert.equal(
      app.document.querySelector(`#message-${index}.rdv-message-user`),
      null,
    );
    assert.equal(
      app.document.querySelector(`#message-${index}.rdv-message-assistant-response`),
      null,
    );
  }
});

test("full App displays persisted message timestamps without inventing one", async (t) => {
  const app = await mount(t, {
    detail: {
      messages: [
        { role: "system", content: "Injected prompt" },
        { role: "user", content: "Hello", persisted_at: 101.25 },
      ],
    },
  });
  assert.equal(app.document.querySelector("#message-1 .rdv-message-time"), null);
  assert.equal(
    app.document.querySelector("#message-2 .rdv-message-time").textContent,
    new Date(101250).toISOString(),
  );
  assert.equal(
    app.document.querySelector("#message-2 > summary").lastElementChild.classList.contains("rdv-message-time"),
    true,
  );
});


test("full App tool names already use string headers, not direct React children", async (t) => {
  for (const [kind, name] of cases) {
    await t.test(kind, async (t) => {
      const messages = [
        { role: "tool", name, content: "synthetic result" },
        {
          role: "assistant",
          tool_calls: [{ id: "synthetic", function: { name } }],
        },
      ];
      const app = await mount(t, { detail: { messages } });
      assert.deepEqual(app.errors, []);
      assert.deepEqual(app.caught, []);
      assert.equal(app.document.querySelectorAll(".rdv-message").length, 2);
      assert.ok(app.document.querySelector(".rdv-tool > summary"));
      assert.equal(app.document.querySelector("img, script, [onerror]"), null);
      assert.equal(app.dom.window.labelExecuted, undefined);
      await app.click("Expand all");
      for (let i = 0; i < messages.length; i++) {
        const node = app.document.querySelector(`#message-${i + 1}`);
        await app.click(app.button("Copy message", node));
        assert.deepEqual(
          JSON.parse(app.copied.at(-1)),
          JSON.parse(JSON.stringify(messages[i])),
        );
      }
    });
  }
});
