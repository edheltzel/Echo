import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EchoVoiceCommand, ScaffoldContext } from "./persona-scaffold.ts";

// Host-neutral `/echo-mute` and `/echo-mode`. Both stay in `cli/echo` → scripts.
// Harnesses spawn bash on that CLI via node:child_process (Pi has no Bun global).
// No second TS path. No POST from the harness.

export const DEFAULT_ECHO_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "echo");

export type MuteRunResult = { exitCode: number; stdout: string; stderr: string };
export type MuteRunner = (cliPath: string, muteArgs: string[]) => Promise<MuteRunResult>;
export type EchoCliRunner = (cliPath: string, subcommand: string, args: string[]) => Promise<MuteRunResult>;

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter((t) => t.length > 0);
}

export function parseMuteArgs(args: string): string[] {
  const tokens = tokenize(args);
  return tokens.length === 0 ? ["toggle"] : tokens;
}

function readText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  const chunks: Buffer[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  stream.on("error", reject);
  return promise;
}

export function runEchoCli(cliPath: string, subcommand: string, args: string[]): Promise<MuteRunResult> {
  const child = spawn("/bin/bash", [cliPath, subcommand, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const { promise, resolve, reject } = Promise.withResolvers<MuteRunResult>();
  const closed = Promise.withResolvers<number>();
  child.on("error", reject);
  child.on("close", (code) => closed.resolve(code ?? 1));
  Promise.all([readText(child.stdout), readText(child.stderr), closed.promise]).then(
    ([stdout, stderr, exitCode]) => resolve({ exitCode, stdout, stderr }),
    reject,
  );
  return promise;
}

export function runEchoMute(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  return runEchoCli(cliPath, "mute", muteArgs);
}

function cliCommand(
  subcommand: string,
  description: string,
  argv: (args: string) => string[],
  invoke: (args: string[]) => Promise<MuteRunResult>,
): EchoVoiceCommand {
  return {
    description,
    handler: async (args: string, ctx: ScaffoldContext) => {
      try {
        const result = await invoke(argv(args));
        const text = result.stdout.trim() || result.stderr.trim() || `echo ${subcommand} exited ${result.exitCode}`;
        ctx.ui.notify(text, result.exitCode === 0 ? "info" : "error");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`echo ${subcommand} failed: ${reason}`, "error");
      }
    },
  };
}

export function createEchoMuteCommand(opts?: { cliPath?: string; run?: MuteRunner }): EchoVoiceCommand {
  const cliPath = opts?.cliPath ?? DEFAULT_ECHO_CLI;
  const run = opts?.run ?? runEchoMute;
  return cliCommand(
    "mute",
    "Mute Echo audio for every session on this machine (on/off/toggle/status/duration)",
    parseMuteArgs,
    (args) => run(cliPath, args),
  );
}

export function createEchoModeCommand(opts?: { cliPath?: string; run?: EchoCliRunner }): EchoVoiceCommand {
  const cliPath = opts?.cliPath ?? DEFAULT_ECHO_CLI;
  const run = opts?.run ?? runEchoCli;
  return cliCommand(
    "mode",
    "Switch Echo between speech and sounds for every session on this machine (speech/sounds/status)",
    tokenize,
    (args) => run(cliPath, "mode", args),
  );
}
