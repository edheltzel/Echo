// Host-neutral native visual notification routing.
//
// The daemon cannot know which terminal owns an adapter invocation. Adapters
// therefore provide an explicit TTY writer and environment snapshot here. An
// absent writer is intentional: it prevents escape bytes from reaching hook
// protocol stdout or a daemon-owned stream.

import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { isatty } from "node:tty";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const MAX_TITLE = 80;
const MAX_BODY = 240;
const HERDR_TIMEOUT_MS = 1_000;

export type TerminalName = "ghostty" | "wezterm" | "kitty" | "iterm2";
export type PassthroughMode = "on" | "all" | "off" | "unknown";

export interface VisualNotification {
  title: string;
  body: string;
}

export interface NativeTerminalWriter {
  readonly isTTY: boolean;
  write(data: string): void | Promise<void>;
  /** Adapters that opened a temporary TTY may release it after routing. */
  close?: () => void;
}

export interface HerdrShowResult {
  shown?: unknown;
  reason?: unknown;
}

export interface TerminalNotificationContext {
  env?: Record<string, string | undefined>;
  writer?: NativeTerminalWriter;
  notificationId?: string;
  herdr?: {
    /** Adapter/test seam for a documented notification.show client. */
    show?: (notification: VisualNotification) => Promise<HerdrShowResult>;
  };
  tmux?: {
    /** Read-only evidence; Echo never changes this setting. */
    allowPassthrough?: PassthroughMode;
    readOnlyEvidence?: () => PassthroughMode | Promise<PassthroughMode>;
  };
  kitty?: {
    /** Optional adapter-owned capability query. A false result is fail-closed. */
    query?: () => boolean | Promise<boolean>;
    supported?: boolean;
  };
}

function isNativeWriter(value: unknown): value is NativeTerminalWriter {
  return typeof value === "object" && value !== null
    && (value as { isTTY?: unknown }).isTTY === true
    && typeof (value as { write?: unknown }).write === "function";
}

/**
 * Adapters may expose an explicitly-owned writer on their host context. Do not
 * fall back to process.stdout/stderr: hook stdout is often a host protocol.
 */
export function nativeContextFromAdapterContext(
  hostContext: unknown,
  env: Record<string, string | undefined> = process.env,
  notificationId?: string,
  openControllingTty = false,
): TerminalNotificationContext {
  const record = typeof hostContext === "object" && hostContext !== null
    ? hostContext as Record<string, unknown>
    : {};
  const writer = isNativeWriter(record.nativeTerminalWriter)
    ? record.nativeTerminalWriter
    : isNativeWriter(record.terminalWriter)
      ? record.terminalWriter
      : undefined;
  const context: TerminalNotificationContext = {
    env,
    writer: writer ?? (openControllingTty ? openNativeControllingTty() : undefined),
    notificationId,
  };
  const tmux = tmuxContextFromEnv(env);
  if (tmux) context.tmux = tmux;
  return context;
}

/** Read-only tmux passthrough evidence for a given env; Echo never mutates this setting. */
export function tmuxContextFromEnv(
  env: Record<string, string | undefined>,
): TerminalNotificationContext["tmux"] | undefined {
  return env.TMUX ? { readOnlyEvidence: () => readTmuxPassthrough(env) } : undefined;
}

/** Open only the adapter process's controlling TTY, never stdout or stderr. */
export function openNativeControllingTty(): NativeTerminalWriter | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const fd = openSync("/dev/tty", "w");
    if (!isatty(fd)) {
      closeSync(fd);
      return undefined;
    }
    return {
      isTTY: true,
      write: (data) => { writeSync(fd, data, "utf8"); },
      close: () => closeSync(fd),
    };
  } catch {
    return undefined;
  }
}

/** Read tmux state only; this function never enables or changes passthrough. */
async function readTmuxPassthrough(env: Record<string, string | undefined>): Promise<PassthroughMode> {
  const pane = env.TMUX_PANE;
  if (!pane || typeof Bun === "undefined") return "unknown";
  try {
    const process = Bun.spawn(["tmux", "show-options", "-p", "-t", pane, "-v", "allow-passthrough"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(process.stdout).text()).trim().toLowerCase();
    await process.exited;
    return output === "on" || output === "all" ? output : "off";
  } catch {
    return "unknown";
  }
}

export type NativeVisualResult =
  | { status: "shown"; route: "herdr" | "terminal"; terminal?: TerminalName }
  | { status: "unavailable" | "failed"; reason: string; route?: string };

export function normalizeVisualText(input: string, maxLength: number, delimiterSafe = false): string {
  const withoutControls = Array.from(input, (character) => {
    const codePoint = character.codePointAt(0)!;
    return (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) ? " " : character;
  }).join("");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  const safe = delimiterSafe ? collapsed.replaceAll(";", ",") : collapsed;
  return Array.from(safe).slice(0, maxLength).join("");
}

export function normalizeVisualNotification(notification: VisualNotification): VisualNotification {
  return {
    title: normalizeVisualText(notification.title, MAX_TITLE),
    body: normalizeVisualText(notification.body, MAX_BODY),
  };
}

export function detectTerminal(env: Record<string, string | undefined>): TerminalName | null {
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();

  // Alacritty must remain an explicit unsupported result even when another
  // variable happens to look like a supported terminal.
  if (program === "alacritty" || term === "alacritty") return null;
  if (program === "ghostty" || term === "xterm-ghostty") return "ghostty";
  if (program === "wezterm" && Boolean(env.TERM_PROGRAM_VERSION)) return "wezterm";
  if (program === "kitty" || term === "xterm-kitty" || Boolean(env.KITTY_WINDOW_ID)) return "kitty";
  if (program === "iterm.app" || program === "iterm2" || Boolean(env.ITERM_SESSION_ID)) return "iterm2";
  return null;
}

export function encodeOsc777(notification: VisualNotification): string {
  const title = normalizeVisualText(notification.title, MAX_TITLE, true);
  const body = normalizeVisualText(notification.body, MAX_BODY, true);
  return `${ESC}]777;notify;${title};${body}${ST}`;
}

export function encodeOsc9(notification: VisualNotification): string {
  const title = normalizeVisualText(notification.title, MAX_TITLE, true);
  const body = normalizeVisualText(notification.body, MAX_BODY, true);
  const message = title && body ? `${title}: ${body}` : title || body;
  return `${ESC}]9;${message}${ST}`;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function safeKittyId(value: string): string {
  const id = value.replace(/[^a-zA-Z0-9_+.\-]/g, "-").slice(0, 48);
  return id || "echo";
}

export function encodeKittyOsc99(notification: VisualNotification, notificationId = "echo"): string {
  const title = normalizeVisualText(notification.title, MAX_TITLE);
  const body = normalizeVisualText(notification.body, MAX_BODY);
  const id = safeKittyId(notificationId);
  const titleMeta = `i=${id}:a=-focus:d=0:e=1:p=title`;
  const bodyMeta = `i=${id}:a=-focus:d=1:e=1:p=body`;
  return `${ESC}]99;${titleMeta};${base64(title)}${ST}${ESC}]99;${bodyMeta};${base64(body)}${ST}`;
}

export function wrapTmuxPassthrough(sequence: string): string {
  // tmux's DCS passthrough envelope requires every inner ESC to be doubled.
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
}

export function kittyCapabilityQuery(notificationId = "echo"): string {
  const id = safeKittyId(notificationId);
  return `${ESC}]99;i=${id}:p=?${ST}`;
}

function isSocket(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isSocket();
  } catch {
    return false;
  }
}

export function resolveHerdrSocketPath(env: Record<string, string | undefined>): string | null {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const configPath = env.HERDR_CONFIG_PATH;
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "herdr");
  if (env.HERDR_SESSION) return join(configDir, "sessions", env.HERDR_SESSION, "herdr.sock");
  // A default socket alone is not proof that the originating process is inside
  // Herdr. Require a documented session/socket hint for adapter callers.
  return null;
}

function requestHerdr(socketPath: string, notification: VisualNotification): Promise<HerdrShowResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket: Socket = createConnection(socketPath);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        try {
          const parsed = JSON.parse(response.trim()) as { result?: HerdrShowResult };
          resolve(parsed.result ?? {});
        } catch (parseError) {
          reject(parseError);
        }
      }
    };
    const timeout = setTimeout(() => finish(new Error("Herdr notification timed out")), HERDR_TIMEOUT_MS);
    socket.setTimeout(HERDR_TIMEOUT_MS, () => finish(new Error("Herdr notification timed out")));
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        id: `echo-${Date.now()}`,
        method: "notification.show",
        params: { title: notification.title, body: notification.body, sound: "none" },
      }) + "\n");
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
      if (response.includes("\n")) {
        clearTimeout(timeout);
        finish();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      finish(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!settled) finish(new Error("Herdr socket closed without a response"));
    });
  });
}

async function tryHerdr(
  notification: VisualNotification,
  context: TerminalNotificationContext,
): Promise<NativeVisualResult> {
  const herdrShow = context.herdr?.show;
  const env = context.env ?? process.env;
  const socketPath = resolveHerdrSocketPath(env);
  if (!herdrShow && (!socketPath || !isSocket(socketPath))) {
    return { status: "unavailable", reason: "no-herdr-context", route: "herdr" };
  }

  try {
    const result = await (herdrShow ? herdrShow(notification) : requestHerdr(socketPath!, notification));
    if (result.shown === true) return { status: "shown", route: "herdr" };
    return { status: "unavailable", reason: String(result.reason ?? "not-shown"), route: "herdr" };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), route: "herdr" };
  }
}

async function resolvePassthrough(context: TerminalNotificationContext): Promise<PassthroughMode> {
  if (!context.tmux) return "unknown";
  if (context.tmux.allowPassthrough) return context.tmux.allowPassthrough;
  if (context.tmux.readOnlyEvidence) {
    try {
      return await context.tmux.readOnlyEvidence();
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

async function tryTerminal(
  notification: VisualNotification,
  context: TerminalNotificationContext,
): Promise<NativeVisualResult> {
  const writer = context.writer;
  if (!writer || writer.isTTY !== true) return { status: "unavailable", reason: "no-safe-tty", route: "terminal" };

  const env = context.env ?? process.env;
  const terminal = detectTerminal(env);
  if (!terminal) return { status: "unavailable", reason: "unsupported-terminal", route: "terminal" };

  try {
    if (terminal === "kitty" && context.kitty?.supported === false) {
      return { status: "unavailable", reason: "kitty-capability-query-failed", route: "terminal" };
    }
    if (terminal === "kitty" && context.kitty?.query && !(await context.kitty.query())) {
      return { status: "unavailable", reason: "kitty-capability-query-failed", route: "terminal" };
    }

    let sequence = terminal === "kitty"
      ? encodeKittyOsc99(notification, context.notificationId)
      : terminal === "iterm2" ? encodeOsc9(notification) : encodeOsc777(notification);

    if (env.TMUX) {
      const passthrough = await resolvePassthrough(context);
      if (passthrough !== "on" && passthrough !== "all") {
        return { status: "unavailable", reason: "tmux-passthrough-not-proven", route: "terminal" };
      }
      sequence = wrapTmuxPassthrough(sequence);
    }

    await writer.write(sequence);
    return { status: "shown", route: "terminal", terminal };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), route: "terminal" };
  }
}

export async function tryNativeVisual(
  notification: VisualNotification,
  context: TerminalNotificationContext = {},
): Promise<NativeVisualResult> {
  const normalized = normalizeVisualNotification(notification);
  if (!normalized.title) {
    context.writer?.close?.();
    return { status: "unavailable", reason: "empty-title" };
  }

  try {
    const herdr = await tryHerdr(normalized, context);
    if (herdr.status === "shown") return herdr;

    const terminal = await tryTerminal(normalized, context);
    if (terminal.status === "shown") return terminal;
    return terminal.status === "failed" ? terminal : {
      status: "unavailable",
      reason: `${herdr.reason}; ${terminal.reason}`,
    };
  } finally {
    context.writer?.close?.();
  }
}
