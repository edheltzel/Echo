import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkConverseDependencies, type Which } from "../../converse/deps.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";

// F8: sox moved from optional fallback to hard dependency and nothing checked it.
// A machine without it installed cleanly, reported healthy, and only failed when
// somebody actually asked a question. install.sh and `echo doctor` now share one
// checker, so the two surfaces cannot disagree.

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-deps-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function config(overrides: Partial<ConverseConfig> = {}): ConverseConfig {
  return { ...resolveConverseConfig({}, scratch), ...overrides };
}

/**
 * Stand-in for PATH resolution. Absolute paths are checked on disk, mirroring the
 * real resolver, so a configured override is tested the way it actually behaves.
 */
const present = (bins: string[]): Which => (bin) => {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  return bins.includes(bin) ? `/usr/local/bin/${bin}` : null;
};

describe("the voice-ask dependency check", () => {
  test("a machine with sox and yap is ready", () => {
    const result = checkConverseDependencies(config(), present(["rec", "sox", "yap"]));

    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("a machine without sox is not ready, and is told to install it", () => {
    // The exact gap: yap alone looks like a working Tier 1 until an ask records.
    const result = checkConverseDependencies(config(), present(["yap"]));

    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toContain("brew install sox");
    expect(result.rows.find((row) => row.name === "recorder")?.found).toBe(false);
  });

  test("a machine with no transcriber at all names both rungs", () => {
    const result = checkConverseDependencies(config(), present(["rec", "sox"]));

    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toContain("tier 1");
    expect(result.missing.join(" ")).toContain("ECHO_CONVERSE_WHISPER_MODEL");
  });

  test("whisper counts as a transcriber only with a model file present", () => {
    const model = join(scratch, "ggml-base.en.bin");
    const withoutModel = checkConverseDependencies(
      config({ whisperModel: model }),
      present(["rec", "sox", "whisper-cli"]),
    );
    expect(withoutModel.ready).toBe(false);

    writeFileSync(model, "x");
    const withModel = checkConverseDependencies(
      config({ whisperModel: model }),
      present(["rec", "sox", "whisper-cli"]),
    );
    expect(withModel.ready).toBe(true);
  });

  test("the resampler is reported but does not block the yap tier", () => {
    // yap reads the native-rate recording directly; only whisper needs 16kHz.
    const result = checkConverseDependencies(config(), present(["rec", "yap"]));

    expect(result.ready).toBe(true);
    expect(result.rows.find((row) => row.name === "resampler")?.found).toBe(false);
  });

  test("configured binary overrides are what get checked", () => {
    const custom = join(scratch, "my-recorder");
    writeFileSync(custom, "#!/bin/bash\n");
    chmodSync(custom, 0o755);

    const result = checkConverseDependencies(config({ recBin: custom }), present(["yap"]));

    expect(result.rows.find((row) => row.name === "recorder")?.found).toBe(true);
    expect(result.ready).toBe(true);
  });
});

describe("the checker is wired into both operator surfaces", () => {
  const installScript = Bun.file("scripts/install.sh");
  const cli = Bun.file("cli/echo");

  test("install.sh reports it for every adapter that registers echo_ask", async () => {
    const script = await installScript.text();

    expect(script).toContain("converse/deps.ts");
    expect(script).toContain("Checking voice-ask dependencies");
    // Identical treatment across the three adapters that register the tool: a
    // user cannot reason about why one is stricter than another about the same
    // dependency.
    expect(script.match(/warn_converse_deps$/gm)?.length).toBe(3);
  });

  test("echo doctor reports a row for it", async () => {
    const text = await cli.text();

    expect(text).toContain("converse/deps.ts");
    expect(text).toContain('"voice ask"');
  });

  test("running it directly exits 3 when something required is missing", async () => {
    // The machine-checkable contract install.sh depends on.
    const missing = join(scratch, "absent");
    const result = Bun.spawnSync(["bun", resolve("converse/deps.ts")], {
      env: { ...process.env, ECHO_CONVERSE_REC_BIN: missing, ECHO_CONVERSE_YAP_BIN: missing, ECHO_CONVERSE_WHISPER_BIN: missing },
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("brew install sox");
  });

  test("running it directly exits 0 on a ready machine", async () => {
    const stub = join(scratch, "stub");
    writeFileSync(stub, "#!/bin/bash\n");
    chmodSync(stub, 0o755);
    const result = Bun.spawnSync(["bun", resolve("converse/deps.ts")], {
      env: { ...process.env, ECHO_CONVERSE_REC_BIN: stub, ECHO_CONVERSE_SOX_BIN: stub, ECHO_CONVERSE_YAP_BIN: stub },
    });

    expect(result.exitCode).toBe(0);
  });
});
