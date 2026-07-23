#!/usr/bin/env node
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { cleanupWorkflowFixture } from "../src/workflow/fixture-cleanup.js";

function parseArgs(argv) {
  const args = { fake: false, real: false, keep: false, agent: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fake") args.fake = true;
    else if (argv[i] === "--real") args.real = true;
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--agent") args.agent = argv[++i];
  }
  return args;
}

async function promptExactHarness(expected) {
  process.stdout.write(`Type the exact harness name to confirm: ${expected}\n> `);
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => resolve(data.toString().trim()));
  });
}

async function main(argv) {
  const args = parseArgs(argv);

  if (!args.fake && !args.real) {
    console.error("USAGE: smoke-workflow-fixture --fake --keep | --real --agent <pi|claude|codex|opencode> --keep");
    process.exit(1);
  }

  const hasTty = process.env.WORKFLOW_SMOKE_TEST_TTY === "1" || (process.stdin.isTTY && process.stdout.isTTY);

  if (args.real) {
    if (!hasTty) {
      console.error("Real canaries require a TTY");
      process.exit(1);
    }
    if (!args.keep) {
      console.error("Real canaries require --keep");
      process.exit(1);
    }
    if (!args.agent) {
      console.error("Real canaries require --agent <harness>");
      process.exit(1);
    }
    const allowed = new Set(["pi", "claude", "codex", "opencode"]);
    if (!allowed.has(args.agent)) {
      console.error(`Unknown harness: ${args.agent}`);
      process.exit(1);
    }
    const confirmed = await promptExactHarness(args.agent);
    if (confirmed !== args.agent) {
      console.error("Real canary was not confirmed");
      process.exit(1);
    }
    console.error("Real canary mode is not yet implemented. Use --fake for fixture-only smoke.");
    process.exit(1);
  }

  // Fake mode
  const fixture = await createWorkflowFixture({
    root: `/tmp/workflow-smoke-${Date.now()}`,
    packageRoot: new URL("..", import.meta.url).pathname,
  });

  console.log("Fixture created:", fixture.root);
  console.log("Registry:", fixture.registryPath);
  console.log("State root:", fixture.stateRoot);
  console.log("Projects:", Object.keys(fixture.projects).join(", "));
  console.log(
    `WORKFLOW_PROJECTS_FILE=${fixture.registryPath} node ${fixture.packageRoot}/bin/workflow.js launch fixture-single FIX-101 --dry-run`,
  );

  if (!args.keep) {
    await cleanupWorkflowFixture(fixture, { confirm: async () => true });
  }
}

main(process.argv).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
