import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAutomationSession } from "../../shared/echo-env.ts";
import { sendNotification, sendNotificationPayload } from "../../shared/notify-client.ts";
import type { TerminalNotificationContext } from "../../shared/terminal-notify.ts";

const originalFetch = globalThis.fetch;
const isolatedEnv = ["ECHO_CONFIG_FILE", "ECHO_AUTOMATION_ENV", "NO_MISTAKES_GATE", "CI_GATE", "ECHO_ENV_PATHS"] as const;
const originalEnv: Record<string, string | undefined> = {};
const scratch: string[] = [];

beforeEach(() => {
  for (const key of isolatedEnv) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  configFile({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of isolatedEnv) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
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
    globalThis.fetch = Object.assign(async () => {
      fetched = true;
      return new Response("nope", { status: 500 });
    }, { preconnect: originalFetch.preconnect });
    const result = await sendNotification(notifyConfig, "hello", "codex");
    expect(fetched).toBe(false);
    expect(result).toEqual({ ok: true, status: 0, body: "skipped", skipped: true });
  });

  test("a missing marker still sends", async () => {
    let fetched = false;
    globalThis.fetch = Object.assign(async () => {
      fetched = true;
      return new Response("accepted", { status: 202 });
    }, { preconnect: originalFetch.preconnect });
    const result = await sendNotification(notifyConfig, "hello", "codex", undefined, undefined, { env: {} });
    expect(fetched).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  test("an empty configured list disables silence", async () => {
    process.env.NO_MISTAKES_GATE = "1";
    configFile({ ECHO_AUTOMATION_ENV: "" });
    expect(isAutomationSession()).toBe(false);
    let fetched = false;
    globalThis.fetch = Object.assign(async () => {
      fetched = true;
      return new Response("accepted", { status: 202 });
    }, { preconnect: originalFetch.preconnect });
    await sendNotification(notifyConfig, "hello", "grok", undefined, undefined, { env: {} });
    expect(fetched).toBe(true);
  });

  for (const api of ["message", "payload"] as const) {
    for (const placement of ["config", "argument"] as const) {
      test.each([true, false])(`${api} releases the ${placement} writer with automation silence %s`, async (silenced) => {
        process.env.NO_MISTAKES_GATE = "1";
        if (!silenced) configFile({ ECHO_AUTOMATION_ENV: "" });
        const dir = mkdtempSync(join(tmpdir(), "echo-automation-writer-"));
        scratch.push(dir);
        const path = join(dir, "terminal-output");
        const fd = openSync(path, "w");
        let posts = 0;
        let banners = 0;
        globalThis.fetch = Object.assign(async () => {
          posts += 1;
          return new Response("accepted", { status: 202 });
        }, { preconnect: originalFetch.preconnect });
        const context: TerminalNotificationContext = {
          env: { TERM_PROGRAM: "Ghostty" },
          writer: {
            isTTY: true,
            write: (data) => { writeSync(fd, data); },
            close: () => closeSync(fd),
          },
          herdr: { show: async () => { banners += 1; return { shown: false }; } },
        };
        const config = { ...notifyConfig, visualContext: placement === "config" ? context : undefined };
        const argument = placement === "argument" ? context : undefined;
        try {
          const result = api === "message"
            ? await sendNotification(config, "hello", "pi", undefined, undefined, argument)
            : await sendNotificationPayload(config, { message: "hello", title: "Title", source: "omp" }, undefined, argument);
          expect(result.ok).toBe(true);
          expect(result.status).toBe(silenced ? 0 : 202);
          expect(posts).toBe(silenced ? 0 : 1);
          expect(banners).toBe(silenced ? 0 : 1);
          expect(readFileSync(path, "utf8").length > 0).toBe(!silenced);
          expect(() => fstatSync(fd)).toThrow();
        } finally {
          try { closeSync(fd); } catch {}
        }
      });
    }
  }

  test("a writer cleanup failure still reports a successful skip", async () => {
    process.env.NO_MISTAKES_GATE = "1";
    globalThis.fetch = Object.assign(async () => { throw new Error("must not POST"); }, { preconnect: originalFetch.preconnect });
    const result = await sendNotification(notifyConfig, "hello", "pi", undefined, undefined, {
      writer: {
        isTTY: true,
        write: () => { throw new Error("must not deliver a visual"); },
        close: () => { throw new Error("close failed"); },
      },
    });
    expect(result).toEqual({ ok: true, status: 0, body: "skipped", skipped: true });
  });

  test("a custom list matches either name and ignores blanks", () => {
    configFile({ ECHO_AUTOMATION_ENV: "CI_GATE, NO_MISTAKES_GATE, " });
    expect(isAutomationSession({ CI_GATE: "1" })).toBe(true);
    expect(isAutomationSession({ NO_MISTAKES_GATE: "1" })).toBe(true);
    expect(isAutomationSession({ NO_MISTAKES_GATE: "  " })).toBe(false);
    expect(isAutomationSession({})).toBe(false);
  });
});
