process.env.PORT = "0";

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_AUTH } from "./notify-auth.ts";

process.env.ECHO_AUDIO_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "notify-auth-"));

const { server } = await import("../../core/server.ts");
const PORT = server.port;

function postNotify(path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `notify-auth-${crypto.randomUUID()}`, ...headers },
    body: JSON.stringify({ message: "auth probe", voice_enabled: false }),
  });
}

describe("POST /notify bearer token", () => {
  test("binds to 127.0.0.1 by default", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  for (const path of ["/notify", "/notify/personality"]) {
    test(`${path} without a token is 401 with no body`, async () => {
      const res = await postNotify(path, {});
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    test(`${path} with a wrong token is 401 with no body`, async () => {
      const res = await postNotify(path, { Authorization: "Bearer not-the-token" });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  }

  test("/notify with the right token keeps the existing 202 response", async () => {
    const res = await postNotify("/notify", NOTIFY_AUTH);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(typeof body.request_id).toBe("string");
  });
});
