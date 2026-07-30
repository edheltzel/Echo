import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCaptureHeld, writeCaptureState } from "../../converse/capture-state.ts";
import { isCaptureActive, readCaptureState } from "../../core/capture-guard.ts";

// The mic-vs-playback interlock only works if converse's writer and core's
// reader agree on one file format. Nothing in the type system connects them:
// core cannot import converse and converse must not import core. So the
// agreement is proven here, by writing with one and reading with the other.
// If either side drifts, this file goes red - which is the whole point.

let scratch: string;
let statePath: string;

const ALIVE = () => true;
const DEAD = () => false;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-capture-"));
  statePath = join(scratch, "voicelayer", "recording-state.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("capture-state contract: converse writes, core reads", () => {
  // The writer publishes its own live pid here, exactly as the real capture
  // owner does, so core's default liveness probe is the one under test.
  test("core sees a recording state converse published", () => {
    writeCaptureState(statePath, "recording", process.pid);

    expect(readCaptureState(statePath)).toBe("recording");
    expect(isCaptureActive(statePath)).toBe(true);
  });

  test("core sees the transcribing state too", () => {
    writeCaptureState(statePath, "transcribing", 4242);

    expect(readCaptureState(statePath, ALIVE)).toBe("transcribing");
  });

  test("core resumes speaking once converse writes idle", () => {
    writeCaptureState(statePath, "recording", 4242);
    writeCaptureState(statePath, "idle", 4242);

    expect(readCaptureState(statePath, ALIVE)).toBe("idle");
    expect(isCaptureActive(statePath)).toBe(false);
  });

  test("a crashed capture owner does not silence core forever", () => {
    writeCaptureState(statePath, "recording", 4242);

    // Core's stale-crash guard is the whole reason converse writes its OWN pid.
    expect(readCaptureState(statePath, DEAD)).toBe("idle");
  });

  test("the published record has the shape core validates", () => {
    writeCaptureState(statePath, "recording", 4242, 1_700_000_000_000);

    const record = JSON.parse(readFileSync(statePath, "utf8"));
    expect(record).toEqual({
      state: "recording",
      pid: 4242,
      updated_at: "2023-11-14T22:13:20.000Z",
    });
  });

  test("the state file is owner-only", () => {
    writeCaptureState(statePath, "recording", 4242);

    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  test("rewriting leaves no residue from a longer previous record", () => {
    writeCaptureState(statePath, "transcribing", 999_999_999);
    writeCaptureState(statePath, "idle", 1);

    expect(readCaptureState(statePath, ALIVE)).toBe("idle");
    expect(JSON.parse(readFileSync(statePath, "utf8")).pid).toBe(1);
  });

  test("no staging file is left beside the state file", () => {
    writeCaptureState(statePath, "recording", 4242);

    const leftovers = readFileSync(statePath, "utf8");
    expect(leftovers.length).toBeGreaterThan(0);
    expect(Bun.spawnSync(["ls", "-a", join(scratch, "voicelayer")]).stdout.toString())
      .not.toContain(".tmp");
  });
});

describe("withCaptureHeld", () => {
  test("holds during the body and returns to idle after it", async () => {
    const seen: string[] = [];

    const result = await withCaptureHeld(statePath, async () => {
      seen.push(readCaptureState(statePath, ALIVE));
      return "transcript";
    }, 4242);

    expect(result).toBe("transcript");
    expect(seen).toEqual(["recording"]);
    expect(readCaptureState(statePath, ALIVE)).toBe("idle");
  });

  test("returns to idle when the body throws", async () => {
    await expect(
      withCaptureHeld(statePath, async () => {
        throw new Error("capture failed");
      }, 4242),
    ).rejects.toThrow("capture failed");

    expect(readCaptureState(statePath, ALIVE)).toBe("idle");
    expect(isCaptureActive(statePath)).toBe(false);
  });

  test("the body can escalate recording to transcribing", async () => {
    const seen: string[] = [];

    await withCaptureHeld(statePath, async (publish) => {
      seen.push(readCaptureState(statePath, ALIVE));
      publish("transcribing");
      seen.push(readCaptureState(statePath, ALIVE));
    }, 4242);

    expect(seen).toEqual(["recording", "transcribing"]);
    expect(readCaptureState(statePath, ALIVE)).toBe("idle");
  });
});
