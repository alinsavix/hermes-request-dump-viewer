const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount, meta, message, deferred } = require("./app-harness.cjs");

test("R03 initial list failure keeps the shell and retries through repeated failure to recovery", async (t) => {
  let attempt = 0;
  const pending = deferred();
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/dumps") && ++attempt < 3)
        return Promise.reject(new Error("synthetic 503"));
      if (url.endsWith("/dumps")) return pending.promise;
    },
  });
  for (let i = 0; i < 2; i++) {
    assert.ok(app.document.querySelector(".rdv-page"));
    assert.ok(app.button("Refresh"));
    assert.match(
      app.document.querySelector("[role=alert]").textContent,
      /Could not scan request dumps: synthetic 503/,
    );
    assert.doesNotMatch(
      app.document.body.textContent,
      /No request dumps found/,
    );
    await app.click("Retry");
  }
  assert.equal(app.document.querySelector("[role=alert]"), null);
  assert.ok(app.button("Scanning…").disabled);
  await app.settle(() => pending.resolve({ items: [meta], dump_count: 2 }));
  assert.equal(app.document.querySelectorAll(".rdv-list-item").length, 1);
  assert.match(
    app.document.querySelector(".rdv-message-body").textContent,
    /hello/,
  );
  assert.equal(app.document.querySelector("[role=alert]"), null);
  assert.deepEqual(app.errors, []);
});

test("R03 list refresh failures retain the last-good list, selection, search and expanded detail", async (t) => {
  let attempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/dumps") && [2, 3].includes(++attempt))
        return Promise.reject(new Error("synthetic refresh 503"));
    },
  });
  await app.click("Expand all");
  const node = app.document.getElementById("message-1");
  const list = app.document.querySelector(".rdv-list-item.active");
  const search = app.document.querySelector(".rdv-message-search input");
  await app.settle(() => {
    Object.getOwnPropertyDescriptor(
      app.dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(search, "hello");
    search.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  });
  for (const action of ["Refresh", "Retry", "Retry"]) {
    await app.click(action);
    assert.equal(app.document.getElementById("message-1"), node);
    assert.equal(node.open, true);
    assert.equal(app.document.querySelector(".rdv-list-item.active"), list);
    assert.equal(search.value, "hello");
    assert.equal(
      app.dom.window.location.search.includes("dump=" + meta.file),
      true,
    );
    assert.match(
      app.document.querySelector(".rdv-top-title").textContent,
      /1 sessions · 2 requests/,
    );
    if (attempt < 4) {
      assert.match(
        app.document.querySelector("[role=alert]").textContent,
        /synthetic refresh 503/,
      );
      assert.equal(
        app.count("/" + meta.file),
        1,
        "failed list scans do not reload healthy detail",
      );
    }
  }
  assert.equal(app.document.querySelector("[role=alert]"), null);
  assert.equal(app.count("/" + meta.file), 2);
  assert.deepEqual(app.errors, []);
});

test("R03 superseded list success cannot replace last-good state or finish a newer scan", async (t) => {
  const old = deferred(),
    current = deferred();
  let attempt = 0;
  const app = await mount(t, {
    fetch: (url) => {
      if (url.endsWith("/dumps")) {
        attempt++;
        if (attempt === 2) return old.promise;
        if (attempt === 3) return current.promise;
      }
    },
  });
  const node = app.document.getElementById("message-1");
  const refresh = app.button("Refresh");
  await app.settle(() => {
    refresh.click();
    refresh.click();
  });
  assert.equal(
    attempt,
    3,
    "rapid clicks overlap before the disabled state commits",
  );
  await app.settle(() => old.resolve({ items: [], dump_count: 0 }));
  assert.equal(app.document.getElementById("message-1"), node);
  assert.ok(
    app.button("Scanning…")?.disabled,
    "stale finally must not clear current busy state",
  );
  assert.equal(app.count("/" + meta.file), 1);
  await app.settle(() => current.reject(new Error("latest scan failed")));
  assert.match(
    app.document.querySelector("[role=alert]").textContent,
    /latest scan failed/,
  );
  assert.equal(app.document.getElementById("message-1"), node);
  await app.click("Retry");
  assert.equal(app.document.querySelector("[role=alert]"), null);
  assert.equal(app.document.getElementById("message-1"), node);
  assert.deepEqual(app.errors, []);
});

test("R03 stale list failure cannot overwrite newer success or a selection made during refresh", async (t) => {
  const old = deferred(),
    current = deferred();
  const other = {
    ...meta,
    file: "request_dump_other.json",
    session_id: "other",
    model: "OTHER_SESSION",
  };
  let attempt = 0;
  const app = await mount(t, {
    items: [meta, other],
    fetch: (url) => {
      if (url.endsWith("/dumps")) {
        attempt++;
        if (attempt === 2) return old.promise;
        if (attempt === 3) return current.promise;
      }
      if (url.endsWith("/" + other.file))
        return {
          meta: other,
          messages: [message("other request")],
          tools: [],
          analysis: {},
        };
    },
  });
  const refresh = app.button("Refresh");
  await app.settle(() => {
    refresh.click();
    refresh.click();
  });
  await app.click(
    [...app.document.querySelectorAll(".rdv-list-item")].find((node) =>
      node.textContent.includes("OTHER_SESSION"),
    ),
  );
  const node = app.document.getElementById("message-1");
  await app.settle(() =>
    current.resolve({ items: [meta, other], dump_count: 3 }),
  );
  await app.settle(() => old.reject(new Error("stale list failure")));
  assert.equal(app.document.querySelector("[role=alert]"), null);
  assert.equal(app.document.getElementById("message-1"), node);
  assert.match(node.textContent, /other request/);
  assert.match(
    app.document.querySelector(".rdv-list-item.active").textContent,
    /OTHER_SESSION/,
  );
  assert.match(
    app.document.querySelector(".rdv-top-title").textContent,
    /2 sessions · 3 requests/,
  );
  assert.ok(app.button("Refresh"));
  assert.deepEqual(app.errors, []);
});
