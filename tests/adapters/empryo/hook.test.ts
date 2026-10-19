import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEmpryoHookResult, type EmpryoHookPayload } from "../../../adapters/empryo/hook.ts";
import { loadEmpryoVoiceConfig, loadProjectPersona, type EmpryoVoiceConfig } from "../../../adapters/empryo/config.ts";
import { HilDedupe } from "../../../shared/hil.ts";
import { isEmpryoHookProcess } from "../../../shared/echo-env.ts";
import { handleCodexHookResult } from "../../../adapters/codex/hook.ts";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

const config: EmpryoVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Empryo Notification",
  personaName: "Empryo",
  voiceEnabled: true,
  greetOnSessionStart: true,
  speakCompletions: true,
  suppress: false,
  suppressChildTabs: true,
};

function record(value: object): string {
  return JSON.stringify(value);
}

function sessionLog(opts: { host?: string; tabId?: string; childTab?: boolean; answer?: string; answered?: boolean } = {}): string {
  const tabId = opts.tabId ?? "main";
  const lines = [
    record({ k: "meta", v: 1, id: "s1", host: opts.host ?? "desktop" }),
    record({ k: "tab", tabId, patch: { label: "Tab 1", openedByAgent: opts.childTab ?? false } }),
    record({ k: "user", tabId, turnId: "turn-2", ui: { role: "user", content: "Fix the bug." } }),
  ];
  if (opts.answered !== false) {
    lines.push(record({
      k: "assistant",
      tabId,
      turnId: "turn-2",
      ui: { role: "assistant", content: opts.answer ?? "The expiry check now uses less-than-or-equal." },
    }));
  }
  return `${lines.join("\n")}\n`;
}

function capture(): unknown[] {
  const payloads: unknown[] = [];
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202 });
  }, { preconnect: originalFetch.preconnect });
  return payloads;
}

function deps(log: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "echo-empryo-hil-"));
  dirs.push(dir);
  return {
    readFile: () => log,
    sleep: async () => {},
    dedupe: new HilDedupe({ persistDir: dir }),
    automation: false,
  };
}

const stop: EmpryoHookPayload = {
  hook_event_name: "Stop",
  session_id: "s1",
  transcript_path: "/proj/.empryo/sessions/s1/session.jsonl",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Empryo lifecycle hook adapter", () => {
  test("Stop speaks the finished turn from Empryo's session log as source empryo", async () => {
    const payloads = capture();
    expect(await handleEmpryoHookResult(stop, config, {}, deps(sessionLog()))).toBe("sent");
    expect(payloads).toEqual([expect.objectContaining({
      message: "The expiry check now uses less-than-or-equal.",
      title: "Empryo Notification",
      session_id: "s1",
      source: "empryo",
      slot: "done",
    })]);
  });

  test("Stop prefers an explicit voice line", async () => {
    const payloads = capture();
    const log = sessionLog({ answer: "Long report.\n\n🗣️ Empryo: Fix shipped and tests pass." });
    expect(await handleEmpryoHookResult(stop, config, {}, deps(log))).toBe("sent");
    expect((payloads[0] as { message: string }).message).toBe("Fix shipped and tests pass.");
  });

  test("Stop stays silent for a headless run", async () => {
    const payloads = capture();
    expect(await handleEmpryoHookResult(stop, config, {}, deps(sessionLog({ host: "headless" })))).toBe("skipped");
    expect(payloads).toEqual([]);
  });

  test("Stop stays silent until the newest prompt has an answer", async () => {
    const payloads = capture();
    expect(await handleEmpryoHookResult(stop, config, {}, deps(sessionLog({ answered: false })))).toBe("skipped");
    expect(payloads).toEqual([]);
  });

  test("a child tab is silent by default and speaks when ECHO_VOICE_SUPPRESS_CHILD_TABS=false", async () => {
    const payloads = capture();
    const log = sessionLog({ tabId: "t_child", childTab: true });
    expect(await handleEmpryoHookResult(stop, config, {}, deps(log))).toBe("skipped");
    const optedIn = loadEmpryoVoiceConfig({ ECHO_VOICE_SUPPRESS_CHILD_TABS: "false" });
    expect(optedIn.suppressChildTabs).toBe(false);
    expect(await handleEmpryoHookResult(stop, { ...config, suppressChildTabs: false }, {}, deps(log))).toBe("sent");
    expect(payloads).toHaveLength(1);
  });

  test("a tab the operator opened speaks", async () => {
    capture();
    const log = sessionLog({ tabId: "t_operator", childTab: false });
    expect(await handleEmpryoHookResult(stop, config, {}, deps(log))).toBe("sent");
  });

  test("SessionStart greets on desktop and tui, never headless or resume", async () => {
    const payloads = capture();
    for (const source of ["desktop", "tui", "headless", "resume", undefined]) {
      await handleEmpryoHookResult({ hook_event_name: "SessionStart", session_id: "s1", source }, config, {}, deps(null));
    }
    expect(payloads.map((p) => (p as { message: string }).message)).toEqual(["Empryo, ready.", "Empryo, ready."]);
    expect(payloads[0]).toEqual(expect.objectContaining({ source: "empryo" }));
  });

  test("Notification announces approvals, questions and plan reviews once", async () => {
    const payloads = capture();
    const d = deps(sessionLog());
    const note = (notification_type: string, message?: string): EmpryoHookPayload => ({
      hook_event_name: "Notification",
      session_id: "s1",
      transcript_path: stop.transcript_path,
      notification_type,
      message,
    });
    expect(await handleEmpryoHookResult(note("permission_prompt", "run git push"), config, {}, d)).toBe("sent");
    expect(await handleEmpryoHookResult(note("permission_prompt", "run git push"), config, {}, d)).toBe("skipped");
    expect(await handleEmpryoHookResult(note("elicitation_dialog", "Which branch?"), config, {}, d)).toBe("sent");
    expect(await handleEmpryoHookResult(note("plan_review"), config, {}, d)).toBe("sent");
    expect(await handleEmpryoHookResult(note("auth_success"), config, {}, d)).toBe("skipped");
    expect(payloads.map((p) => (p as { message: string }).message)).toEqual([
      "Empryo needs approval: run git push",
      "Which branch?",
      "Empryo needs approval: a plan to review",
    ]);
    expect(payloads.every((p) => (p as { slot: string; source: string }).slot === "request")).toBe(true);
  });

  test("automation sessions and ECHO_VOICE_SUPPRESS stay silent", async () => {
    const payloads = capture();
    expect(await handleEmpryoHookResult(stop, config, {}, { ...deps(sessionLog()), automation: true })).toBe("skipped");
    expect(await handleEmpryoHookResult(stop, { ...config, suppress: true }, {}, deps(sessionLog()))).toBe("skipped");
    const live = { ...deps(sessionLog()), automation: undefined };
    expect(await handleEmpryoHookResult(stop, config, { NO_MISTAKES_GATE: "1" }, live)).toBe("skipped");
    expect(payloads).toEqual([]);
  });
});

describe("Empryo persona", () => {
  test("project daidentity wins per key over global", () => {
    const files: Record<string, string> = {
      "/home/.empryo/settings.json": JSON.stringify({ daidentity: { name: "Atlas", voiceId: "atlas" } }),
      "/proj/.empryo/settings.json": JSON.stringify({ daidentity: { name: "Themis" } }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home")).toEqual({
      personaName: "Themis",
      voiceId: "atlas",
    });
    expect(loadProjectPersona("/elsewhere", () => null, "/home")).toBeNull();
  });
});

describe("other adapters under Empryo", () => {
  test("Empryo marks the hooks it runs; the Codex hook stands down", async () => {
    const payloads = capture();
    const env = { EMPRYO_PROJECT_DIR: "/proj" };
    expect(isEmpryoHookProcess(env)).toBe(true);
    expect(isEmpryoHookProcess({})).toBe(false);
    const codex = {
      endpoint: config.endpoint, title: "Codex Notification", personaName: "Codex",
      voiceEnabled: true, greetOnSessionStart: true, speakCompletions: true,
    };
    const payload = { hook_event_name: "Stop", last_assistant_message: "Codex finished the task." };
    expect(await handleCodexHookResult(payload, codex, env)).toBe("skipped");
    expect(await handleCodexHookResult(payload, codex, {})).toBe("sent");
    expect(payloads).toHaveLength(1);
  });
});
