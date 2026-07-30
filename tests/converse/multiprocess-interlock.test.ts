import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptureState } from "../../core/capture-guard.ts";
import { resolveConverseConfig } from "../../converse/config.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

let scratch: string;
let handle: ConverseServerHandle | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-process-race-"));
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(message);
}

describe("cross-process capture ownership", () => {
  test("two host processes race through one atomic booking and one core reservation", async () => {
    const bookingLockPath = join(scratch, "booking.lock");
    const captureStatePath = join(scratch, "capture-state.json");
    const startGate = join(scratch, "start");
    const releaseGate = join(scratch, "release");
    const captureDir = join(scratch, "captures");
    const results = [join(scratch, "caller-a.json"), join(scratch, "caller-b.json")];
    const notifyReservations: string[] = [];
    const coreCalls: string[] = [];
    let requestId = "";

    const health: CoreHealthSnapshot = {
      mute: { muted: false, muted_until: null },
      capture_guard: { path: captureStatePath, state: "idle" },
      play_queue: { depth: 0, in_flight_ms: null, stalled: false },
    };
    const config = {
      ...resolveConverseConfig({}, scratch),
      bookingLockPath,
      coreBaseUrl: "http://isolated-core.test",
    };
    handle = createConverseServer({
      config,
      port: 0,
      sleep: async () => {},
      fetchImpl: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        coreCalls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/health") return new Response(JSON.stringify(health), { status: 200 });
        if (path === "/notify") {
          const body = JSON.parse(String(init?.body)) as {
            capture_reservation: { reservation_id: string };
          };
          notifyReservations.push(body.capture_reservation.reservation_id);
          requestId = `race-request-${notifyReservations.length}`;
          return new Response(JSON.stringify({ status: "accepted", request_id: requestId }), { status: 202 });
        }
        if (path === `/notify/${requestId}/completion`) {
          return new Response(JSON.stringify({
            request_id: requestId,
            state: "completed",
            capture_reservation_id: notifyReservations[0],
          }), { status: 200 });
        }
        if (path.endsWith(`/capture-reservations/${notifyReservations[0]}/grant`)) {
          return new Response(JSON.stringify({
            granted: true,
            reservation_id: notifyReservations[0],
            request_id: requestId,
            expires_at: new Date(Date.now() + 120_000).toISOString(),
          }), { status: 200 });
        }
        if (path.endsWith(`/capture-reservations/${notifyReservations[0]}/release`)) {
          return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
        }
        throw new Error(`unexpected isolated core request: ${path}`);
      },
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const fixture = join(import.meta.dir, "fixtures", "race-caller.ts");
    const children = results.map((resultPath) => Bun.spawn(
      ["bun", fixture, baseUrl, bookingLockPath, captureDir, startGate, releaseGate, resultPath],
      { stdout: "pipe", stderr: "pipe" },
    ));

    writeFileSync(startGate, "go");
    await waitUntil(
      () => results.some((path) => existsSync(`${path}.capturing`)) && results.some((path) => existsSync(path)),
      "one process never entered capture while the loser reported its refusal",
    );

    expect(results.filter((path) => existsSync(`${path}.capturing`))).toHaveLength(1);
    expect(readCaptureState(captureStatePath, () => true)).toBe("recording");
    expect(notifyReservations).toHaveLength(1);
    expect(coreCalls.filter((call) => call.endsWith("/grant"))).toHaveLength(1);

    writeFileSync(releaseGate, "finish");
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual([0, 0]);

    const outcomes = results.map((path) => JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; code?: string });
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.code === "microphone_busy")).toHaveLength(1);
    expect(readCaptureState(captureStatePath, () => true)).toBe("idle");
  }, 15_000);
});
