#!/usr/bin/env bun
// The voice-ask dependency check, shared by `scripts/install.sh` and `cli/echo doctor`.
//
// Splitting the plan's Tier 1 row made sox a hard dependency rather than an
// optional fallback, and nothing checked it: a machine without sox installed
// cleanly, reported healthy, and only failed when somebody actually asked a
// question. One checker serves both surfaces so they cannot drift.
//
// Run directly for the machine-readable form:
//   bun converse/deps.ts            # 0 = ready, 3 = something required is missing
//   bun converse/deps.ts --json

import { existsSync } from "node:fs";
import { resolveConverseConfig, type ConverseConfig } from "./config.ts";

export interface DependencyRow {
  /** Short label for a doctor row. */
  name: string;
  /** The binary or file this row is about, as configured. */
  target: string;
  found: boolean;
  /** False for a row that only improves things (the portable transcriber). */
  required: boolean;
  /** What to run or set when it is missing. */
  hint: string;
}

export type Which = (bin: string) => string | null;

const defaultWhich: Which = (bin) => {
  if (!bin.includes("/")) return Bun.which(bin);
  return existsSync(bin) ? bin : null;
};

/**
 * Every dependency a voice ask needs, in the order an operator should fix them.
 *
 * The recorder is required: there is one capture path and it is sox. A
 * transcriber is required too, but either rung satisfies it, so the rows report
 * both and the summary treats them as one requirement.
 */
export function checkConverseDependencies(
  config: ConverseConfig = resolveConverseConfig(),
  which: Which = defaultWhich,
): { rows: DependencyRow[]; ready: boolean; missing: string[] } {
  const yapFound = which(config.yapBin) !== null;
  const whisperBinFound = which(config.whisperBin) !== null;
  const whisperModelFound = config.whisperModel !== undefined && existsSync(config.whisperModel);

  const rows: DependencyRow[] = [
    {
      name: "recorder",
      target: config.recBin,
      found: which(config.recBin) !== null,
      required: true,
      hint: "brew install sox (provides `rec`), or set ECHO_CONVERSE_REC_BIN",
    },
    {
      name: "resampler",
      target: config.soxBin,
      found: which(config.soxBin) !== null,
      // Only the whisper rung resamples; yap reads the native-rate file directly.
      required: false,
      hint: "brew install sox, or set ECHO_CONVERSE_SOX_BIN (needed only for the whisper tier)",
    },
    {
      name: "transcriber (tier 1)",
      target: config.yapBin,
      found: yapFound,
      required: false,
      hint: "brew install yap (macOS 26 on-device transcription, no model download)",
    },
    {
      name: "transcriber (tier 2)",
      target: config.whisperModel === undefined ? config.whisperBin : `${config.whisperBin} + ${config.whisperModel}`,
      found: whisperBinFound && whisperModelFound,
      required: false,
      hint: "brew install whisper-cpp and set ECHO_CONVERSE_WHISPER_MODEL to a ggml model file",
    },
  ];

  const missing: string[] = [];
  for (const row of rows) {
    if (row.required && !row.found) missing.push(`${row.name} (${row.target}): ${row.hint}`);
  }
  // Either transcriber satisfies the requirement; neither does not.
  if (!yapFound && !(whisperBinFound && whisperModelFound)) {
    missing.push(
      `transcriber: install ${config.yapBin} for tier 1, or ${config.whisperBin} plus ` +
        "ECHO_CONVERSE_WHISPER_MODEL for tier 2",
    );
  }

  return { rows, ready: missing.length === 0, missing };
}

if (import.meta.main) {
  const result = checkConverseDependencies();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const row of result.rows) {
      console.log(`${row.found ? "ok  " : row.required ? "MISS" : "----"} ${row.name}: ${row.target}`);
    }
    for (const missing of result.missing) console.error(`missing: ${missing}`);
    if (result.ready) console.log("voice ask dependencies ready");
  }
  process.exit(result.ready ? 0 : 3);
}
