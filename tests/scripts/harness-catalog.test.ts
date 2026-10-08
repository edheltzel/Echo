import { describe, expect, test } from "bun:test";
import { HARNESS_IDS, HARNESSES, harnessUsageIds } from "../../shared/extension.ts";

async function runCatalog(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "scripts/harness-catalog.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("harness-catalog CLI", () => {
  test("usage prints the --adapter token list", async () => {
    const result = await runCatalog(["usage"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(harnessUsageIds());
  });

  test("ids lists every shipped harness", async () => {
    const result = await runCatalog(["ids"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([...HARNESS_IDS]);
  });

  test("list rows cover kind and features", async () => {
    const result = await runCatalog(["list"]);
    expect(result.exitCode).toBe(0);
    for (const harness of HARNESSES) {
      expect(result.stdout).toContain(`${harness.id}\t${harness.kind}\t${harness.displayName}`);
    }
  });

  test("features lists the mute CLI seam", async () => {
    const result = await runCatalog(["features"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mute\t@echo/shared/extension.ts\tregisterEchoMute\tcli/echo mute");
    expect(result.stdout).toContain("ask\t@echo/converse/host-tool.ts\tregisterEchoAskTool");
    expect(result.stdout).toContain("env\t@echo/shared/echo-env.ts\tloadEchoEnvironment");
  });

  test("unknown command exits 2", async () => {
    const result = await runCatalog(["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown command");
  });
});
