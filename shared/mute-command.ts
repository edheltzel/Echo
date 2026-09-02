import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EchoVoiceCommand, ScaffoldContext } from "./persona-scaffold.ts";

// Host-neutral `/echo-mute` command. Adapters register this; mute itself stays
// in `cli/echo mute`. Harnesses must spawn bash on that CLI — never Bun.spawn
// as a hard requirement (Pi has no Bun global), never a second TS mute, and
// never HTTP-mute the daemon themselves.

export const DEFAULT_ECHO_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "echo");

export type MuteRunResult = { exitCode: number; stdout: string; stderr: string };
export type MuteRunner = (cliPath: string, muteArgs: string[]) => Promise<MuteRunResult>;

type BunSpawn = (cmd: string[], opts: { stdout: "pipe"; stderr: "pipe" }) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

export function parseMuteArgs(args: string): string[] {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.length === 0 ? ["toggle"] : tokens;
}

/** True when this process has a usable Bun.spawn. Pi (Node) does not. */
export function hasBunSpawn(): boolean {
  const bun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  return typeof bun?.spawn === "function";
}

const BASH = "/bin/bash";

function muteArgv(cliPath: string, muteArgs: string[]): [string, ...string[]] {
  return [BASH, cliPath, "mute", ...muteArgs];
}

export async function runEchoMuteBun(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  const bunSpawn = (globalThis as { Bun?: { spawn?: BunSpawn } }).Bun?.spawn;
  if (!bunSpawn) {
    throw new Error("Bun.spawn is not available");
  }
  const proc = bunSpawn(muteArgv(cliPath, muteArgs), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/** Node/POSIX spawn of bash `cli/echo mute …` — the Pi-safe mute path. */
export function runEchoMutePosix(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  const child = spawn(BASH, [cliPath, "mute", ...muteArgs], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number>((done) => child.on("close", (code) => done(code ?? 1))),
    ]).then(([stdout, stderr, exitCode]) => resolve({ exitCode, stdout, stderr }), reject);
  });
}

export async function runEchoMute(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  if (hasBunSpawn()) return runEchoMuteBun(cliPath, muteArgs);
  return runEchoMutePosix(cliPath, muteArgs);
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
