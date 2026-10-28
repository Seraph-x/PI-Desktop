import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = process.cwd();
const base = process.env.COMPARISON_BASE;
const candidate = process.env.COMPARISON_CANDIDATE;
for (const ref of [base, candidate]) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? "")) throw new Error("Comparison requires full immutable commit SHAs");
}
const artifacts = join(process.env.RUNNER_TEMP, "transcript-comparison-artifacts");
mkdirSync(artifacts, { recursive: true });
const results = { base, candidate, node: process.version, image: process.env.ImageVersion, arms: [] };

function capture(command, args, cwd = repository) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
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
  const outcome = execute(label, command, args, cwd);
  if (outcome.exitCode !== 0) throw new Error(`Setup failed: ${label}; inspect ${outcome.log}`);
}

const disclosurePath = "scripts/e2e/transcript-disclosure-anchor.tsx";
const ownershipPath = "scripts/e2e/scroll-input-ownership.ts";
const originalDisclosure = capture("git", ["show", `${base}:${disclosurePath}`]);
const addedDisclosure = capture("git", ["show", `${candidate}:${disclosurePath}`]);
const addedOwnership = capture("git", ["show", `${candidate}:${ownershipPath}`]);
const originalRender = capture("git", ["show", `${base}:scripts/e2e/transcript-long-history.tsx`]);
const candidateRender = capture("git", ["show", `${candidate}:scripts/e2e/transcript-long-history.tsx`]);
if (originalRender !== candidateRender) throw new Error("The original long-history probes differ");
results.originalProbeHash = createHash("sha256").update(originalRender).digest("hex");

try {
  for (const [name, ref] of [["baseline", base], ["fixed", candidate]]) {
    const cwd = resolve(process.env.RUNNER_TEMP, `transcript-comparison-${name}`);
    capture("git", ["worktree", "add", "--detach", cwd, ref]);
    const arm = { name, ref, tree: capture("git", ["rev-parse", `${ref}^{tree}`]).trim(), runs: [] };
    results.arms.push(arm);
    setup(`${name}-install`, "pnpm", ["install", "--frozen-lockfile"], cwd);
    setup(`${name}-electron`, "pnpm", ["--filter", "@pi-desktop/desktop", "exec", "install-electron"], cwd);
    const sandbox = join(cwd, "apps/desktop/node_modules/electron/dist/chrome-sandbox");
    setup(`${name}-sandbox-owner`, "sudo", ["chown", "root:root", sandbox], cwd);
    setup(`${name}-sandbox-mode`, "sudo", ["chmod", "4755", sandbox], cwd);
    setup(`${name}-build`, "pnpm", ["build:js"], cwd);
    arm.electron = JSON.parse(readFileSync(join(cwd, "apps/desktop/node_modules/electron/package.json"))).version;
    // Both arms run the identical original target step. Only this fixture is
    // replaced, and every real product module remains at its fixed revision.
    writeFileSync(join(cwd, disclosurePath), originalDisclosure);
    for (let repeat = 1; repeat <= 3; repeat++) {
      arm.runs.push(execute(`${name}-original-${repeat}`, "xvfb-run", ["--auto-servernum", "sh", "-c",
        "node scripts/e2e-transcript-render.mjs && node scripts/e2e-transcript-disclosure-anchor.mjs"], cwd));
    }
    // The very same added regression must expose the baseline defect and pass
    // on the fixed arm; a build/import crash never counts as reproducing it.
    writeFileSync(join(cwd, disclosurePath), addedDisclosure);
    writeFileSync(join(cwd, ownershipPath), addedOwnership);
    arm.regression = execute(`${name}-added-regression`, "xvfb-run", ["--auto-servernum", "node",
      "scripts/e2e-transcript-disclosure-anchor.mjs"], cwd);
    const regressionLog = readFileSync(arm.regression.log, "utf8");
    arm.knownRegressionDetected = arm.regression.exitCode !== 0 &&
      /a pending (?:nested )?navigation moved the manually toggled disclosure title|interrupted (?:nested )?navigation moved the reader|button Space cancelled transcript navigation/.test(regressionLog);
    arm.completion = execute(`${name}-completion`, "xvfb-run", ["--auto-servernum", "node",
      "scripts/e2e-transcript-turn-completion.mjs"], cwd);
    writeFileSync(join(cwd, disclosurePath), capture("git", ["show", `${ref}:${disclosurePath}`]));
    if (name === "baseline") rmSync(join(cwd, ownershipPath));
    arm.finalSourceStatus = capture("git", ["status", "--short"], cwd).trim();
    if (arm.finalSourceStatus) throw new Error(`Source did not restore cleanly: ${arm.finalSourceStatus}`);
  }
  const [baseline, fixed] = results.arms;
  results.expectationsMet = baseline.knownRegressionDetected && fixed.regression.exitCode === 0 &&
    results.arms.every((arm) => arm.completion.exitCode === 0);
  results.originalFailures = results.arms.flatMap((arm) => arm.runs.filter((run) => run.exitCode !== 0).map((run) => run.label));
  if (!results.expectationsMet || results.originalFailures.length) process.exitCode = 1;
} catch (error) {
  results.setupError = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(artifacts, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Fixed-head transcript comparison\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
  }
}
