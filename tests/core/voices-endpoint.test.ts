// GET /voices — the read-only persona-key contract adapters use instead of
// reading core/voices.json off disk.
//
// The rate-limit tests here guard a regression that shipping this endpoint
// introduced: the Claude Code Stop hook makes ONE /voices read immediately
// before the /notify for that same turn. On the shared per-IP bucket that
// halved every host's notification budget (5 turns instead of 10) and let the
// read starve the write it precedes — a dropped notification. /voices gets its
// own bucket for the same reason /mute does (#83).
process.env.PORT = "0";

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ECHO_AUDIO_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "voices-ep-"));

const { server } = await import("../../core/server.ts");
const PORT = (server as any).port;

function client(tag: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-forwarded-for": tag };
}

function getVoices(tag: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/voices`, { headers: client(tag) });
}

function postNotify(tag: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/notify`, {
    method: "POST",
    headers: client(tag),
    body: JSON.stringify({ message: "bucket probe", voice_enabled: false }),
  });
}

describe("GET /voices", () => {
  test("reports sorted persona name keys and the default provider", async () => {
    const res = await getVoices("voices-shape");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);
    expect(body.agents).toEqual([...body.agents].sort());
    expect(typeof body.default_provider).toBe("string");
  });

  test("reports exactly the keys /notify resolves as voice_id", async () => {
    const config = JSON.parse(
      await Bun.file(process.env.VOICES_PATH ?? "core/voices.json").text(),
    );
    const body = await (await getVoices("voices-keys")).json();
    expect(body.agents).toEqual(Object.keys(config.agents ?? {}).sort());
  });
});

describe("GET /voices rate-limit isolation", () => {
  test("a per-turn /voices read does not consume the notification budget", async () => {
    // Ten turns, each a /voices read followed by the /notify it precedes.
    // On a shared bucket the 6th turn's notify would 429.
    const tag = "voices-budget";
    for (let turn = 0; turn < 10; turn++) {
      expect((await getVoices(tag)).status, `turn ${turn} /voices`).toBe(200);
      expect((await postNotify(tag)).status, `turn ${turn} /notify`).toBe(202);
    }
  });

  test("/notify is not starved by a /voices flood", async () => {
    const tag = "voices-flood";
    for (let i = 0; i < 10; i++) await getVoices(tag);
    expect((await getVoices(tag)).status).toBe(429); // its own bucket is exhausted…
    expect((await postNotify(tag)).status).toBe(202); // …and notify is untouched.
  });
});
