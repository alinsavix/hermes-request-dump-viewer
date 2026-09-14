const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount } = require("./app-harness.cjs");

for (const [enabled, source, expected] of [
  [true, "control_file", "live"],
  [false, "control_file", "paused"],
  [false, "invalid", "paused"],
  [false, "unavailable", "paused"],
]) {
  test(`capture retains original status label: ${source}/${enabled}`, async (t) => {
    const app = await mount(t, {
      fetch: (url) =>
        url.endsWith("/capture")
          ? { enabled, source, effective_enabled: null }
          : undefined,
    });
    const label = app.document.querySelector(".rdv-capture");
    assert.equal(label.querySelector("small").textContent, expected);
    assert.equal(label.title, "");
    assert.equal(
      label.querySelector('[role="switch"]').getAttribute("aria-checked"),
      String(enabled),
    );
    assert.deepEqual(app.errors, []);
  });
}
