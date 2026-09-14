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
const message = {
  role: "tool",
  name: "synthetic",
  content: {
    output: envelope,
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
  messages: [message],
  tools: [],
  analysis: {},
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
            "<!doctype html><html><head><style>body{margin:0;font:14px system-ui}" +
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
        data = { items: [meta], dump_count: 2 };
      else if (url.pathname.endsWith("/timeline")) data = { items: [meta] };
      else if (url.pathname.endsWith("/outcome")) data = { found: false };
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
    await page.locator(".rdv-detail").waitFor();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    const body = await page.locator(".rdv-message-body").innerText();
    assert.ok(body.includes("Synthetic"), "F01 arbitrary nested labels render");
    assert.ok(body.includes(envelope), "F08 all diagnostic text survives");
    await page
      .locator(".rdv-message-body")
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
    assert.deepEqual(errors, [], "no uncaught Chrome errors");
    assert.ok(requests.every((request) => request.method === "GET"));
    console.log(
      "Chrome PASS: F01 nested JSON, F08 diagnostic text, F09 downloaded paths, F17 native keyboard focus; no page errors or API writes.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
