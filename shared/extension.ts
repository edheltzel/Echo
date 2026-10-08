import { createEchoMuteCommand, type MuteRunner } from "./mute-command.ts";
import {
  createEchoVoiceCommand,
  type EchoVoiceCommand,
  type EchoVoiceCommandOptions,
} from "./persona-scaffold.ts";

// Echo's extension surface. New harnesses and new features plug in through the
// seams already proven in-tree: Pi/omp in-process registerCommand, Claude's thin
// plugin (hooks + slash commands), Jcode/Grok/Codex lifecycle hooks, OpenCode's
// mute-only owned symlink, MCP's stdio server, and doctor/env via echo-env.ts.
//
// This is not a second plugin loader and it is not imported by core/. The daemon
// stays host-neutral. Install still delegates to each adapter's own reconciler.
// Adding a harness means: ship adapters/<id>/, register it here, then satisfy
// the lockstep test (workspaces, install.sh, cli/echo, reconcile --check).

/** `--adapter` values that wire a host. `none` is core-only and is not a harness. */
export const HARNESS_IDS = [
  "claudecode",
  "jcode",
  "grok",
  "codex",
  "mcp",
  "pi",
  "omp",
  "opencode",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];
export type AdapterFlag = "none" | HarnessId;

export type FeatureId = "notify" | "mute" | "persona" | "ask" | "greeting";

export type HarnessKind = "extension" | "hooks" | "mcp" | "commands-only";

export type ReconcileSpec = {
  /** Repo-relative bun script. Must support `--check` (exit 0 current / 3 pending / 2 fatal). */
  script: string;
  /** Row label in `install.sh --check` / `cli/echo doctor`. */
  label: string;
};

export type HarnessManifest = {
  id: HarnessId;
  displayName: string;
  packageDir: `adapters/${HarnessId}`;
  kind: HarnessKind;
  /** Host-facing entry the runtime loads, repo-relative. */
  entry?: string;
  /** Host CLI that must exist on PATH before `--adapter <id>` mutates host state. */
  requiredCli?: string;
  /** Preflight diagnoses converse capture tools (warn-only). */
  converse?: boolean;
  /** Extra host CLI before reconcile. Pi is the only as-built case (`pi install`). */
  hostInstall?: { bin: string; args: readonly string[] };
  reconcile: readonly ReconcileSpec[];
  features: readonly FeatureId[];
  /** Slash-command / skill mute file, repo-relative. Extension hosts use registerEchoMute instead. */
  mutePath?: string;
  /** Doctor heading when this harness is grouped under another host (MCP under Claude Code). */
  doctorGroup?: string;
};

export const HARNESSES: readonly HarnessManifest[] = [
  {
    id: "claudecode",
    displayName: "Claude Code",
    packageDir: "adapters/claudecode",
    kind: "hooks",
    entry: "adapters/claudecode/hooks/VoiceCompletion.hook.ts",
    reconcile: [
      { script: "adapters/claudecode/restore-hooks.ts", label: "Adapter registration" },
      { script: "adapters/claudecode/reconcile-commands.ts", label: "Slash commands" },
    ],
    features: ["notify", "mute", "persona", "greeting"],
    mutePath: "adapters/claudecode/commands/echo-mute.md",
  },
  {
    id: "jcode",
    displayName: "Jcode",
    packageDir: "adapters/jcode",
    kind: "hooks",
    entry: "adapters/jcode/hook.ts",
    requiredCli: "jcode",
    reconcile: [{ script: "adapters/jcode/reconcile.ts", label: "Adapter registration" }],
    features: ["notify", "greeting"],
  },
  {
    id: "grok",
    displayName: "Grok Build",
    packageDir: "adapters/grok",
    kind: "hooks",
    entry: "adapters/grok/hook.ts",
    requiredCli: "grok",
    reconcile: [{ script: "adapters/grok/reconcile.ts", label: "Adapter registration" }],
    features: ["notify", "mute", "greeting"],
    mutePath: "adapters/grok/skills/echo-mute/SKILL.md",
  },
  {
    id: "codex",
    displayName: "Codex",
    packageDir: "adapters/codex",
    kind: "hooks",
    entry: "adapters/codex/hook.ts",
    requiredCli: "codex",
    reconcile: [{ script: "adapters/codex/reconcile.ts", label: "Adapter registration" }],
    features: ["notify", "mute", "greeting"],
    mutePath: "adapters/codex/skills/echo-mute/SKILL.md",
  },
  {
    id: "mcp",
    displayName: "MCP",
    packageDir: "adapters/mcp",
    kind: "mcp",
    entry: "adapters/mcp/server.ts",
    converse: true,
    reconcile: [{ script: "adapters/mcp/reconcile.ts", label: "MCP server" }],
    features: ["ask"],
    doctorGroup: "Claude Code",
  },
  {
    id: "pi",
    displayName: "Pi",
    packageDir: "adapters/pi",
    kind: "extension",
    entry: "adapters/pi/index.ts",
    requiredCli: "pi",
    converse: true,
    hostInstall: { bin: "pi", args: ["install", "adapters/pi"] },
    reconcile: [{ script: "adapters/pi/reconcile.ts", label: "Adapter registration" }],
    features: ["notify", "mute", "persona", "ask", "greeting"],
  },
  {
    id: "omp",
    displayName: "oh-my-pi",
    packageDir: "adapters/omp",
    kind: "extension",
    entry: "adapters/omp/index.ts",
    requiredCli: "omp",
    converse: true,
    reconcile: [{ script: "adapters/omp/reconcile.ts", label: "Adapter registration" }],
    features: ["notify", "mute", "persona", "ask", "greeting"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    packageDir: "adapters/opencode",
    kind: "commands-only",
    requiredCli: "opencode",
    reconcile: [{ script: "adapters/opencode/reconcile.ts", label: "Mute command" }],
    features: ["mute"],
    mutePath: "adapters/opencode/commands/echo-mute.md",
  },
];

/** Where each feature's register hook already lives. Do not add a parallel factory. */
export const FEATURES = {
  notify: {
    id: "notify",
    module: "@echo/shared/notify-client.ts",
    register: "sendNotification",
  },
  mute: {
    id: "mute",
    module: "@echo/shared/extension.ts",
    register: "registerEchoMute",
    cli: "cli/echo mute",
  },
  persona: {
    id: "persona",
    module: "@echo/shared/extension.ts",
    register: "registerEchoVoice",
  },
  ask: {
    id: "ask",
    module: "@echo/converse/host-tool.ts",
    register: "registerEchoAskTool",
  },
  greeting: {
    id: "greeting",
    module: "@echo/shared/greeting.ts",
    register: "applyNameToken",
  },
  env: {
    id: "env",
    module: "@echo/shared/echo-env.ts",
    register: "loadEchoEnvironment",
  },
} as const;

export function harnessUsageIds(): string {
  return ["none", ...HARNESS_IDS].join("|");
}

export function harnessById(id: string): HarnessManifest | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}

export function isHarnessId(id: string): id is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(id);
}

/** Hosts with an in-process command API (Pi, omp). Slash-command hosts use mutePath files. */
export type CommandHost = {
  registerCommand(name: string, command: EchoVoiceCommand): void;
};

/** Register `/echo-mute` so it shells out to bash `cli/echo mute`. No second mute path. */
export function registerEchoMute(
  host: CommandHost,
  opts?: { cliPath?: string; run?: MuteRunner },
): void {
  host.registerCommand("echo-mute", createEchoMuteCommand(opts));
}

/** Register `/echo-voice` on a command host. Claude's analog is the markdown slash command. */
export function registerEchoVoice(host: CommandHost, opts: EchoVoiceCommandOptions): void {
  host.registerCommand("echo-voice", createEchoVoiceCommand(opts));
}
