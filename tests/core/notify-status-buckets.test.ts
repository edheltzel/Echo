// Rate-limit bucketing for the two opt-in converse routes.
//
// The first version of this carve-out matched by prefix (`/notify/`), which also
// caught the pre-existing `POST /notify/personality` shim and quietly moved it
// off the shared notification bucket - doubling how many spoken lines a caller
// could queue in a minute. Completion polling and the reservation release also
// need buckets of their own: a turn spends several polls, and the release is the
// control that ends a daemon-wide speech hold.
process.env.PORT = "0";

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ECHO_AUDIO_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "notify-buckets-"));

const { server } = await import("../../core/server.ts");
const PORT = (server as any).port;

function client(tag: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-forwarded-for": tag };
}

/** Silent by design: this probe spends rate-limit budget, it does not speak. */
function postNotify(tag: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/notify`, {
    method: "POST",
    headers: client(tag),
    body: JSON.stringify({ message: "bucket probe", voice_enabled: false }),
  });
}

function getCompletion(tag: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/notify/absent-request/completion`, { headers: client(tag) });
}

function postRelease(tag: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/notify/absent-request/capture-release`, {
    method: "POST",
    headers: client(tag),
  });
}

async function exhaust(tag: string, request: (tag: string) => Promise<Response>): Promise<void> {
  for (let i = 0; i < 10; i++) await request(tag);
}

describe("converse status routes and the notification bucket", () => {
  test("the /notify/personality shim still shares the notification bucket", async () => {
    const tag = "buckets-personality";
    await exhaust(tag, postNotify);

    // Refused at the rate limiter, before the shim can queue anything.
    const shim = await fetch(`http://localhost:${PORT}/notify/personality`, {
      method: "POST",
      headers: client(tag),
      body: JSON.stringify({ message: "should never be queued" }),
    });

    expect(shim.status).toBe(429);
  });

  test("polling a request's completion does not consume the notification budget", async () => {
    const tag = "buckets-completion";
    await exhaust(tag, postNotify);
    expect((await postNotify(tag)).status).toBe(429);

    // 404 = the route answered; the unknown request id is the point.
    expect((await getCompletion(tag)).status).toBe(404);
  });

  // A turn spends up to five polls and then one release. Sharing one bucket let
  // the polls 429 the release, and a swallowed release means core holds back
  // every voice line for the rest of the lease.
  test("a release always has budget, whatever the polling cost", async () => {
    const tag = "buckets-release";
    await exhaust(tag, getCompletion);
    expect((await getCompletion(tag)).status).toBe(429);

    expect((await postRelease(tag)).status).toBe(404);
  });

  test("the notification bucket is untouched by a completion-poll flood", async () => {
    const tag = "buckets-flood";
    await exhaust(tag, getCompletion);
    expect((await getCompletion(tag)).status).toBe(429);

    expect((await postNotify(tag)).status).toBe(202);
  });
});
