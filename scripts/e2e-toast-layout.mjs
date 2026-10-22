#!/usr/bin/env node
/** Isolated production React/CSS geometry regression for issue #1820. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-toast-layout-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/toast-layout.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const styles = await Promise.all(["tokens.css", "base.css", "chat-shell.css", "work-panel.css", "ui-kit.css", "overlays.css"]
    .map((name) => readFile(join(root, "apps/desktop/src/styles", name), "utf8")));
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
<style>${styles.join("\n")}html,body,#root{margin:0;width:100%;height:100%}.toast{animation:none}</style>
<div id="root"></div><script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1250, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("globalThis.toastLayoutProbe()");
    console.log("TOAST_LAYOUT_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("TOAST_LAYOUT_PROBE " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
    app.exit(1);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((item) => item.startsWith("TOAST_LAYOUT_PROBE "));
  assert(line, `No probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("TOAST_LAYOUT_PROBE ".length));
  console.log("TOAST_LAYOUT_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, result.error ?? output.slice(-4000));
  assert.equal(result.ok, true, result.error);
} finally { await rm(temp, { recursive: true, force: true }); }
