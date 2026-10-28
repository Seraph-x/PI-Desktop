import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const refs = [["baseline", process.env.COMPARISON_BASE], ["fixed", process.env.COMPARISON_CANDIDATE]];
for (const [, ref] of refs) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? "")) throw new Error("Full immutable SHA required");
}
const artifacts = join(process.env.RUNNER_TEMP, "transcript-comparison-artifacts");
mkdirSync(artifacts, { recursive: true });
const summary = { node: process.version, image: process.env.ImageVersion, arms: [] };
const runnerPath = "scripts/e2e-transcript-turn-completion.mjs";
const fixturePath = "scripts/e2e/transcript-turn-completion.tsx";

function capture(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout;
}

function execute(label, command, args, cwd) {
  const log = join(artifacts, `${label}.log`);
  const fd = openSync(log, "w");
  let result;
  const startedAt = new Date().toISOString();
  try {
    result = spawnSync(command, args, { cwd, stdio: ["ignore", fd, fd], env: process.env });
  } finally {
    closeSync(fd);
  }
  const outcome = { label, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.message, log };
  console.log(JSON.stringify(outcome));
  return outcome;
}

function setup(label, command, args, cwd) {
  if (execute(label, command, args, cwd).exitCode !== 0) throw new Error(`Setup failed: ${label}`);
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Expected one diagnostic insertion: ${before}`);
  return source.replace(before, after);
}

try {
  for (const [name, ref] of refs) {
    const cwd = join(process.env.RUNNER_TEMP, `completion-${name}`);
    capture("git", ["worktree", "add", "--detach", cwd, ref]);
    const arm = { name, ref, runs: [] };
    summary.arms.push(arm);
    setup(`${name}-install`, "pnpm", ["install", "--frozen-lockfile"], cwd);
    setup(`${name}-electron`, "pnpm", ["--filter", "@pi-desktop/desktop", "exec", "install-electron"], cwd);
    const sandbox = join(cwd, "apps/desktop/node_modules/electron/dist/chrome-sandbox");
    setup(`${name}-sandbox-owner`, "sudo", ["chown", "root:root", sandbox], cwd);
    setup(`${name}-sandbox-mode`, "sudo", ["chmod", "4755", sandbox], cwd);
    setup(`${name}-build`, "pnpm", ["build:js"], cwd);
    const originalFixture = readFileSync(join(cwd, fixturePath), "utf8");
    const originalRunner = readFileSync(join(cwd, runnerPath), "utf8");
    arm.fixtureHash = createHash("sha256").update(originalFixture).digest("hex");
    arm.runnerHash = createHash("sha256").update(originalRunner).digest("hex");
    const instrumentedFixture = replaceOnce(originalFixture,
      "const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));",
      `let diagnosticFrames = 0;
let previousFrameAt = performance.now();
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => {
  const now = performance.now();
  const gapMs = now - previousFrameAt;
  previousFrameAt = now;
  diagnosticFrames++;
  if (diagnosticFrames <= 3 || diagnosticFrames % 10 === 0) {
    console.log("COMPLETION_FRAME_DIAGNOSTIC " + JSON.stringify({ frames: diagnosticFrames, gapMs, visibility: document.visibilityState }));
  }
  resolve();
}));`);
    writeFileSync(join(cwd, fixturePath), instrumentedFixture);
    writeFileSync(join(artifacts, `${name}-instrumented-fixture.tsx`), instrumentedFixture);
    for (const mode of ["hidden", "visible"]) {
      // The original 60-second deadline and all fixture assertions stay intact.
      const runner = mode === "visible"
        ? replaceOnce(originalRunner, "show: false,", "show: true,") : originalRunner;
      writeFileSync(join(cwd, runnerPath), runner);
      arm.runs.push(execute(`${name}-${mode}`, "xvfb-run", ["--auto-servernum", "sh", "-c",
        "openbox > /tmp/completion-openbox.log 2>&1 & exec node scripts/e2e-transcript-turn-completion.mjs"], cwd));
    }
    writeFileSync(join(cwd, fixturePath), originalFixture);
    writeFileSync(join(cwd, runnerPath), originalRunner);
    arm.finalSourceStatus = capture("git", ["status", "--short"], cwd).trim();
    if (arm.finalSourceStatus) throw new Error(`Source not restored: ${arm.finalSourceStatus}`);
  }
  // Hidden failures remain recorded; only the visible run is a functional check.
  if (summary.arms.some((arm) => arm.runs.find((run) => run.label.endsWith("-visible")).exitCode !== 0)) {
    process.exitCode = 1;
  }
} catch (error) {
  summary.setupError = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(artifacts, "completion-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Completion frame diagnostics\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`);
  }
}
