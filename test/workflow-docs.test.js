import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("README documents the workflow launcher commands and safety boundaries", async () => {
  const readme = await read("README.md");
  assert.match(readme, /workflow doctor ocr/);
  assert.match(readme, /workflow plan ocr ASANA-123 --feature "Discovered Docs"/);
  assert.match(readme, /workflow start ocr ASANA-123 --feature "Discovered Docs" --yes/);
  assert.match(readme, /workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request\.md --dry-run/);
  assert.match(readme, /workflow launch ocr ASANA-123 --agent claude-worker --prompt-file request\.md --dry-run/);
  assert.match(readme, /workflow launch ocr ASANA-123 --agent codex-worker --prompt-file request\.md --dry-run/);
  assert.match(readme, /workflow result <run-id>/);
  assert.match(readme, /workflow reconcile \[project\] --run <run-id>/);
  assert.doesNotMatch(readme, /^workflow resume <run-id>$/m);
  assert.doesNotMatch(readme, /^workflow close <run-id>$/m);
  assert.match(readme, /manual-handoff-required/);
  assert.match(readme, /result-stale/);
  assert.match(readme, /workflow handoff <run-id> --input <run-directory>\/handoff-input\.json/);
  assert.doesNotMatch(readme, /^workflow hooks doctor --format compact$/m);
  assert.match(readme, /workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes/);
  assert.match(readme, /workflow status ocr ASANA-123 --feature "Discovered Docs"/);
  assert.match(readme, /workflow plan acme ASANA-456 --feature Onboarding --repos backend,panel/);
  assert.match(readme, /read-only/i);
  assert.match(readme, /requires explicit confirmation or --yes/i);
  assert.match(readme, /does not submit an implementation prompt automatically/i);
  assert.match(readme, /separate explicit checkpoint/i);
  assert.match(readme, /profile selection precedence[\s\S]*explicit --agent[\s\S]*project default[\s\S]*global default/i);
  assert.match(readme, /bundle semantics[\s\S]*primary ticket[\s\S]*related tickets/i);
  assert.match(readme, /approval digest/i);
  assert.match(readme, /private state/i);
  assert.match(readme, /fallback terminal|fallback workspace|preserved workspace/i);
  assert.match(readme, /no-cleanup|no cleanup|does not clean up/i);
  assert.match(readme, /two-lane operator model/i);
  assert.match(readme, /one writer per checkout/i);
  assert.match(readme, /read-only foreground\/background fixtures|read-only foreground\/background/i);
  assert.match(readme, /exact recorded worker identity/i);
  assert.match(readme, /does not install or use `?pi-subagents`?|does not install `?pi-subagents`?/i);
});

test("README documents the workflow-owned Pi delegation adapter boundaries", async () => {
  const readme = await read("README.md");
  assert.match(readme, /workflow delegation result <run-id> <delegation-id>/i);
  assert.match(readme, /workflow delegation reconcile <run-id> <delegation-id>/i);
  assert.match(readme, /exact private session/i);
  assert.match(readme, /advisory internal (delegation )?result/i);
  assert.match(readme, /origin-session watcher|origin session watcher/i);
  assert.match(readme, /explicit adoption|explicitly adopt/i);
  assert.match(readme, /canonical external worker result/i);
  assert.match(readme, /no terminal scraping/i);
  assert.match(readme, /writer fixture gate|writer-background fixture gate|read-only and writer fixture gates/i);
  assert.match(readme, /no automatic cleanup, release, or kill|no automatic cleanup\/release\/kill/i);
  assert.match(readme, /package daemon,? or global Pi state|no daemon, package, or global Pi state/i);
  assert.match(readme, /does not install or use|not installed or used|neither installed nor a dependency/i);
});


test("package metadata exposes the workflow bin and packaged control-plane files", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.bin.workflow, "./bin/workflow.js");
  assert.match(pkg.description, /workflow/i);
  assert.ok(pkg.files.includes("bin"));
  assert.ok(pkg.files.includes("src"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes(".pi/agents"));
  assert.ok(pkg.files.includes(".pi/extensions"));
  assert.doesNotMatch(JSON.stringify(pkg), /pi-subagents/i);
});

test(".gitignore excludes generated Pi package state and none of it is tracked", async () => {
  const ignore = await read(".gitignore");
  assert.match(ignore, /^\.pi\/npm\/$/m);
  assert.match(ignore, /^\.pi\/sessions\/$/m);
  assert.match(ignore, /^\.pi-subagents\/$/m);

  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: repoRoot });
  assert.doesNotMatch(stdout, /(^|\n)\.pi\/npm(?:\/|$)/m);
  assert.doesNotMatch(stdout, /(^|\n)\.pi\/sessions(?:\/|$)/m);
  assert.doesNotMatch(stdout, /(^|\n)\.pi-subagents(?:\/|$)/m);
});

test("supervised lifecycle plan defers internal Pi delegation details to the adapter plan", async () => {
  const plan = await read("docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md");
  assert.match(plan, /2026-07-19-workflow-owned-pi-delegation-adapter\.md/);
  assert.match(plan, /Herdr-backed `WorkerTransport`|Herdr external transport/i);
  assert.match(plan, /exact external resume|exact live\/dead session resume/i);
  assert.match(plan, /explicit Codex trust checkpoint|manual Codex trust flow/i);
  assert.doesNotMatch(plan, /pi install\b/i);
  assert.doesNotMatch(plan, /\bpi list\b/i);
  assert.doesNotMatch(plan, /npm view pi-subagents|npm pack pi-subagents/i);
  assert.doesNotMatch(plan, /pi-subagents@0\.34\.0/i);
  assert.doesNotMatch(plan, /\.pi\/settings\.json/i);
  assert.doesNotMatch(plan, /\/subagents-doctor|\/subagents .*details/i);
  assert.match(plan, /Implementation status:[\s\S]*future plan[\s\S]*no .*CLI command is implemented/i);
});

test("fixture and canary plan keeps future-facing gates without Pi package smoke leftovers", async () => {
  const plan = await read("docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md");
  assert.match(plan, /artifact-level verification only/i);
  assert.match(plan, /Two-lane fixture gates run in this exact order:[\s\S]*read-only foreground and background delegation[\s\S]*one writer in a workflow-owned fixture worktree[\s\S]*separately approved real harness canaries/i);
  assert.match(plan, /read-only background fixture must prove[\s\S]*no terminal-derived result/i);
  assert.match(plan, /writer-background fixture must prove[\s\S]*one writer per checkout[\s\S]*no automatic cleanup before any real canary is considered/i);
  assert.match(plan, /Sequential real Pi\/Claude\/Codex canaries, each separately approved and preserved for inspection/i);
  assert.doesNotMatch(plan, /\bpi list\b/i);
  assert.doesNotMatch(plan, /pi install\b|npm view pi-subagents|npm pack pi-subagents|pi-subagents@/i);
});

test("AGENTS workflow stages include Plan between Design and Isolation", async () => {
  const agents = await read("AGENTS.md");
  assert.match(agents, /1\. \*\*Triage:\*\*[\s\S]*2\. \*\*Design:\*\*[\s\S]*3\. \*\*Plan:\*\*[\s\S]*4\. \*\*Isolation:\*\*/);
});

test("workflow prompts require plan approval, manual confirmation, and status-based recovery", async () => {
  const startPrompt = await read(".pi/prompts/start-feature.md");
  assert.match(startPrompt, /workflow plan/i);
  assert.match(startPrompt, /approved design/i);
  assert.match(startPrompt, /approved plan/i);
  assert.match(startPrompt, /request confirmation before running workflow start/i);
  assert.doesNotMatch(startPrompt, /workflow start .*--yes/i);

  const resumePrompt = await read(".pi/prompts/resume-feature.md");
  assert.match(resumePrompt, /workflow status/i);
  assert.match(resumePrompt, /recovery/i);
  assert.doesNotMatch(resumePrompt, /workflow (start|runtime) .*--yes/i);
});
