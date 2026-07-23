#!/usr/bin/env node
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { cleanupWorkflowFixture } from "../src/workflow/fixture-cleanup.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { fake: false, real: false, keep: false, agent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fake") args.fake = true;
    else if (argv[i] === "--real") args.real = true;
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--agent") args.agent = argv[++i];
  }
  return args;
}

async function promptExactHarness(expected, { stdin, stdout }) {
  stdout.write(`Type the exact harness name to confirm: ${expected}\n> `);
  return new Promise((resolve) => {
    stdin.once("data", (data) => resolve(data.toString().trim()));
  });
}

async function runSmoke({ args, env, stdin, stdout, stderr }) {
  if (!args.fake && !args.real) {
    stderr.write("USAGE: smoke-workflow-fixture --fake --keep | --real --agent <pi|claude|codex|opencode> --keep\n");
    return { code: 1 };
  }

  const hasTty = env.WORKFLOW_SMOKE_TEST_TTY === "1" || (stdin.isTTY && stdout.isTTY);

  if (args.real) {
    if (!hasTty) {
      stderr.write("Real canaries require a TTY\n");
      return { code: 1 };
    }
    if (!args.keep) {
      stderr.write("Real canaries require --keep\n");
      return { code: 1 };
    }
    if (!args.agent) {
      stderr.write("Real canaries require --agent <harness>\n");
      return { code: 1 };
    }
    const allowed = new Set(["pi", "claude", "codex", "opencode"]);
    if (!allowed.has(args.agent)) {
      stderr.write(`Unknown harness: ${args.agent}\n`);
      return { code: 1 };
    }
    const confirmed = await promptExactHarness(args.agent, { stdin, stdout });
    if (confirmed !== args.agent) {
      stderr.write("Real canary was not confirmed\n");
      return { code: 1 };
    }
    stderr.write("Real canary mode is not yet implemented. Use --fake for fixture-only smoke.\n");
    return { code: 1 };
  }

  // Fake mode
  const fixture = await createWorkflowFixture({
    root: join(tmpdir(), `workflow-smoke-${Date.now()}`),
    packageRoot: new URL("..", import.meta.url).pathname,
  });

  stdout.write(`Fixture created: ${fixture.root}\n`);
  stdout.write(`Registry: ${fixture.registryPath}\n`);
  stdout.write(`State root: ${fixture.stateRoot}\n`);
  stdout.write(`Projects: ${Object.keys(fixture.projects).join(", ")}\n`);
  stdout.write(
    `WORKFLOW_PROJECTS_FILE=${fixture.registryPath} node ${fixture.packageRoot}/bin/workflow.js launch fixture-single FIX-101 --dry-run\n`,
  );

  if (!args.keep) {
    await cleanupWorkflowFixture(fixture, { confirm: async () => true });
  }

  return { code: 0 };
}

export function createSmokeRunner(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  return {
    async run() {
      const args = parseArgs(argv);
      return runSmoke({ args, env, stdin, stdout, stderr });
    },
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const runner = createSmokeRunner({ argv: args });
  const { code, error } = await runner.run();
  if (error) {
    console.error(error.message);
  }
  process.exit(code ?? (error ? 1 : 0));
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
