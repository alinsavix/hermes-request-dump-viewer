const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mount: fullApp, message, meta, deferred } = require("./app-harness.cjs");

async function search(app, query) {
  const input = app.document.querySelector(".rdv-message-search input");
  assert.ok(input);
  await app.settle(() => {
    Object.getOwnPropertyDescriptor(
      app.dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, query);
    input.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  });
}

async function enter(app, reverse = false) {
  const input = app.document.querySelector(".rdv-message-search input");
  await app.settle(() => input.dispatchEvent(new app.dom.window.KeyboardEvent(
    "keydown", { key: "Enter", shiftKey: reverse, bubbles: true, cancelable: true },
  )));
  assert.deepEqual(app.errors, [], "keyboard navigation must not throw");
  assert.deepEqual(app.caught, [], "navigation must not require an error fallback");
}

function count(app, expected) {
  assert.equal(app.document.querySelector(".rdv-search-count")?.textContent, expected);
}

function selected(app, id) {
  assert.equal(app.scrolled.at(-1), id);
  assert.equal(app.document.getElementById(id).open, true);
}

for (const size of [3, 1]) {
  test(`first Shift+Enter selects the last of ${size} matching messages`, async (t) => {
    const app = await fullApp(t, {
      detail: { messages: Array.from({ length: size }, (_, i) => message(`needle ${i}`)) },
    });
    await search(app, "needle");
    await enter(app, true);
    selected(app, `message-${size}`);
  });
}

for (const reverse of [false, true]) {
  test(`${reverse ? "reverse" : "forward"} navigation wraps in source order without renumbering filtered messages`, async (t) => {
    const app = await fullApp(t, {
      detail: { messages: [message("needle A"), message("irrelevant"), message("needle B")] },
    });
    await search(app, "  NeEdLe  ");
    count(app, "2 matches");
    assert.equal(app.document.getElementById("message-2"), null);
    assert.match(app.document.getElementById("message-3").querySelector("summary").textContent, /#3/);
    const expected = reverse
      ? ["message-3", "message-1", "message-3"]
      : ["message-1", "message-3", "message-1"];
    for (const id of expected) {
      await enter(app, reverse);
      selected(app, id);
    }
  });
}

test("singleton wraps in both directions and a zero-match query does nothing", async (t) => {
  const app = await fullApp(t, { detail: { messages: [message("needle")] } });
  await search(app, "needle");
  count(app, "1 match");
  for (const reverse of [false, true, false, true]) {
    await enter(app, reverse);
    selected(app, "message-1");
  }
  await search(app, "absent");
  count(app, "0 matches");
  assert.match(app.document.querySelector(".rdv-detail-scroll").textContent, /No matching messages/);
  const before = app.scrolled.length;
  await enter(app);
  await enter(app, true);
  assert.equal(app.scrolled.length, before);
});

test("query edits reset navigation to the first forward or last reverse match", async (t) => {
  const app = await fullApp(t, {
    detail: { messages: [message("needle A"), message("needle B"), message("needle C")] },
  });
  await search(app, "needle");
  await enter(app);
  await enter(app);
  selected(app, "message-2");
  await search(app, "NEEDLE");
  await enter(app);
  selected(app, "message-1");
  await search(app, "needle ");
  await enter(app, true);
  selected(app, "message-3");
  await search(app, "");
  count(app, undefined);
  await enter(app);
  selected(app, "message-1");
});

test("an outcome-only match is counted and navigable in both directions", async (t) => {
  const app = await fullApp(t, {
    fetch: (url) => url.endsWith("/outcome")
      ? { found: true, content: "Final NEEDLE response" } : undefined,
  });
  await search(app, "needle");
  count(app, "1 match");
  const outcome = app.document.querySelector(".rdv-outcome-message");
  assert.equal(outcome.id, "message-outcome");
  assert.equal(app.document.getElementById("message-1"), null);
  assert.doesNotMatch(app.document.querySelector(".rdv-detail-scroll").textContent, /No matching messages/);
  for (const reverse of [true, false, true]) {
    await enter(app, reverse);
    selected(app, "message-outcome");
  }
});

for (const reverse of [false, true]) {
  test(`mixed request/outcome matches wrap ${reverse ? "backward" : "forward"} in rendered order`, async (t) => {
    const app = await fullApp(t, {
      detail: { messages: [message("needle A"), message("irrelevant"), message("needle B")] },
      fetch: (url) => url.endsWith("/outcome")
        ? { found: true, content: "needle final needle" } : undefined,
    });
    await search(app, "needle");
    count(app, "3 matches");
    assert.deepEqual(
      [...app.document.querySelectorAll(".rdv-detail-scroll > .rdv-message")].map((node) => node.id),
      ["message-1", "message-3", "message-outcome"],
    );
    assert.equal(app.document.querySelectorAll("#message-outcome").length, 1);
    const expected = reverse
      ? ["message-outcome", "message-3", "message-1", "message-outcome"]
      : ["message-1", "message-3", "message-outcome", "message-1"];
    for (const id of expected) {
      await enter(app, reverse);
      selected(app, id);
    }
    await search(app, "irrelevant");
    count(app, "1 match");
    assert.equal(app.document.getElementById("message-outcome"), null);
  });
}

test("a matching outcome arriving asynchronously joins the current navigation order", async (t) => {
  const outcome = deferred();
  const app = await fullApp(t, {
    detail: { messages: [message("needle request")] },
    fetch: (url) => url.endsWith("/outcome") ? outcome.promise : undefined,
  });
  await search(app, "needle");
  count(app, "1 match");
  await enter(app);
  selected(app, "message-1");
  await app.settle(() => outcome.resolve({ found: true, content: "needle final" }));
  count(app, "2 matches");
  await enter(app);
  selected(app, "message-outcome");
  await enter(app, true);
  selected(app, "message-1");
});

test("an asynchronous outcome can turn zero matches into a reverse-navigable singleton", async (t) => {
  const outcome = deferred();
  const app = await fullApp(t, {
    fetch: (url) => url.endsWith("/outcome") ? outcome.promise : undefined,
  });
  await search(app, "needle");
  count(app, "0 matches");
  await enter(app, true);
  assert.deepEqual(app.scrolled, []);
  await app.settle(() => outcome.resolve({ found: true, content: "needle final" }));
  count(app, "1 match");
  await enter(app, true);
  selected(app, "message-outcome");
});

for (const reverse of [false, true]) {
  test(`refresh match shrink restarts an out-of-range cursor at the ${reverse ? "last" : "first"} match`, async (t) => {
    const reload = deferred();
    let attempts = 0;
    const app = await fullApp(t, {
      detail: { messages: Array.from({ length: reverse ? 4 : 5 }, (_, i) => message(`needle ${i}`)) },
      fetch: (url) => url.endsWith("/" + meta.file) && ++attempts > 1
        ? reload.promise : undefined,
    });
    await search(app, "needle");
    await enter(app, true);
    selected(app, reverse ? "message-4" : "message-5");
    await app.click("Refresh");
    await app.settle(() => reload.resolve({
      ...app.detail, messages: [message("needle remaining A"), message("needle remaining B")],
    }));
    count(app, "2 matches");
    assert.equal(app.document.querySelector(".rdv-message-search input").value, "needle");
    await enter(app, reverse);
    selected(app, reverse ? "message-2" : "message-1");
  });
}

test("refresh can remove the selected outcome and shrink matches to one then zero", async (t) => {
  const reloads = [deferred(), deferred()];
  let detailLoads = 0, outcomeLoads = 0;
  const app = await fullApp(t, {
    detail: { messages: [message("needle A"), message("needle B")] },
    fetch: (url) => {
      if (url.endsWith("/" + meta.file) && ++detailLoads > 1)
        return reloads[detailLoads - 2].promise;
      if (url.endsWith("/outcome"))
        return ++outcomeLoads === 1
          ? { found: true, content: "needle final" }
          : { found: false };
    },
  });
  await search(app, "needle");
  count(app, "3 matches");
  await enter(app, true);
  selected(app, "message-outcome");
  await app.click("Refresh");
  await app.settle(() => reloads[0].resolve({
    ...app.detail, messages: [message("needle remaining")],
  }));
  count(app, "1 match");
  assert.equal(app.document.getElementById("message-outcome"), null);
  await enter(app, true);
  selected(app, "message-1");
  await enter(app);
  selected(app, "message-1");
  await app.click("Refresh");
  await app.settle(() => reloads[1].resolve({
    ...app.detail, messages: [message("no remaining match")],
  }));
  count(app, "0 matches");
  const before = app.scrolled.length;
  await enter(app, true);
  await enter(app);
  assert.equal(app.scrolled.length, before);
});
