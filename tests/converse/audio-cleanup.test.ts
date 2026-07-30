import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureAndTranscribe } from "../../converse/capture.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";

// F7: a failed resample left recorded speech on disk. The red team ran the real
// whisper path with a fake sox that wrote the converted WAV and exited 7:
//
//   {"error":"resampling for whisper exited 7","converted_exists":true,"converted_bytes":64}
//
// The converted path was returned only on success, so when the resample failed
// nothing downstream knew the file's name and the outer cleanup could not remove
// it. The same probe showed the recorder's own WAV inheriting mode 644 from the
// umask, so a private directory was the only thing protecting the audio.

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-cleanup-"));
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

/** A recorder that writes a WAV with permissive bits, as a real one does under a loose umask. */
function fakeRecorder(): string {
  return fakeBinary(
    "fake-rec",
    `out=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n` +
      `head -c 8192 /dev/zero > "$out"\nchmod 644 "$out"`,
  );
}

function whisperConfig(soxBody: string): ConverseConfig {
  return config({
    recBin: fakeRecorder(),
    soxBin: fakeBinary("fake-sox", soxBody),
    whisperBin: fakeBinary("fake-whisper", 'echo "transcribed"'),
    whisperModel: "/models/ggml-base.en.bin",
    sttTier: "whisper",
  });
}

describe("audio artifacts are removed on every path", () => {
  test("a resample that writes its output and then fails leaves nothing behind", async () => {
    // The reviewer's exact reproduction: the converted file exists when sox exits 7.
    const cfg = whisperConfig('out="${!#}"\nhead -c 64 /dev/zero > "$out"\necho resample-failed >&2\nexit 7');

    await expect(captureAndTranscribe(cfg)).rejects.toThrow(/exited 7/);

    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("a resample killed at its cap leaves nothing behind", async () => {
    const cfg = whisperConfig('out="${!#}"\nhead -c 64 /dev/zero > "$out"\nsleep 30');

    await expect(captureAndTranscribe({ ...cfg, transcribeTimeoutMs: 300 })).rejects.toThrow();

    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("a failing transcriber leaves neither the recording nor the converted copy", async () => {
    const cfg = whisperConfig('out="${!#}"\nhead -c 64 /dev/zero > "$out"');
    const failing = { ...cfg, whisperBin: fakeBinary("fake-whisper", "exit 4") };

    await expect(captureAndTranscribe(failing)).rejects.toThrow(/exited 4/);

    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("a successful whisper turn leaves nothing behind either", async () => {
    const cfg = whisperConfig('out="${!#}"\nhead -c 64 /dev/zero > "$out"');

    const result = await captureAndTranscribe(cfg);

    expect(result.text).toBe("transcribed");
    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });
});

describe("recorded audio is private regardless of the recorder", () => {
  test("the recording is owner-only even when the recorder created it permissively", async () => {
    // Captured speech must not be readable by other local users just because the
    // recorder ran under a loose umask.
    let observedMode: number | undefined;
    const cfg = config({
      recBin: fakeRecorder(),
      yapBin: fakeBinary("fake-yap", "echo heard"),
    });
    const wrapped: ConverseConfig = {
      ...cfg,
      yapBin: fakeBinary(
        "fake-yap-probe",
        `stat -f %Lp "\${!#}" > ${join(scratch, "mode.txt")} 2>/dev/null || stat -c %a "\${!#}" > ${join(scratch, "mode.txt")}\necho heard`,
      ),
    };

    await captureAndTranscribe(wrapped);
    observedMode = Number.parseInt((await Bun.file(join(scratch, "mode.txt")).text()).trim(), 8);

    expect(observedMode).toBe(0o600);
  });

  test("a pre-existing world-readable capture directory is tightened", async () => {
    const captureDir = join(scratch, "captures");
    mkdirSync(captureDir, { recursive: true, mode: 0o755 });
    chmodSync(captureDir, 0o755);
    const cfg = config({ recBin: fakeRecorder(), yapBin: fakeBinary("fake-yap", "echo heard") });

    await captureAndTranscribe(cfg);

    expect(statSync(captureDir).mode & 0o777).toBe(0o700);
  });
});
