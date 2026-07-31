import { existsSync, writeFileSync } from "node:fs";
import { askOnce, AskError } from "../../../converse/client.ts";
import { resolveConverseConfig } from "../../../converse/config.ts";
import type { CaptureEngine } from "../../../converse/capture.ts";

const [baseUrl, bookingLockPath, captureDir, startGate, releaseGate, resultPath] = process.argv.slice(2);
if (!baseUrl || !bookingLockPath || !captureDir || !startGate || !releaseGate || !resultPath) {
  throw new Error("race-caller requires base URL, paths, gates, and result path");
}

for (let attempt = 0; attempt < 2_000 && !existsSync(startGate); attempt++) await Bun.sleep(5);
if (!existsSync(startGate)) throw new Error("race start gate never opened");

const captureEngine: CaptureEngine = async () => {
  writeFileSync(`${resultPath}.capturing`, "capture started");
  for (let attempt = 0; attempt < 2_000 && !existsSync(releaseGate); attempt++) await Bun.sleep(5);
  if (!existsSync(releaseGate)) throw new Error("race capture release gate never opened");
  return { text: "one winner", engine: "yap", capture_ms: 1, timed_out: false };
};

try {
  const result = await askOnce(
    { question: `race from ${process.pid}`, source: "multiprocess-race" },
    {
      config: {
        ...resolveConverseConfig({}, captureDir),
        baseUrl,
        bookingLockPath,
        captureDir,
      },
      captureEngine,
      fetchImpl: (url, init) => fetch(url, init),
      ancestry: [`${process.pid} race-caller`],
    },
  );
  writeFileSync(resultPath, JSON.stringify({ ok: true, turn_id: result.turn_id }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({
    ok: false,
    code: error instanceof AskError ? error.code : "unexpected",
    detail: error instanceof Error ? error.message : String(error),
  }));
}
