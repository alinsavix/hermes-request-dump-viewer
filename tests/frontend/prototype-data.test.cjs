const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount, payload, row } = require("./app-harness.cjs");

function ownProto(marker, fields = {}) {
  // JSON.parse creates an OWN data field, unlike __proto__ in a JS literal.
  const value = JSON.parse(`{"__proto__":{"auditProtoMarker":"${marker}","name":"inherited-name","role":"inherited-role"},"constructor":{"prototype":{"auditConstructorMarker":"constructor-data"}},"prototype":"ordinary-prototype-data"}`);
  for (const [key, field] of Object.entries(fields)) value[key] = field;
  return value;
}

for (const withContent of [true, false]) {
  test(`Diff preserves special JSON keys without prototype writes (content=${withContent})`, async (t) => {
    const value = ownProto("message-proto", {
      role: "assistant",
      ...(withContent ? { content: '{"plain":"content-data"}' } : {}),
      tool_calls: [
        ownProto("call-proto", {
          id: "nested",
          function: ownProto("function-proto", { name: "lookup", arguments: '{"plain":"argument-data"}' }),
        }),
        ownProto("flat-proto", { id: "flat", arguments: '{"plain":"flat-argument-data"}' }),
      ],
    });
    const original = JSON.stringify(value);
    const change = { ...row("special-keys", value), before: value, before_index: 0, status: ["modified"] };
    const app = await mount(t, { detail: { messages: [value] }, diff: payload([change]) });
    const proto = app.dom.window.Object.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "__proto__");
    const writes = [];
    Object.defineProperty(proto, "__proto__", {
      ...descriptor,
      set(next) {
        if (next && Object.hasOwn(next, "auditProtoMarker")) writes.push(next.auditProtoMarker);
        descriptor.set.call(this, next);
      },
    });
    t.after(() => Object.defineProperty(proto, "__proto__", descriptor));
    await app.tab("Diff");
    await app.click("Expand all");
    assert.deepEqual(writes, [], "dump data must never invoke a prototype setter");
    const content = app.document.querySelector(".rdv-diff-content");
    assert.ok(content, "Diff renders instead of entering its error boundary");
    const strings = [...content.querySelectorAll(".rdv-scalar-text")].map(node => node.textContent);
    for (const marker of ["message-proto", "call-proto", "function-proto", "flat-proto"]) {
      assert.equal(strings.filter(value => value === marker).length, 2, `${marker} visible on both Diff sides`);
    }
    assert.ok(strings.includes("constructor-data"));
    assert.ok(strings.includes("ordinary-prototype-data"));
    assert.equal(JSON.stringify(value), original, "source data unchanged");
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(Object.hasOwn(value, "__proto__"), true);
    assert.equal(proto.auditProtoMarker, undefined);
    assert.equal(Object.prototype.auditProtoMarker, undefined);
    const rowHeaders = [...content.querySelectorAll(".rdv-node > summary")].map(n => n.textContent);
    assert.ok(rowHeaders.every(label => !label.includes("inherited-name")), "prototype data cannot supply array-item headers");
    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.caught, []);
    await app.click("Copy redacted JSON");
    assert.deepEqual(JSON.parse(app.copied.at(-1)).messages[0], JSON.parse(original));
  });
}
