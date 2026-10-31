// ATL-ECHO-SNOOZE-DASH-01 - absolute mute helpers, DST, persistence, dashboard helpers.
process.env.TZ = "America/New_York";

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMuteUntilLocal, parseMuteUntil, readMuteState, resolveClockUntil, setMuteState, setMuteUntil } from "../../core/mute.ts";
import { isSameOriginWrite, readDashboardConfig } from "../../core/dashboard.ts";

const TMP = mkdtempSync(join(tmpdir(), "mute-until-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("resolveClockUntil", () => {
  test("later today stays today", () => {
    const now = new Date(2026, 9, 30, 10, 0);
    expect(resolveClockUntil("15:30", now)).toBe(new Date(2026, 9, 30, 15, 30).toISOString());
  });

  test("past time rolls to tomorrow (across midnight)", () => {
    const now = new Date(2026, 9, 30, 23, 50);
    expect(resolveClockUntil("00:10", now)).toBe(new Date(2026, 9, 31, 0, 10).toISOString());
  });

  test("equal to now rolls to tomorrow", () => {
    const now = new Date(2026, 9, 30, 9, 0);
    expect(resolveClockUntil("9:00", now)).toBe(new Date(2026, 9, 31, 9, 0).toISOString());
  });

  test("DST fall-back: 23:00 Oct 31 → 08:00 Nov 1 EST is 13:00Z (not 12:00Z)", () => {
    const now = new Date(2026, 9, 31, 23, 0);
    expect(resolveClockUntil("08:00", now)).toBe("2026-11-01T13:00:00.000Z");
  });

  test("DST spring-forward: 08:00 the day after is 12:00Z (EDT)", () => {
    const now = new Date(2026, 2, 7, 23, 0);
    expect(resolveClockUntil("08:00", now)).toBe("2026-03-08T12:00:00.000Z");
  });

  test("nonexistent wall time (02:30 on spring-forward day) is rejected", () => {
    const now = new Date(2026, 2, 8, 0, 30);
    expect(() => resolveClockUntil("02:30", now)).toThrow(/does not exist/);
  });

  test("garbage is rejected", () => {
    for (const bad of ["25:00", "12:60", "noon", "1530", ""]) {
      expect(() => resolveClockUntil(bad)).toThrow(/Invalid time/);
    }
  });
});

describe("parseMuteUntil", () => {
  test("future ISO normalizes to UTC", () => {
    expect(parseMuteUntil("2026-10-30T15:30:00-04:00", Date.parse("2026-10-30T12:00:00Z"))).toBe("2026-10-30T19:30:00.000Z");
  });
  test("past, garbage, non-string → Invalid", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(() => parseMuteUntil("2026-10-30T11:00:00Z", now)).toThrow(/future/);
    expect(() => parseMuteUntil("tomorrow", now)).toThrow(/Invalid/);
    expect(() => parseMuteUntil(42, now)).toThrow(/Invalid/);
  });
});

describe("persistence + expiry", () => {
  test("absolute mute survives a re-read (daemon restart) and expires to unmuted", () => {
    const p = join(TMP, "m1.json");
    const until = new Date(Date.now() + 60_000).toISOString();
    setMuteUntil(until, p);
    expect(readMuteState(p)).toEqual({ muted: true, muted_until: until, scope: "all" });
    writeFileSync(p, JSON.stringify({ muted: true, muted_until: new Date(Date.now() - 1).toISOString(), scope: "all" }));
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null, scope: "all" });
  });

  test("duration mute unchanged", () => {
    const p = join(TMP, "m2.json");
    const before = Date.now();
    const s = setMuteState(true, 30, p);
    expect(s.scope).toBe("all");
    expect(Date.parse(s.muted_until!) - before).toBeGreaterThanOrEqual(30 * 60_000);
    expect(Date.parse(s.muted_until!) - before).toBeLessThan(30 * 60_000 + 5_000);
  });
});

describe("formatMuteUntilLocal", () => {
  test("same day → time only; other day → weekday", () => {
    const now = new Date(2026, 9, 30, 10, 0);
    expect(formatMuteUntilLocal(new Date(2026, 9, 30, 15, 30).toISOString(), now)).toMatch(/^3:30\sPM$/);
    expect(formatMuteUntilLocal(new Date(2026, 9, 31, 9, 0).toISOString(), now)).toMatch(/^Sat 9:00\sAM$/);
    expect(formatMuteUntilLocal(null, now)).toBeNull();
  });
});

describe("dashboard helpers", () => {
  test("isSameOriginWrite", () => {
    expect(isSameOriginWrite(null, null, "3246")).toBe(true);
    expect(isSameOriginWrite("http://localhost:3246", null, "3246")).toBe(true);
    expect(isSameOriginWrite("http://127.0.0.1:3246", null, "3246")).toBe(true);
    expect(isSameOriginWrite("http://localhost:3000", null, "3246")).toBe(false);
    expect(isSameOriginWrite("null", null, "3246")).toBe(false);
    expect(isSameOriginWrite(null, "http://localhost:3246/", "3246")).toBe(true);
    expect(isSameOriginWrite(null, "https://evil.example/", "3246")).toBe(false);
  });

  test("readDashboardConfig redacts secret-looking keys", () => {
    const p = join(TMP, "config.json");
    writeFileSync(p, JSON.stringify({ port: 3246, elevenlabs_api_key: "sk-x", nested: { token: "t", voice: "v" } }));
    expect(readDashboardConfig(p).config).toEqual({ port: 3246, elevenlabs_api_key: "[redacted]", nested: { token: "[redacted]", voice: "v" } });
    expect(readDashboardConfig(join(TMP, "nope.json")).present).toBe(false);
  });
});

describe("dashboard page themes (mockups v3)", () => {
  const html = readFileSync(join(import.meta.dir, "../../core/dashboard.html"), "utf-8");
  test("ships all four palettes in light and dark", () => {
    for (const p of ["neutral", "hc", "slate", "amber"]) {
      for (const s of ["light", "dark"]) expect(html).toContain(`.${p}.${s}{`);
    }
  });
  test("Neutral is the default palette", () => {
    expect(html).toContain('if (["neutral", "hc", "slate", "amber"].indexOf(p) < 0) p = "neutral";');
  });
  test("no emoji in the page", () => {
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });
});
