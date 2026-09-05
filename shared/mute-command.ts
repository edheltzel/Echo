import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EchoVoiceCommand, ScaffoldContext } from "./persona-scaffold.ts";

// Host-neutral `/echo-mute`. Mute itself stays in `cli/echo mute` → `scripts/mute.sh`.
// Harnesses spawn bash on that CLI via node:child_process (Pi has no Bun global).
// No second TS mute path. No POST /mute from the harness.

export const DEFAULT_ECHO_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "echo");

export type MuteRunResult = { exitCode: number; stdout: string; stderr: string };
export type MuteRunner = (cliPath: string, muteArgs: string[]) => Promise<MuteRunResult>;

export function parseMuteArgs(args: string): string[] {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.length === 0 ? ["toggle"] : tokens;
}

function readText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export function runEchoMute(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  const child = spawn("/bin/bash", [cliPath, "mute", ...muteArgs], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    Promise.all([
      readText(child.stdout),
      readText(child.stderr),
      new Promise<number>((done) => child.on("close", (code) => done(code ?? 1))),
    ]).then(([stdout, stderr, exitCode]) => resolve({ exitCode, stdout, stderr }), reject);
  });
}

export function createEchoMuteCommand(opts?: {
  cliPath?: string;
  run?: MuteRunner;
}): EchoVoiceCommand {
  const cliPath = opts?.cliPath ?? DEFAULT_ECHO_CLI;
  const run = opts?.run ?? runEchoMute;
  return {
    description: "Mute Echo audio for every session on this machine (on/off/toggle/status/duration)",
    handler: async (args: string, ctx: ScaffoldContext) => {
      try {
        const result = await run(cliPath, parseMuteArgs(args));
        const text = result.stdout.trim() || result.stderr.trim() || `echo mute exited ${result.exitCode}`;
        ctx.ui.notify(text, result.exitCode === 0 ? "info" : "error");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`echo mute failed: ${reason}`, "error");
      }
    },
  };
}
