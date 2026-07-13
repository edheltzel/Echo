// Shared polling helper for the async play-queue era (Phase 2): /notify acks
// 202 on receipt and side effects (lifecycle rows, resolution rows, spawns)
// land when the queue's consumer finishes the job — tests poll for them.
// Not a .test.ts file: bun test ignores it; test files import it.
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
  label: string | (() => string) = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      const what = typeof label === "function" ? label() : label;
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(10);
  }
}
