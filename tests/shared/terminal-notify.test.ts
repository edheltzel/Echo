import { describe, expect, test } from "bun:test";
import {
  detectTerminal,
  encodeKittyOsc99,
  encodeOsc9,
  encodeOsc777,
  kittyCapabilityQuery,
  normalizeVisualNotification,
  nativeContextFromAdapterContext,
  tryNativeVisual,
  wrapTmuxPassthrough,
} from "../../shared/terminal-notify.ts";

const notification = { title: "Build; done", body: "Line one\nLine two\u001b\u0007" };

describe("native terminal visual routing", () => {
  test("normalizes controls, delimiters, Unicode, and independent bounds", () => {
    const result = normalizeVisualNotification({
      title: "  ✅\nready;\u001b  ",
      body: "x".repeat(300),
    });
    expect(result.title).toBe("✅ ready;");
    expect(Array.from(result.body)).toHaveLength(240);
  });

  test("tries Herdr before the terminal and stops after shown:true", async () => {
    const calls: string[] = [];
    const bytes: string[] = [];
    const result = await tryNativeVisual(notification, {
      herdr: { show: async () => { calls.push("herdr"); return { shown: true }; } },
      writer: { isTTY: true, write: (value) => bytes.push(value) },
      env: { TERM_PROGRAM: "Ghostty", TERM_PROGRAM_VERSION: "1" },
    });
    expect(result).toEqual({ status: "shown", route: "herdr" });
    expect(calls).toEqual(["herdr"]);
    expect(bytes).toEqual([]);
  });

  test("falls through on Herdr shown:false and writes structured Ghostty bytes", async () => {
    const bytes: string[] = [];
    const result = await tryNativeVisual(notification, {
      herdr: { show: async () => ({ shown: false, reason: "no_foreground_client" }) },
      writer: { isTTY: true, write: (value) => bytes.push(value) },
      env: { TERM_PROGRAM: "Ghostty", TERM_PROGRAM_VERSION: "1" },
    });
    expect(result).toMatchObject({ status: "shown", route: "terminal", terminal: "ghostty" });
    expect(bytes[0]).toBe(encodeOsc777(notification));
  });

  test("encodes WezTerm/Kitty/iTerm2 protocols without focus actions", () => {
    expect(encodeOsc777(notification)).toContain("\u001b]777;notify;");
    expect(encodeOsc9(notification)).toContain("\u001b]9;Build, done: Line one Line two");
    const kitty = encodeKittyOsc99(notification, "session/1");
    expect(kitty).toContain("a=-focus");
    expect(kitty).toContain("p=title");
    expect(kitty).toContain("p=body");
    expect(kitty).not.toContain("focus;");
    expect(kittyCapabilityQuery("s")).toBe("\u001b]99;i=s:p=?\u001b\\");
  });

  test("requires conservative identity and rejects Alacritty/headless", async () => {
    expect(detectTerminal({ TERM: "xterm-256color" })).toBeNull();
    expect(detectTerminal({ TERM_PROGRAM: "Alacritty", TERM: "xterm-ghostty" })).toBeNull();
    const bytes: string[] = [];
    const result = await tryNativeVisual(notification, {
      writer: { isTTY: false, write: (value) => bytes.push(value) },
      env: { TERM_PROGRAM: "Ghostty", TERM_PROGRAM_VERSION: "1" },
    });
    expect(result.status).toBe("unavailable");
    expect(bytes).toEqual([]);
  });

  test("adapter context never adopts arbitrary stdout as a protocol writer", () => {
    const stdout = { isTTY: true, write: () => {} };
    expect(nativeContextFromAdapterContext({ stdout }, {}).writer).toBeUndefined();
    expect(nativeContextFromAdapterContext({ nativeTerminalWriter: stdout }, {}).writer).toBe(stdout);
  });

  test("requires read-only tmux passthrough evidence and wraps ESC exactly", async () => {
    const bytes: string[] = [];
    const unavailable = await tryNativeVisual(notification, {
      writer: { isTTY: true, write: (value) => bytes.push(value) },
      env: { TMUX: "/tmp/tmux", TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "1" },
      tmux: { allowPassthrough: "unknown" },
    });
    expect(unavailable.status).toBe("unavailable");
    expect(bytes).toEqual([]);

    const shown = await tryNativeVisual(notification, {
      writer: { isTTY: true, write: (value) => bytes.push(value) },
      env: { TMUX: "/tmp/tmux", TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "1" },
      tmux: { allowPassthrough: "all" },
    });
    expect(shown.status).toBe("shown");
    expect(bytes.at(-1)).toBe(wrapTmuxPassthrough(encodeOsc777(notification)));
    expect(bytes.at(-1)).toContain("\u001b\u001b");
  });

  test("Kitty capability failure and write failure are not native success", async () => {
    const result = await tryNativeVisual(notification, {
      writer: { isTTY: true, write: () => {} },
      env: { TERM: "xterm-kitty" },
      kitty: { query: () => false },
    });
    expect(result.status).toBe("unavailable");

    const failed = await tryNativeVisual(notification, {
      writer: { isTTY: true, write: () => { throw new Error("write failed"); } },
      env: { TERM_PROGRAM: "Ghostty", TERM_PROGRAM_VERSION: "1" },
    });
    expect(failed).toMatchObject({ status: "failed", route: "terminal" });
  });
});
