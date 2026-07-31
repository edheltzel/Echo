import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOmpVoiceConfig } from "../../../adapters/omp/config";

describe("omp voice config — notify endpoint resolution", () => {
  test("defaults to the local daemon", () => {
    expect(loadOmpVoiceConfig({}).endpoint).toBe("http://localhost:3246/notify");
  });

  test("default adapter reads the endpoint from config.json", () => {
    const scratch = mkdtempSync(join(tmpdir(), "echo-omp-json-config-"));
    const configFile = join(scratch, "config.json");
    const previous = process.env.ECHO_CONFIG_FILE;
    try {
      writeFileSync(configFile, JSON.stringify({ ECHO_DAEMON_URL: "http://localhost:7788" }));
      process.env.ECHO_CONFIG_FILE = configFile;
      expect(loadOmpVoiceConfig().endpoint).toBe("http://localhost:7788/notify");
    } finally {
      if (previous === undefined) delete process.env.ECHO_CONFIG_FILE;
      else process.env.ECHO_CONFIG_FILE = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("honors ECHO_NOTIFY_URL and its legacy aliases verbatim", () => {
    expect(loadOmpVoiceConfig({ ECHO_NOTIFY_URL: "http://echo.example/notify" }).endpoint).toBe(
      "http://echo.example/notify",
    );
    expect(
      loadOmpVoiceConfig({ ATLAS_VOICE_NOTIFY_URL: "http://legacy.example/notify" }).endpoint,
    ).toBe("http://legacy.example/notify");
  });

  test("ECHO_DAEMON_URL retargets the notify endpoint, winning over ECHO_NOTIFY_URL", () => {
    expect(loadOmpVoiceConfig({ ECHO_DAEMON_URL: "http://localhost:8899" }).endpoint).toBe(
      "http://localhost:8899/notify",
    );
    expect(
      loadOmpVoiceConfig({
        ECHO_DAEMON_URL: "http://localhost:8899",
        ECHO_NOTIFY_URL: "http://echo.example/notify",
      }).endpoint,
    ).toBe("http://localhost:8899/notify");
  });
});
