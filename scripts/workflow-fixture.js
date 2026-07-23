#!/usr/bin/env node
import { createWorkflowFixture, loadFixtureDescriptor } from "../src/workflow/fixture.js";
import { cleanupWorkflowFixture } from "../src/workflow/fixture-cleanup.js";

function usage() {
  console.error("USAGE: workflow-fixture create|inspect|remove <root>");
  process.exit(1);
}

async function main(argv) {
  const command = argv[2];
  const root = argv[3];
  if (!command || !root) usage();

  if (command === "create") {
    const fixture = await createWorkflowFixture({ root, packageRoot: new URL("..", import.meta.url).pathname });
    console.log("Fixture root:", fixture.root);
    console.log("Registry:", fixture.registryPath);
    console.log("State root:", fixture.stateRoot);
    console.log("Projects:", Object.keys(fixture.projects).join(", "));
    console.log(
      `WORKFLOW_PROJECTS_FILE=${fixture.registryPath} node ${fixture.packageRoot}/bin/workflow.js launch fixture-single FIX-101 --dry-run`,
    );
    return;
  }

  if (command === "inspect") {
    const fixture = await loadFixtureDescriptor(root);
    console.log(JSON.stringify(fixture, null, 2));
    return;
  }

  if (command === "remove") {
    const fixture = await loadFixtureDescriptor(root);
    await cleanupWorkflowFixture(fixture, {
      confirm: async () => {
        console.error(`Remove ${fixture.root}? Pass --keep to preserve, or use rm -rf manually.`);
        return false;
      },
    });
    return;
  }

  usage();
}

main(process.argv).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
