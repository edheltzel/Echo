// POST /mode + GET /health `mode`: the daemon end of `cli/echo mode`. The
// script tests stub this endpoint, so the real handler is proven here on the
// ephemeral PORT=0 singleton with its own scratch mode file.
process.env.PORT = "0";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// /notify fires an accept-time banner; never let a real osascript escape.
function stubSpawn(): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write() {}, end() {} },
    kill() {},
    pid: 4242,
  });
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: "default" in realChildProcess ? realChildProcess.default : realChildProcess,
  spawn: () => stubSpawn(),
}));

const TMP = mkdtempSync(join(tmpdir(), "mode-ep-"));
const MODE_PATH = join(TMP, "mode.json");
process.env.ECHO_MODE_STATE_PATH = MODE_PATH;
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

// Dynamic import on purpose: the daemon must load after the env paths above.
const { server } = await import("../../core/server.ts");
const PORT = server.port;

let bucket = 0;
let client = "";

beforeEach(() => {
  client = `mode-endpoint-test-${bucket++}`;
  if (existsSync(MODE_PATH)) rmSync(MODE_PATH);
});

afterAll(() => {
  // Never stop the shared singleton server (#47).
  rmSync(TMP, { recursive: true, force: true });
});

function post(path: string, body: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": client },
    body,
  });
}

async function healthMode(): Promise<unknown> {
  const res = await fetch(`http://localhost:${PORT}/health`, { headers: { "x-forwarded-for": client } });
  const body: unknown = await res.json();
  return typeof body === "object" && body !== null && "mode" in body ? body.mode : undefined;
}

describe("POST /mode", () => {
  test("sounds persists to the mode file and /health reports it", async () => {
    const res = await post("/mode", JSON.stringify({ mode: "sounds" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "sounds" });
    expect(JSON.parse(readFileSync(MODE_PATH, "utf-8"))).toEqual({ mode: "sounds" });
    expect(await healthMode()).toBe("sounds");

    await post("/mode", JSON.stringify({ mode: "speech" }));
    expect(await healthMode()).toBe("speech");
  });

  test("an unknown mode or malformed JSON is a 400 and leaves the mode unchanged", async () => {
    await post("/mode", JSON.stringify({ mode: "sounds" }));
    expect((await post("/mode", JSON.stringify({ mode: "loud" }))).status).toBe(400);
    expect((await post("/mode", "{not json")).status).toBe(400);
    expect((await post("/mode", JSON.stringify({}))).status).toBe(400);
    expect(await healthMode()).toBe("sounds");
  });

  test("a missing or malformed mode file reads as speech", async () => {
    expect(await healthMode()).toBe("speech");
    writeFileSync(MODE_PATH, "%%%corrupt%%%");
    expect(await healthMode()).toBe("speech");
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "loud" }));
    expect(await healthMode()).toBe("speech");
  });

  test("still answers after the caller's notify bucket is exhausted", async () => {
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const res = await post("/notify", JSON.stringify({ message: "flood", voice_enabled: false }));
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
    expect((await post("/mode", JSON.stringify({ mode: "sounds" }))).status).toBe(200);
  });
});
