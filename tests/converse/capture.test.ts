import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureError,
  captureAndTranscribe,
  preflightCapture,
  recordReply,
  recorderArgv,
  selectSttTier,
  transcribeFile,
} from "../../converse/capture.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";

// No test here opens a microphone. The recorder and the transcriber are both
// subprocesses, so a stand-in script exercises the real argv handling, exit
// codes and empty-output paths on any machine - including CI, which runs Linux
// with none of rec, sox or yap installed. The one test that drives the actual
// Tier 1 transcriber is guarded on it being present and says so in its name.

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-capture-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function config(overrides: Partial<ConverseConfig> = {}): ConverseConfig {
  return {
    ...resolveConverseConfig({}, scratch),
    captureDir: join(scratch, "captures"),
    maxCaptureMs: 2_000,
    ...overrides,
  };
}

/** A stand-in binary. Bash is the one interpreter present on every target here. */
function fakeBinary(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A recorder that writes `bytes` of audio-shaped data and exits. */
function fakeRecorder(bytes: number, extra = ""): string {
  return fakeBinary(
    "fake-rec",
    `out=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n` +
      `head -c ${bytes} /dev/zero > "$out"\n${extra}`,
  );
}

describe("recorder invocation", () => {
  test("endpoints on trailing silence at the configured length", () => {
    const argv = recorderArgv(config({ silenceMs: 2_500 }), "/out/reply.wav");

    expect(argv).toContain("silence");
    expect(argv.join(" ")).toContain("silence 1 0.1 2% 1 2.50 2%");
    expect(argv).toContain("/out/reply.wav");
  });

  test("does not coerce the sample rate during capture", () => {
    // VoiceLayer's lesson: resampling inside the streaming path overruns on
    // devices at unusual rates. The whisper rung converts offline instead.
    expect(recorderArgv(config(), "/out/reply.wav")).not.toContain("-r");
  });
});

describe("recording", () => {
  test("reports the captured size and duration", async () => {
    const report = await recordReply(config({ recBin: fakeRecorder(4_096) }), join(scratch, "reply.wav"));

    expect(report.bytes).toBe(4_096);
    expect(report.timed_out).toBe(false);
    expect(report.capture_ms).toBeGreaterThanOrEqual(0);
    expect(existsSync(report.wav_path)).toBe(true);
  });

  test("a recorder that produces no file is a failure, not silence", async () => {
    const recBin = fakeBinary("fake-rec", 'echo "no such device" >&2\nexit 1');

    await expect(recordReply(config({ recBin }), join(scratch, "reply.wav"))).rejects.toThrow(
      /produced no audio/,
    );
  });

  test("a recorder that never returns is stopped at the cap", async () => {
    const recBin = fakeRecorder(2_048, "sleep 30");

    const report = await recordReply(config({ recBin, maxCaptureMs: 300 }), join(scratch, "reply.wav"));

    expect(report.timed_out).toBe(true);
    expect(report.bytes).toBe(2_048);
  });

  test("forces recorded audio files to owner-only permissions", async () => {
    const recBin = fakeBinary(
      "mode-loose-rec",
      'umask 000\nout=""\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\nhead -c 4096 /dev/zero > "$out"',
    );
    const wav = join(scratch, "private.wav");

    const report = await recordReply(config({ recBin }), wav);

    expect(statSync(report.wav_path).mode & 0o777).toBe(0o600);
  });
});

describe("transcriber selection", () => {
  const present = (bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/local/bin/${bin}` : null);

  test("prefers Tier 1 yap when it is installed", () => {
    expect(selectSttTier(config(), present(["yap", "whisper-cli"]))).toBe("yap");
  });

  test("falls back to whisper when yap is absent and a model is configured", () => {
    const cfg = config({ whisperModel: "/models/ggml-base.en.bin" });
    expect(selectSttTier(cfg, present(["whisper-cli"]))).toBe("whisper");
  });

  test("reports no tier when whisper is installed without a model", () => {
    expect(selectSttTier(config(), present(["whisper-cli"]))).toBeNull();
  });

  test("reports no tier when neither transcriber is installed", () => {
    expect(selectSttTier(config(), present([]))).toBeNull();
  });

  test("an explicitly chosen tier is never silently swapped for the other", () => {
    const cfg = config({ sttTier: "whisper", whisperModel: "/models/ggml-base.en.bin" });
    expect(selectSttTier(cfg, present(["yap"]))).toBeNull();
  });
});

// The installer only warns about a missing recorder, so "registered, no sox" is a
// state a turn has to survive. This check is what the caller runs BEFORE the
// question is spoken, so the human is never asked something nothing can record.
describe("capture preflight", () => {
  const present = (bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/local/bin/${bin}` : null);

  test("names the recorder and the fix when sox is missing", () => {
    const failure = (() => {
      try {
        preflightCapture(config(), present(["yap"]));
      } catch (error) {
        return error as CaptureError;
      }
    })();

    expect(failure?.code).toBe("no_recorder");
    expect(failure?.message).toContain("rec is not available");
    expect(failure?.message).toContain("brew install sox");
    expect(failure?.message).toContain("ECHO_CONVERSE_REC_BIN");
  });

  test("reports a missing transcriber separately from a missing recorder", () => {
    const failure = (() => {
      try {
        preflightCapture(config(), present(["rec"]));
      } catch (error) {
        return error as CaptureError;
      }
    })();

    expect(failure?.code).toBe("no_stt_tier");
    expect(failure?.message).toContain("ECHO_CONVERSE_WHISPER_MODEL");
  });

  test("returns the tier the capture will use, so check and choice cannot disagree", () => {
    expect(preflightCapture(config(), present(["rec", "yap"]))).toBe("yap");
    const cfg = config({ whisperModel: "/models/ggml-base.en.bin" });
    expect(preflightCapture(cfg, present(["rec", "whisper-cli"]))).toBe("whisper");
  });

  test("honors an executable override outside PATH", () => {
    const cfg = config({ recBin: fakeRecorder(0), yapBin: fakeBinary("fake-yap", "exit 0") });

    // Nothing on PATH, and it still passes: the overrides are what will be spawned.
    expect(preflightCapture(cfg, (bin) => (existsSync(bin) ? bin : null))).toBe("yap");
  });
});

describe("transcription", () => {
  test("returns the raw transcript with no polish pass", async () => {
    const yapBin = fakeBinary("fake-yap", 'echo "  ship the dev branch  "');

    const text = await transcribeFile(config({ yapBin }), join(scratch, "reply.wav"), "yap");

    expect(text).toBe("ship the dev branch");
  });

  test("passes the configured locale to the transcriber", async () => {
    const argvLog = join(scratch, "argv.txt");
    const yapBin = fakeBinary("fake-yap", `echo "$@" > ${argvLog}\necho ok`);

    await transcribeFile(config({ yapBin, locale: "en-GB" }), join(scratch, "reply.wav"), "yap");

    expect(await Bun.file(argvLog).text()).toContain("transcribe --locale en-GB --txt");
  });

  test("a failing transcriber is reported, not read as an empty answer", async () => {
    const yapBin = fakeBinary("fake-yap", 'echo "model unavailable" >&2\nexit 3');

    await expect(transcribeFile(config({ yapBin }), join(scratch, "reply.wav"), "yap")).rejects.toThrow(
      /exited 3/,
    );
  });

  test("the whisper rung resamples offline and cleans up the converted file", async () => {
    const soxLog = join(scratch, "sox-argv.txt");
    const soxBin = fakeBinary("fake-sox", `echo "$@" > ${soxLog}\nout="\${!#}"\nhead -c 64 /dev/zero > "$out"`);
    const whisperBin = fakeBinary("fake-whisper", 'echo "ship it"');
    const cfg = config({ soxBin, whisperBin, whisperModel: "/models/ggml-base.en.bin" });
    const wav = join(scratch, "reply.wav");
    writeFileSync(wav, "x".repeat(2_048));

    const text = await transcribeFile(cfg, wav, "whisper");

    expect(text).toBe("ship it");
    expect(await Bun.file(soxLog).text()).toContain("-r 16000 -c 1 -b 16");
    expect(existsSync(join(scratch, "reply.16k.wav"))).toBe(false);
  });

  test("cleans the converted whisper input when sox fails after creating it", async () => {
    const soxBin = fakeBinary("failing-sox", 'out="${!#}"\nhead -c 64 /dev/zero > "$out"\nexit 7');
    const whisperBin = fakeBinary("unused-whisper", 'echo "must not run"');
    const cfg = config({ soxBin, whisperBin, whisperModel: "/models/ggml-base.en.bin" });
    const wav = join(scratch, "failed-resample.wav");
    writeFileSync(wav, "x".repeat(2_048));

    await expect(transcribeFile(cfg, wav, "whisper")).rejects.toThrow(/resampling.*exited 7/);
    expect(existsSync(join(scratch, "failed-resample.16k.wav"))).toBe(false);
  });

  test("whisper without a configured model reports the missing model", async () => {
    const cfg = config({ whisperModel: undefined });

    await expect(transcribeFile(cfg, join(scratch, "reply.wav"), "whisper")).rejects.toThrow(
      /ECHO_CONVERSE_WHISPER_MODEL/,
    );
  });
});

describe("capture and transcribe together", () => {
  test("returns the transcript and leaves no recording on disk", async () => {
    const cfg = config({
      recBin: fakeRecorder(8_192),
      yapBin: fakeBinary("fake-yap", 'echo "merge it into dev"'),
    });

    const result = await captureAndTranscribe(cfg);

    expect(result.text).toBe("merge it into dev");
    expect(result.engine).toBe("yap");
    // The human's voice is not left lying around; the transcript is the product.
    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("a header-only recording is reported as no speech", async () => {
    // 44 bytes is exactly what sox writes when the endpointer heard nothing:
    // measured on macOS 26.5.2 with the real recorder.
    const cfg = config({
      recBin: fakeRecorder(44),
      yapBin: fakeBinary("fake-yap", "echo should-not-run"),
    });

    await expect(captureAndTranscribe(cfg)).rejects.toThrow(CaptureError);
    await expect(captureAndTranscribe(cfg)).rejects.toThrow(/no speech/);
  });

  test("an empty transcript is reported as no speech", async () => {
    const cfg = config({ recBin: fakeRecorder(8_192), yapBin: fakeBinary("fake-yap", "true") });

    await expect(captureAndTranscribe(cfg)).rejects.toThrow(/no speech/);
  });

  test("the recording is deleted even when transcription fails", async () => {
    const cfg = config({
      recBin: fakeRecorder(8_192),
      yapBin: fakeBinary("fake-yap", "exit 4"),
    });

    await expect(captureAndTranscribe(cfg)).rejects.toThrow(/exited 4/);
    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  test("an abort during transcription discards the transcript and recording", async () => {
    const marker = join(scratch, "transcriber-started");
    const cfg = config({
      recBin: fakeRecorder(8_192),
      yapBin: fakeBinary("fake-yap", `touch ${marker}\nsleep 2\necho "must be discarded"`),
    });
    const controller = new AbortController();
    const pending = captureAndTranscribe(cfg, controller.signal).catch((error: CaptureError) => error);

    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await Bun.sleep(10);
    controller.abort();

    const failure = await pending;
    expect(failure).toBeInstanceOf(CaptureError);
    expect((failure as CaptureError).code).toBe("cancelled");
    expect(readdirSync(cfg.captureDir)).toEqual([]);
  });

  // Splitting the plan's Tier 1 row made sox a Tier 1 dependency, so the machine
  // the plan pictured - macOS 26 with yap installed and nothing else - is exactly
  // the one that hits this. It must name the fix, not raise ENOENT mid-turn.
  test("a missing recorder names the package that provides it", async () => {
    const cfg = config({
      recBin: join(scratch, "absent-rec"),
      yapBin: fakeBinary("fake-yap", 'echo "never reached"'),
    });

    const failure = await captureAndTranscribe(cfg).catch((error: CaptureError) => error);

    expect(failure).toBeInstanceOf(CaptureError);
    expect((failure as CaptureError).code).toBe("no_recorder");
    expect((failure as CaptureError).message).toContain("brew install sox");
    expect((failure as CaptureError).message).not.toContain("ENOENT");
  });

  // The recorder was fine here; the resampler was missing. Reporting that as
  // `no_recorder` would send the operator after the wrong half of the pipeline.
  test("the whisper rung reports a missing sox as a transcriber failure", async () => {
    const cfg = config({
      recBin: fakeRecorder(8_192),
      soxBin: join(scratch, "absent-sox"),
      whisperBin: fakeBinary("fake-whisper", 'echo "unused"'),
      whisperModel: "/models/ggml-base.en.bin",
      sttTier: "whisper",
    });

    const failure = await captureAndTranscribe(cfg).catch((error: CaptureError) => error);

    expect(failure).toBeInstanceOf(CaptureError);
    expect((failure as CaptureError).code).toBe("transcriber_failed");
    expect((failure as CaptureError).message).toContain("brew install sox");
  });

  // A transcriber that never exits holds the capture state, and core skips every
  // voice line while that state is non-idle: an unbounded hang mutes Echo for as
  // long as the calling host lives.
  test("a hung transcriber is stopped at the cap and named as a timeout", async () => {
    const cfg = config({
      yapBin: fakeBinary("fake-yap", "sleep 30"),
      transcribeTimeoutMs: 250,
    });

    const failure = await transcribeFile(cfg, join(scratch, "reply.wav"), "yap").catch(
      (error: CaptureError) => error,
    );

    expect(failure).toBeInstanceOf(CaptureError);
    expect((failure as CaptureError).code).toBe("transcriber_failed");
    expect((failure as CaptureError).message).toContain("did not finish within 250ms");
  });

  // The cap is only a real bound if it survives a child that ignores SIGTERM.
  // The recorder cannot be killed this way (sox must catch the signal to
  // finalize its WAV header), but a transcriber has no header to lose.
  test("a transcriber that ignores SIGTERM is killed anyway", async () => {
    const cfg = config({
      yapBin: fakeBinary("fake-yap", "trap '' TERM\nsleep 5"),
      transcribeTimeoutMs: 250,
    });

    const failure = await transcribeFile(cfg, join(scratch, "reply.wav"), "yap").catch(
      (error: CaptureError) => error,
    );

    expect((failure as CaptureError).code).toBe("transcriber_failed");
    expect((failure as CaptureError).message).toContain("did not finish within 250ms");
  }, 15_000);

  // One budget for the whole phase, not one per step: the turn's lease is
  // calculated from a single transcription cap, so a whisper tier that spent the
  // cap on resampling and then the cap again on transcribing would outlive it.
  test("the whisper tier shares one budget across resampling and transcribing", async () => {
    const soxBin = fakeBinary("fake-sox", 'sleep 0.8\nout="${!#}"\nhead -c 64 /dev/zero > "$out"');
    const whisperBin = fakeBinary("fake-whisper", 'sleep 0.8\necho "too late"');
    const wav = join(scratch, "reply.wav");
    writeFileSync(wav, "x".repeat(2_048));
    const cfg = config({ soxBin, whisperBin, whisperModel: "/models/ggml-base.en.bin", transcribeTimeoutMs: 1_000 });

    const failure = await transcribeFile(cfg, wav, "whisper").catch((error: CaptureError) => error);

    expect((failure as CaptureError).code).toBe("transcriber_failed");
    expect((failure as CaptureError).message).toContain("did not finish within 1000ms");
    expect(existsSync(join(scratch, "reply.16k.wav"))).toBe(false);
  }, 15_000);

  // Waiting for exit before reading deadlocks on a full pipe: the child blocks
  // writing, so it can only exit once somebody drains it.
  test("a transcript larger than the pipe buffer is read in full", async () => {
    const yapBin = fakeBinary("fake-yap", "head -c 400000 /dev/zero | tr '\\0' 'a'");
    const cfg = config({ yapBin, transcribeTimeoutMs: 5_000 });

    const text = await transcribeFile(cfg, join(scratch, "reply.wav"), "yap");

    expect(text.length).toBe(400_000);
  });

  test("with no local transcriber available the failure names both rungs", async () => {
    const cfg = config({
      recBin: fakeRecorder(8_192),
      yapBin: join(scratch, "absent-yap"),
      whisperBin: join(scratch, "absent-whisper"),
    });

    await expect(captureAndTranscribe(cfg)).rejects.toThrow(/no local transcriber available/);
  });
});

// The rung that actually ships on macOS 26. Guarded rather than faked, because
// what it proves is that the real binary answers this exact argv; CI runs Linux
// without yap, where the fake-binary tests above carry the coverage.
const yapPath = Bun.which("yap");
const sayPath = Bun.which("say");
const soxPath = Bun.which("sox");
const canDriveRealYap = yapPath !== null && sayPath !== null && soxPath !== null;

describe("Tier 1 against the installed yap binary", () => {
  test.skipIf(!canDriveRealYap)("transcribes synthesized speech from a file", async () => {
    const spoken = join(scratch, "spoken.aiff");
    const wav = join(scratch, "spoken.wav");
    const phrase = "Ship the dev branch today";
    expect(Bun.spawnSync([sayPath!, "-o", spoken, phrase]).exitCode).toBe(0);
    expect(Bun.spawnSync([soxPath!, spoken, "-r", "16000", "-c", "1", "-b", "16", wav]).exitCode).toBe(0);

    const text = await transcribeFile(config({ yapBin: yapPath! }), wav, "yap");

    expect(text.toLowerCase()).toContain("ship the dev branch");
    // The Speech framework's first transcription after a cold start regularly
    // runs past the 5s default.
  }, 30_000);
});
