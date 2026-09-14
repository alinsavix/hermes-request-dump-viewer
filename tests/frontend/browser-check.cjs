// Optional real-Chrome verification. Requires playwright + esbuild, either
// locally installed or in the project named by RDV_BROWSER_MODULES. The normal
// npm suite needs only the repo's pinned React/jsdom dependencies.
// Run: RDV_BROWSER_MODULES=/path/to/tooling node tests/frontend/browser-check.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const tooling = process.env.RDV_BROWSER_MODULES
  ? createRequire(path.join(process.env.RDV_BROWSER_MODULES, "package.json"))
  : require;
const { chromium } = tooling("playwright");
const esbuild = tooling("esbuild");
const plugin = path.resolve(__dirname, "../..");
const reactBundle = esbuild.buildSync({
  stdin: {
    contents: `const React=require('react'); const {createRoot}=require('react-dom/client');
      window.__HERMES_PLUGIN_SDK__={React,fetchJSON:async(url,init)=>{
        const response=await fetch(url,init); if(!response.ok)throw new Error('HTTP '+response.status); return response.json();
      }};
      window.__HERMES_PLUGINS__={register:(_,Page)=>createRoot(document.getElementById('root')).render(React.createElement(Page))};`,
    resolveDir: plugin,
  },
  bundle: true,
  write: false,
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
}).outputFiles[0].text;
const bundle = fs.readFileSync(
  path.join(plugin, "dashboard/dist/index.js"),
  "utf8",
);
const style = fs.readFileSync(
  path.join(plugin, "dashboard/dist/style.css"),
  "utf8",
);
const meta = {
  file: "request_dump_after.json",
  session_id: "fixture",
  model: "synthetic",
  sequence: 2,
};
const envelope = 'ERROR: job failed\n{"ok":true}\nprocess exited 1';
const literalPath = String.raw`C:\new\test`;
const rawArguments = ' {"id":9007199254740993}\n';
const message = {
  role: "tool",
  name: "synthetic",
  content: {
    output: envelope,
    path: literalPath,
    id: "9007199254740993",
    literal: '{"nested":true}',
    items: [
      {
        name: { first: "Synthetic" },
        nested: [{ type: { role: ["arbitrary"] } }],
      },
    ],
  },
};
const detail = {
  meta,
  messages: [
    message,
    { role: "tool", name: "synthetic", content: rawArguments },
    {
      role: "assistant",
      tool_calls: [
        { id: "call", function: { name: "lookup", arguments: rawArguments } },
      ],
    },
  ],
  tools: [],
  analysis: {
    composition: {
      total_characters: 300,
      estimated_tokens: 75,
      parts: [
        { key: "instructions", label: "Instructions/system", characters: 100, estimated_tokens: 25, message_indices: [0] },
        { key: "history", label: "Conversation history", characters: 100, estimated_tokens: 25, message_indices: [1] },
        { key: "current_user", label: "Current user input", characters: 100, estimated_tokens: 25, message_indices: [2] },
      ],
    },
  },
  request: { body_options: {} },
};
const diff = {
  schema_version: 2,
  previous_file: "request_dump_before.json",
  summary: { unchanged: 0, modified: 0, moved: 1, added: 0, removed: 0 },
  timeline: [
    {
      kind: "move_source",
      id: "source",
      target_id: "dest",
      before_index: 0,
      after_index: 1,
    },
    {
      kind: "message",
      id: "dest",
      before_index: 0,
      after_index: 1,
      status: ["moved"],
      before: message,
      after: message,
    },
  ],
};
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors = [],
      requests = [];
    let listFailures = 2;
    let outcome = { found: false };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (value) => {
            window.copied.push(value);
          },
        },
      });
    });
    // All traffic is intercepted and synthetic. Never contact a dashboard or
    // permit capture/deletion writes, including accidental ones.
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });
      assert.equal(request.method(), "GET");
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body:
            "<!doctype html><html><head><style>body{margin:0;font:14px system-ui}code{background:#ffe6cb}" +
            style +
            '</style></head><body><div id="root"></div><script src="/react.js"></script><script src="/plugin.js"></script></body></html>',
        });
      if (url.pathname === "/react.js")
        return route.fulfill({
          contentType: "text/javascript",
          body: reactBundle,
        });
      if (url.pathname === "/plugin.js")
        return route.fulfill({ contentType: "text/javascript", body: bundle });
      let data;
      if (url.pathname.endsWith("/capture")) data = { enabled: false };
      else if (url.pathname.endsWith("/dumps"))
        if (listFailures > 0) {
          listFailures--;
          return route.fulfill({ status: 503, body: "synthetic list failure" });
        } else data = { items: [meta], dump_count: 2 };
      else if (url.pathname.endsWith("/timeline")) data = { items: [meta] };
      else if (url.pathname.endsWith("/outcome")) data = outcome;
      else if (url.pathname.endsWith("/diff")) data = diff;
      else if (url.pathname.endsWith(".json")) data = detail;
      else return route.abort();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
    await page.goto(
      "http://rdv-fixture.test/?dump=request_dump_after.json&tab=messages",
    );
    for (let i = 0; i < 2; i++) {
      await page.locator(".rdv-list-error").waitFor();
      assert.equal(await page.locator(".rdv-page").count(), 1);
      assert.ok(
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .isEnabled(),
      );
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    }
    await page.locator(".rdv-detail").waitFor();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    const body = await page.locator(".rdv-message-body").first().innerText();
    assert.ok(body.includes("Synthetic"), "F01 arbitrary nested labels render");
    assert.ok(body.includes(envelope), "F08 all diagnostic text survives");
    assert.ok(body.includes(literalPath), "R02 Windows paths remain literal");
    assert.ok(
      body.includes("9007199254740993"),
      "R02 numeric string remains literal",
    );
    assert.ok(
      body.includes('{"nested":true}'),
      "R02 nested JSON string stays a string",
    );
    assert.equal(
      await page.locator("#message-2 .rdv-scalar-text").textContent(),
      rawArguments,
    );
    if (!(await page.locator(".rdv-tool").evaluate((node) => node.open)))
      await page.locator(".rdv-tool > summary").click();
    await page
      .getByRole("button", { name: "Copy arguments", exact: true })
      .click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), rawArguments);
    await page.evaluate(() => {
      window.lastGoodMessage = document.getElementById("message-1");
    });
    listFailures = 2;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.locator(".rdv-list-error").waitFor();
      assert.equal(await page.locator(".rdv-list-item.active").count(), 1);
      assert.equal(
        await page.evaluate(
          () =>
            document.getElementById("message-1") === window.lastGoodMessage &&
            window.lastGoodMessage.open,
        ),
        true,
      );
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    }
    await page.locator(".rdv-list-error").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          document.getElementById("message-1") === window.lastGoodMessage &&
          window.lastGoodMessage.open,
      ),
      true,
    );
    await page
      .locator(".rdv-message-body")
      .first()
      .getByRole("button", { name: "Copy JSONPath", exact: true })
      .click();
    const jsonPath = await page.evaluate(() => window.copied.at(-1));
    assert.equal(jsonPath, "$.messages[0]");
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download redacted", exact: true })
      .click();
    const download = await downloadEvent;
    const downloaded = JSON.parse(
      fs.readFileSync(await download.path(), "utf8"),
    );
    assert.deepEqual(
      downloaded.messages[0],
      message,
      "F09 copied path resolves in the actual downloaded document",
    );
    assert.deepEqual(downloaded, detail);
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    const link = page.getByRole("link", { name: "Moved to #2" });
    await link.focus();
    await link.press("Enter");
    await page.locator("#diff-dest .rdv-diff-content").waitFor();
    assert.equal(
      await page.locator("#diff-dest").evaluate((el) => el.open),
      true,
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("#diff-dest > summary"),
      ),
      true,
      "F17 native Enter moves focus to the target summary",
    );
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    assert.ok(
      (await page.locator(".rdv-diff-content").innerText()).includes(envelope),
    );
    detail.messages = ["one", "two", "three"].map(word => ({ role: "user", content: "matchtarget " + word }));
    outcome = { found: true, content: "matchtarget final-outcome", source: "test" };
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("tab", { name: /^Messages/ }).click();
    await page.locator("#message-outcome").waitFor();
    await page.evaluate(() => {
      window.searchScrolls = [];
      const scroll = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = function (...args) {
        window.searchScrolls.push(this.id);
        return scroll.apply(this, args);
      };
    });
    const search = page.locator(".rdv-message-search input");
    await search.fill("matchtarget");
    assert.equal(await page.locator(".rdv-search-count").textContent(), "4 matches");
    await search.press("Shift+Enter");
    assert.equal(await page.evaluate(() => window.searchScrolls.at(-1)), "message-outcome");
    await search.press("Shift+Enter");
    assert.equal(await page.evaluate(() => window.searchScrolls.at(-1)), "message-3");
    await search.fill("final-outcome");
    assert.equal(await page.locator(".rdv-search-count").textContent(), "1 match");
    await search.press("Enter");
    assert.equal(await page.evaluate(() => window.searchScrolls.at(-1)), "message-outcome");
    assert.equal(await page.locator("#message-outcome").evaluate(n => n.open), true);
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    const cardNotes = page.locator(".rdv-composition-card > code");
    assert.equal(await cardNotes.count(), 3);
    assert.deepEqual(
      await cardNotes.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)),
      ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
      "Overview message references must not inherit the host's inverted code background",
    );
    detail.messages = ["role", "status", "phase"].map(key => ({
      role: "user", content: String.fromCharCode(0xd800) + " diagnostic",
      [key]: { nested: "<img src=x onerror=alert(1)>" },
    }));
    outcome = { found: false };
    await page.getByRole("tab", { name: /^Messages/ }).click();
    await search.fill("");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#message-1 .rdv-role")?.textContent.includes("nested"));
    await page.locator("#message-outcome").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    assert.equal(await page.locator(".rdv-message img").count(), 0);
    assert.equal(await page.locator(".rdv-message").count(), 3);
    const unicodeDownloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download redacted", exact: true }).click();
    const unicodeDownload = await unicodeDownloadEvent;
    const unicodeData = JSON.parse(fs.readFileSync(await unicodeDownload.path(), "utf8"));
    assert.deepEqual(unicodeData.messages, detail.messages);
    assert.equal(unicodeData.messages[0].content.charCodeAt(0), 0xd800);
    const prototypeData = JSON.parse('{"role":"assistant","content":"{}","__proto__":{"auditProtoMarker":"root-prototype"},"tool_calls":[{"id":"special","__proto__":{"auditProtoMarker":"call-prototype"},"function":{"name":"lookup","arguments":"{}","__proto__":{"auditProtoMarker":"function-prototype"}}}]}');
    diff.timeline = [{kind: "message", id: "prototype", before: prototypeData, after: prototypeData,
      before_index: 0, after_index: 0, status: ["modified"]}];
    await page.evaluate(() => {
      window.prototypeWrites = [];
      const original = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
      Object.defineProperty(Object.prototype, "__proto__", { ...original, set(value) {
        if (value && Object.hasOwn(value, "auditProtoMarker")) window.prototypeWrites.push(value.auditProtoMarker);
        original.set.call(this, value);
      }});
    });
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#diff-prototype").waitFor();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    const prototypeStrings = await page.locator("#diff-prototype .rdv-scalar-text").allTextContents();
    for (const marker of ["root-prototype", "call-prototype", "function-prototype"]) {
      assert.equal(prototypeStrings.filter(s => s === marker).length, 2);
    }
    assert.deepEqual(await page.evaluate(() => window.prototypeWrites), []);
    assert.equal(await page.evaluate(() => Object.prototype.auditProtoMarker), undefined);
    assert.deepEqual(errors, [], "no uncaught Chrome errors");
    assert.ok(requests.every((request) => request.method === "GET"));
    console.log(
      "Chrome PASS: R02 literal strings/paths, raw unsafe numbers and exact argument copy; R03 initial/repeated list failures and recovery preserve shell/detail; F01 nested JSON, F08 diagnostic text, F09 downloaded paths, F17 native keyboard focus; search counts/reverse navigation include outcomes; Overview card notes have transparent backgrounds; no page errors or API writes.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
