import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EchoVoiceCommand, ScaffoldContext } from "./persona-scaffold.ts";

// Host-neutral `/echo-mute` command. Adapters register this; mute itself stays
// in `cli/echo mute`.

export const DEFAULT_ECHO_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "echo");

export type MuteRunResult = { exitCode: number; stdout: string; stderr: string };
export type MuteRunner = (cliPath: string, muteArgs: string[]) => Promise<MuteRunResult>;

export function parseMuteArgs(args: string): string[] {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.length === 0 ? ["toggle"] : tokens;
}

export async function runEchoMute(cliPath: string, muteArgs: string[]): Promise<MuteRunResult> {
  const proc = Bun.spawn(["/bin/bash", cliPath, "mute", ...muteArgs], {
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
