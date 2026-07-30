import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CaptureHoldError,
  clearCaptureHold,
  publishCaptureHold,
  readCaptureState,
  withCaptureHeld,
  writeCaptureState,
} from "../../converse/capture-state.ts";
import { readCaptureState as coreReadCaptureState } from "../../core/capture-guard.ts";

// The hold now goes up BEFORE the booking race is resolved, which is what leaves
// no gap for another session's audio. That ordering is deliberate and stays; what
// it introduced is a second writer for the same file.
//
// Two interleavings break if either side of the hold writes unconditionally:
//
//  * A is granted and starts recording; B loses with a 409 and its `finally`
//    writes idle with B's pid. Core then reads idle and speaks into A's live
//    recording - the exact interlock this capability exists to provide.
//  * B publishes over A's record before A's own preflight runs. A then reads a
//    holder that is not its owner pid and refuses itself as microphone_busy, so
//    BOTH asks fail.
//
// tests/e2e-converse.sh drives concurrency by POSTing /turn directly, so it never
// reaches this code path. It is covered here instead.

let scratch: string;
let statePath: string;

const ALIVE = () => true;
const DEAD = () => false;

const WINNER_PID = 4_242;
const LOSER_PID = 9_001;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-hold-"));
  statePath = join(scratch, "voicelayer", "recording-state.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The winner's live hold, as its own askOnce would have published it. */
function publishWinnersHold(): void {
  writeCaptureState(statePath, "recording", WINNER_PID, Date.now(), "winner-nonce");
}

describe("publishing a hold never overwrites a live foreign one", () => {
  test("a losing ask leaves the winner's record exactly as it found it", () => {
    publishWinnersHold();

    const published = publishCaptureHold(statePath, "recording", LOSER_PID, "loser-nonce", ALIVE);

    expect(published).toBe(false);
    const record = readCaptureState(statePath);
    expect(record?.pid).toBe(WINNER_PID);
    expect(record?.nonce).toBe("winner-nonce");
    expect(record?.state).toBe("recording");
  });

  test("the winner's own preflight still sees ITS pid, so the turn it won is not refused", () => {
    // The mirror failure: with an unconditional publish the loser's pid lands in
    // the file, the winner reads a foreign holder and refuses itself.
    publishWinnersHold();
    publishCaptureHold(statePath, "recording", LOSER_PID, "loser-nonce", ALIVE);

    expect(readCaptureState(statePath)?.pid).toBe(WINNER_PID);
  });

  test("a dead owner's record is not a hold, so it is taken over", () => {
    writeCaptureState(statePath, "recording", 999_999, Date.now(), "orphan");

    expect(publishCaptureHold(statePath, "recording", LOSER_PID, "mine", DEAD)).toBe(true);
    expect(readCaptureState(statePath)?.pid).toBe(LOSER_PID);
  });

  test("an idle record, a missing file and a corrupt file all publish cleanly", () => {
    expect(publishCaptureHold(statePath, "recording", LOSER_PID, "mine", ALIVE)).toBe(true);

    writeCaptureState(statePath, "idle", WINNER_PID);
    expect(publishCaptureHold(statePath, "recording", LOSER_PID, "mine", ALIVE)).toBe(true);

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{ not json");
    expect(publishCaptureHold(statePath, "recording", LOSER_PID, "mine", ALIVE)).toBe(true);
    expect(readCaptureState(statePath)?.pid).toBe(LOSER_PID);
  });

  test("the same turn may re-publish its own hold to advance the state", () => {
    publishCaptureHold(statePath, "recording", WINNER_PID, "n", ALIVE);

    expect(publishCaptureHold(statePath, "transcribing", WINNER_PID, "n", ALIVE)).toBe(true);
    expect(readCaptureState(statePath)?.state).toBe("transcribing");
  });

  // One host process can have two asks in flight - an MCP stdio server serving
  // parallel tool calls is the obvious case - and they share a pid. Identity is
  // therefore the pid AND the per-turn nonce: on pid alone the second ask
  // overwrites the first one's record, and then its own clear matches and frees
  // a live recording.
  test("a second turn in the SAME process is foreign too", () => {
    publishWinnersHold();

    expect(publishCaptureHold(statePath, "recording", WINNER_PID, "a-second-turn", ALIVE)).toBe(false);
    expect(readCaptureState(statePath)?.nonce).toBe("winner-nonce");
  });
});

describe("clearing a hold only ever writes over our own record", () => {
  test("a losing ask cannot free the winner's live hold", () => {
    publishWinnersHold();

    const cleared = clearCaptureHold(statePath, LOSER_PID, "loser-nonce");

    expect(cleared).toBe(false);
    // The consequence, read through core's own guard rather than asserted about
    // the file: core must still hold its speech back.
    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(true);
  });

  test("a later turn in the SAME process cannot clear an earlier turn's hold", () => {
    // Same pid, different nonce: the pid alone is not enough to identify a turn.
    publishWinnersHold();

    expect(clearCaptureHold(statePath, WINNER_PID, "a-later-nonce")).toBe(false);
    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(true);
  });

  test("the owner's own clear still frees core", () => {
    publishWinnersHold();

    expect(clearCaptureHold(statePath, WINNER_PID, "winner-nonce")).toBe(true);
    expect(readCaptureState(statePath)?.state).toBe("idle");
    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(false);
  });

  test("a missing or corrupt file is tolerated rather than thrown", () => {
    expect(clearCaptureHold(statePath, WINNER_PID, "n")).toBe(false);

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "half-written{");
    expect(clearCaptureHold(statePath, WINNER_PID, "n")).toBe(false);
    // Untouched: core reads an unparseable file as idle anyway, and rewriting it
    // would claim a hold this process does not have.
    expect(readFileSync(statePath, "utf8")).toBe("half-written{");
  });
});

describe("a losing turn runs its whole lifecycle without damaging the winner's hold", () => {
  test("the loser never enters its body, and the winner keeps the microphone", async () => {
    publishWinnersHold();
    let bodyRan = false;

    // Refused before anything is spoken: running the body without a hold would
    // leave the recording with no interlock at all if the winner finished before
    // the coordinator's preflight read the state.
    const failure = await withCaptureHeld(
      statePath,
      async () => {
        bodyRan = true;
      },
      LOSER_PID,
      "loser-nonce",
      ALIVE,
    ).catch((error: CaptureHoldError) => error);

    expect(bodyRan).toBe(false);
    expect((failure as CaptureHoldError).code).toBe("microphone_busy");
    const after = readCaptureState(statePath);
    expect(after?.pid).toBe(WINNER_PID);
    expect(after?.nonce).toBe("winner-nonce");
    expect(after?.state).toBe("recording");
    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(true);
  });

  test("a second ask in the SAME process leaves the first one's live hold alone", async () => {
    // The whole lifecycle, same pid, different nonces: the inner turn must not be
    // able to publish over the outer one and then clear it on the way out.
    let innerRefused = false;

    await withCaptureHeld(
      statePath,
      async () => {
        await withCaptureHeld(
          statePath,
          async () => {},
          WINNER_PID,
          "second-turn-nonce",
          ALIVE,
        ).catch(() => {
          innerRefused = true;
        });

        // The outer turn is still recording, which is what core must see.
        expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(true);
        expect(readCaptureState(statePath)?.nonce).toBe("first-turn-nonce");
      },
      WINNER_PID,
      "first-turn-nonce",
      ALIVE,
    );

    expect(innerRefused).toBe(true);
  });

  test("an uncontended turn still publishes on entry and clears on exit", async () => {
    let heldDuringBody = false;

    await withCaptureHeld(
      statePath,
      async () => {
        heldDuringBody = coreReadCaptureState(statePath, ALIVE) !== "idle";
      },
      WINNER_PID,
      "winner-nonce",
      ALIVE,
    );

    expect(heldDuringBody).toBe(true);
    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(false);
  });

  test("a throwing body still clears the owner's own hold", async () => {
    await withCaptureHeld(
      statePath,
      async () => {
        throw new Error("capture failed");
      },
      WINNER_PID,
      "winner-nonce",
      ALIVE,
    ).catch(() => {});

    expect(coreReadCaptureState(statePath, ALIVE) !== "idle").toBe(false);
  });
});
