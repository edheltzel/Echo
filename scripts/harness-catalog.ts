#!/usr/bin/env bun

// Read-only view of shared/extension.ts. Install.sh does not call this (stub-bun
// tests still drive install without a real runtime). Agents and prove steps do.

import { FEATURES, HARNESSES, harnessUsageIds } from "../shared/extension.ts";

const command = process.argv[2] ?? "list";

if (command === "-h" || command === "--help") {
  console.log(`Usage: bun run scripts/harness-catalog.ts [list|usage|ids|features]
list       one row per shipped harness (default)
usage      none|<ids> string for --adapter
ids        harness ids only
features   feature register hooks`);
  process.exit(0);
}

if (command === "usage") {
  console.log(harnessUsageIds());
  process.exit(0);
}

if (command === "ids") {
  console.log(HARNESSES.map((harness) => harness.id).join("\n"));
  process.exit(0);
}

if (command === "features") {
  for (const feature of Object.values(FEATURES)) {
    const cli = "cli" in feature ? `\t${feature.cli}` : "";
    console.log(`${feature.id}\t${feature.module}\t${feature.register}${cli}`);
  }
  process.exit(0);
}

if (command !== "list") {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

for (const harness of HARNESSES) {
  const features = harness.features.join(",");
  const cli = harness.requiredCli ?? "-";
  console.log(`${harness.id}\t${harness.kind}\t${harness.displayName}\t${cli}\t${features}`);
}
