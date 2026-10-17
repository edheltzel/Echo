// GET /health must not share the notification rate-limit bucket. A diagnostic
// burst (cli status/doctor/mute status/mode status) used to 429 /health and
// starve /notify, because both billed the shared localhost key (10/60s).
process.env.PORT = "0";

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ECHO_AUDIO_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "health-rl-"));

// Static import is hoisted above the PORT=0 pin, so the singleton would bind
// the operator port. Same import-order boundary as the other core endpoint tests.
const { server } = await import("../../core/server.ts");
if (typeof server !== "object" || server === null || !("port" in server) || typeof server.port !== "number") {
  throw new Error("test server did not expose a port");
}
const PORT = server.port;

describe("GET /health rate-limit isolation", () => {
  test("a loopback burst never 429s, and /notify still limits", async () => {
    const headers = {
      "Content-Type": "application/json",
      "x-forwarded-for": `health-rate-limit-${Date.now()}`,
    };

    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://localhost:${PORT}/health`, { headers });
      expect(res.status, `health ${i}`).toBe(200);
      await res.body?.cancel();
    }

    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://localhost:${PORT}/notify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "bucket probe", voice_enabled: false }),
      });
      expect(res.status, `notify ${i}`).toBe(202);
      await res.body?.cancel();
    }

    const limited = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "bucket probe", voice_enabled: false }),
    });
    expect(limited.status).toBe(429);
    await limited.body?.cancel();
  });
});
