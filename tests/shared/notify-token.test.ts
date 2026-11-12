import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureNotifyToken,
  isAuthorizedNotify,
  notifyAuthHeaders,
  notifyTokenPath,
  readNotifyToken,
} from "../../shared/notify-token.ts";

function scratchEnv() {
  const dir = mkdtempSync(join(tmpdir(), "notify-token-"));
  return { ECHO_CONFIG_FILE: join(dir, "echo", "config.json") };
}

describe("notify token file", () => {
  test("lives beside config.json", () => {
    const env = scratchEnv();
    expect(notifyTokenPath(env)).toBe(join(env.ECHO_CONFIG_FILE, "..", "notify-token"));
  });

  test("is created once with mode 0600 and reused", () => {
    const env = scratchEnv();
    expect(readNotifyToken(env)).toBeUndefined();
    const token = ensureNotifyToken(env);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(notifyTokenPath(env)).mode & 0o777).toBe(0o600);
    expect(readFileSync(notifyTokenPath(env), "utf-8").trim()).toBe(token);
    expect(ensureNotifyToken(env)).toBe(token);
    expect(notifyAuthHeaders(env)).toEqual({ Authorization: `Bearer ${token}` });
  });

  test("ECHO_NOTIFY_TOKEN overrides the file and creates nothing", () => {
    const env = { ...scratchEnv(), ECHO_NOTIFY_TOKEN: "override" };
    expect(ensureNotifyToken(env)).toBe("override");
    expect(() => statSync(notifyTokenPath(env))).toThrow();
  });

  test("only the exact bearer value authorizes", () => {
    expect(isAuthorizedNotify("Bearer abc", "abc")).toBe(true);
    expect(isAuthorizedNotify("Bearer abd", "abc")).toBe(false);
    expect(isAuthorizedNotify("Bearer abcd", "abc")).toBe(false);
    expect(isAuthorizedNotify("abc", "abc")).toBe(false);
    expect(isAuthorizedNotify(null, "abc")).toBe(false);
  });
});
