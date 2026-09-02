import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type OwnedLinkKind = "current" | "create" | "replace";
export type OwnedLinkPlan = {
  destination: string;
  source: string;
  kind: OwnedLinkKind;
  target?: string;
};

/**
 * Plan an Echo-owned symlink. Foreign occupants (real files, non-Echo links)
 * are fatal. Dead Echo-spelled links are replaced. Callers apply with
 * applyOwnedSymlink after --check.
 */
export function planOwnedSymlink(opts: {
  destination: string;
  source: string;
  isEchoSpelling: (target: string) => boolean;
  fatal: (message: string) => never;
}): OwnedLinkPlan {
  const { destination, source, isEchoSpelling, fatal } = opts;
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      fatal(`could not inspect ${destination}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (stat === null) return { destination, source, kind: "create" };
  if (!stat.isSymbolicLink()) {
    fatal(`${destination} exists but is not an Echo-owned symlink. Echo will not overwrite it.`);
  }

  const target = readlinkSync(destination);
  let real: string | null = null;
  try {
    real = realpathSync(resolve(dirname(destination), target));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      fatal(`could not resolve ${destination}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (real === source) return { destination, source, kind: "current", target };
  if (real === null && isEchoSpelling(target)) return { destination, source, kind: "replace", target };
  if (real !== null && isEchoSpelling(target)) return { destination, source, kind: "replace", target };
  fatal(`${destination} points to ${target}, which is not an Echo registration. Echo will not overwrite it.`);
}

export function applyOwnedSymlink(plan: OwnedLinkPlan): void {
  if (plan.kind === "current") return;
  mkdirSync(dirname(plan.destination), { recursive: true });
  if (plan.kind === "replace") rmSync(plan.destination);
  symlinkSync(plan.source, plan.destination);
}

export function ownedLinkLog(plan: OwnedLinkPlan, filename: string): string {
  if (plan.kind === "current") return `= ${filename} already current -> ${plan.source}`;
  if (plan.kind === "replace") return `~ ${filename} ${plan.target} -> ${plan.source}`;
  return `+ ${filename} -> ${plan.source}`;
}
