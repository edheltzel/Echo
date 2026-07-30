import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureError, captureAndTranscribe } from "../../converse/capture.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";

// F3: cancellation was not terminal. The red team aborted a capture after the
// recorder had written a valid WAV and still got a transcript back:
//
//   {"aborted":true,"result":"cancelled-but-transcribed"}
//
// A signal was treated as "kill the child", not as "this turn produces no
// result", so a caller who asked to stop could still have their speech
// transcribed and returned. That is an API correctness bug and a privacy one.
//
// Cancellation is checked at every boundary: before recording, after recording,
// before transcription, and after transcription. Whichever boundary the abort
// lands on, the turn produces no value and leaves no audio behind.

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-cancel-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function config(overrides: Partial<ConverseConfig> = {}): ConverseConfig {
  return {
    ...resolveConverseConfig({}, scratch),
    captureDir: join(scratch, "captures"),
    maxCaptureMs: 3_000,
    ...overrides,
  };
}

function fakeBinary(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A recorder that writes a valid WAV immediately, then lingers. */
function lingeringRecorder(lingerSeconds = 5): string {
  return fakeBinary(
    "fake-rec",
    `out=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n` +
      `head -c 8192 /dev/zero > "$out"\n` +
      `echo ready > ${join(scratch, "recorder-ready")}\n` +
      `sleep ${lingerSeconds}`,
  );
}

const transcriber = () => fakeBinary("fake-yap", 'echo "the words I asked you to forget"');

async function waitForRecorder(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await Bun.file(join(scratch, "recorder-ready")).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("the fake recorder never signalled readiness");
}

describe("cancellation is terminal", () => {
  test("an abort after a valid recording exists returns no transcript", async () => {
    // The reviewer's exact race: the WAV is on disk and readable, so the old
    // code transcribed it and returned the text despite the abort.
    const controller = new AbortController();
    const cfg = config({ recBin: lingeringRecorder(), yapBin: transcriber() });

    const capture = captureAndTranscribe(cfg, controller.signal);
    await waitForRecorder();
    controller.abort();

    const outcome = await capture.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error) => ({ kind: "rejected" as const, error }),
    );

    expect(outcome.kind, "a cancelled capture must not resolve with a transcript").toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.error).toBeInstanceOf(CaptureError);
    expect((outcome.error as CaptureError).code).toBe("cancelled");
  });

  test("a cancelled capture leaves no audio on disk", async () => {
    const controller = new AbortController();
    const cfg = config({ recBin: lingeringRecorder(), yapBin: transcriber() });

    const capture = captureAndTranscribe(cfg, controller.signal);
    await waitForRecorder();
    controller.abort();
    await capture.catch(() => {});

    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("an abort before the recorder starts never records at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = join(scratch, "recorder-started");
    const cfg = config({
      recBin: fakeBinary("fake-rec", `touch ${started}\nout=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\nhead -c 8192 /dev/zero > "$out"`),
      yapBin: transcriber(),
    });

    await expect(captureAndTranscribe(cfg, controller.signal)).rejects.toThrow(/cancel/i);

    expect(await Bun.file(started).exists()).toBe(false);
  });

  test("an abort during transcription discards the transcript", async () => {
    // The recorder finishes cleanly; the abort lands while the transcriber runs.
    const controller = new AbortController();
    const cfg = config({
      recBin: fakeBinary(
        "fake-rec",
        `out=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\nhead -c 8192 /dev/zero > "$out"`,
      ),
      yapBin: fakeBinary(
        "fake-yap",
        `echo ready > ${join(scratch, "recorder-ready")}\nsleep 5\necho "late transcript"`,
      ),
    });

    const capture = captureAndTranscribe(cfg, controller.signal);
    await waitForRecorder();
    controller.abort();

    await expect(capture).rejects.toThrow(/cancel/i);
    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("an uncancelled capture still returns its transcript", async () => {
    // The guard must not make every capture look cancelled.
    const cfg = config({
      recBin: fakeBinary(
        "fake-rec",
        `out=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\nhead -c 8192 /dev/zero > "$out"`,
      ),
      yapBin: fakeBinary("fake-yap", 'echo "yes, ship it"'),
    });

    const result = await captureAndTranscribe(cfg, new AbortController().signal);

    expect(result.text).toBe("yes, ship it");
  });
});
