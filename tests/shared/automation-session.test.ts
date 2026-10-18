import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAutomationSession } from "../../shared/echo-env.ts";
import { sendNotification } from "../../shared/notify-client.ts";

const originalFetch = globalThis.fetch;
const originalConfigFile = process.env.ECHO_CONFIG_FILE;
const scratch: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NO_MISTAKES_GATE;
  delete process.env.CI_GATE;
  if (originalConfigFile === undefined) delete process.env.ECHO_CONFIG_FILE;
  else process.env.ECHO_CONFIG_FILE = originalConfigFile;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(body: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "echo-automation-"));
  scratch.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body));
  process.env.ECHO_CONFIG_FILE = path;
}

const notifyConfig = {
  endpoint: "http://echo.test/notify",
  title: "Title",
  voiceEnabled: true,
};

describe("automation session silence", () => {
  test("default marker skips the POST and reports success", async () => {
    process.env.NO_MISTAKES_GATE = "1";
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("nope", { status: 500 });
    };
    const result = await sendNotification(notifyConfig, "hello", "codex");
    expect(fetched).toBe(false);
    expect(result).toEqual({ ok: true, status: 0, body: "skipped", skipped: true });
  });

  test("a missing marker still sends", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("accepted", { status: 202 });
    };
    const result = await sendNotification(notifyConfig, "hello", "codex");
    expect(fetched).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  test("an empty configured list disables silence", async () => {
    process.env.NO_MISTAKES_GATE = "1";
    configFile({ ECHO_AUTOMATION_ENV: "" });
    expect(isAutomationSession()).toBe(false);
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("accepted", { status: 202 });
    };
    await sendNotification(notifyConfig, "hello", "grok");
    expect(fetched).toBe(true);
  });

  test("a custom list matches either name and ignores blanks", () => {
    configFile({ ECHO_AUTOMATION_ENV: "CI_GATE, NO_MISTAKES_GATE, " });
    expect(isAutomationSession({ CI_GATE: "1" })).toBe(true);
    expect(isAutomationSession({ NO_MISTAKES_GATE: "1" })).toBe(true);
    expect(isAutomationSession({ NO_MISTAKES_GATE: "  " })).toBe(false);
    expect(isAutomationSession({})).toBe(false);
  });
});
