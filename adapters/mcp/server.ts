#!/usr/bin/env bun
// MCP server exposing echo's one-shot voice ask.
//
// Claude Code needs this. Its hooks are one-shot lifecycle interceptors: they
// read one JSON blob, write one verdict and exit, so they can block or allow a
// tool call and inject context, but they cannot expose a tool the model itself
// decides to call, and they have no channel for handing a transcript back as a
// tool result. MCP is the only mechanism that does.
//
// The server is a thin client of the capability: it does no capture logic of its
// own, it just calls askOnce, which spawns the capture child in THIS process's
// tree.
//
// That is expected to give the right TCC attribution, and the expectation is
// worth stating precisely because it has not been measured here. What the spike
// measured is that a capture spawned from the host terminal's tree attributes to
// the terminal app while one under a launchd job gets no responsible process at
// all. Stdio transport means the host spawns this server as its own child, so
// the ancestry should reach the terminal - but no run on this host has confirmed
// the chain through Claude Code specifically. Each turn records the ancestry it
// resolved, so the first real ask reports the answer rather than assuming it.
//
// The wire protocol is hand-written rather than pulled from an SDK: three
// methods over newline-delimited JSON is less code than a dependency, and the
// shapes are pinned to the published specification (2025-11-25 lifecycle and
// tools pages) rather than to memory. tests/adapters/mcp replays a full
// exchange against a spawned process, so the wire is covered, not just the
// dispatcher.

import {
  ECHO_ASK_PARAMETERS,
  ECHO_ASK_TOOL_DESCRIPTION,
  ECHO_ASK_TOOL_LABEL,
  ECHO_ASK_TOOL_NAME,
  runAskTool,
  type AskToolOptions,
} from "@echo/converse/host-tool.ts";
import { SessionConsent, type SessionConsentDecision } from "@echo/converse/session-consent.ts";
import manifest from "./package.json";

/**
 * Versions this server can speak. Only `initialize`, `tools/list` and
 * `tools/call` are implemented, and those are unchanged across all of them, so
 * an older client is answered in its own version rather than refused.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface McpServerDeps {
  ask?: AskToolOptions["ask"];
  ensureConsent?: AskToolOptions["ensureConsent"];
  /** Injected by tests; the real stdio session uses the macOS dialog below. */
  requestConsent?: (signal?: AbortSignal) => Promise<SessionConsentDecision>;
  /** Aborted when the host cancels this request, which closes the microphone. */
  signal?: AbortSignal;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function negotiateVersion(params: unknown): string {
  const requested = typeof params === "object" && params !== null
    ? (params as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : PREFERRED_PROTOCOL_VERSION;
}

const TOOL_DESCRIPTOR = {
  name: ECHO_ASK_TOOL_NAME,
  title: ECHO_ASK_TOOL_LABEL,
  description: ECHO_ASK_TOOL_DESCRIPTION,
  inputSchema: ECHO_ASK_PARAMETERS,
};

/**
 * Ask once per MCP process/stdio session, independently of generic tool permissions.
 *
 * The decision distinguishes a human signal from a missing surface: clicking
 * Deny (osascript's cancel button, error -128) or aborting the tool call while
 * the dialog is up is a sticky denial, while a platform or GUI-session where
 * the dialog cannot be presented at all stays "unavailable" and retryable.
 */
export async function requestMcpSessionConsent(signal?: AbortSignal): Promise<SessionConsentDecision> {
  if (process.platform !== "darwin") return "unavailable";
  if (signal?.aborted) return "denied";

  const script = [
    'set answer to button returned of (display dialog "Echo can record and transcribe microphone audio whenever echo_ask runs in this Claude Code/MCP session. You will not be prompted again until this session ends."',
    'with title "Allow Echo voice replies?" buttons {"Deny", "Allow for Session"} default button "Deny" cancel button "Deny" with icon caution)',
    "return answer",
  ].join(" ");
  const child = Bun.spawn(["/usr/bin/osascript", "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, output, errorOutput] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode === 0 && output.trim() === "Allow for Session") return "granted";
    if (signal?.aborted || errorOutput.includes("-128")) return "denied";
    return "unavailable";
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Handle one JSON-RPC message. Returns null for a notification, which by
 * definition gets no reply.
 */
export async function handleMessage(message: JsonRpcRequest, deps: McpServerDeps = {}): Promise<object | null> {
  const { method, id } = message;

  if (method === "initialize") {
    return result(id, {
      protocolVersion: negotiateVersion(message.params),
      capabilities: { tools: {} },
      serverInfo: { name: "echo-converse", title: "Echo Converse", version: manifest.version },
      instructions:
        "Call echo_ask to put a question to the human out loud and receive their spoken answer as text. " +
        "One question per call; the call blocks until they stop speaking.",
    });
  }

  // Notifications carry no id and must not be answered.
  if (method?.startsWith("notifications/")) return null;

  if (method === "ping") return result(id, {});

  if (method === "tools/list") return result(id, { tools: [TOOL_DESCRIPTOR] });

  if (method === "tools/call") {
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (params.name !== ECHO_ASK_TOOL_NAME) {
      return error(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${String(params.name)}`, {
        available: [ECHO_ASK_TOOL_NAME],
      });
    }

    const outcome = await runAskTool(params.arguments, {
      source: "mcp",
      ask: deps.ask,
      signal: deps.signal,
      ensureConsent: deps.ensureConsent,
    });
    // A turn nobody answered is a tool-level failure, not a protocol error: the
    // model asked a question and needs to read what happened.
    return result(id, {
      content: [{ type: "text", text: outcome.text }],
      isError: outcome.isError,
    });
  }

  if (id === undefined || id === null) return null; // unknown notification
  return error(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${String(method)}`);
}

function cancelledRequestId(params: unknown): string | number | undefined {
  const requestId = typeof params === "object" && params !== null
    ? (params as { requestId?: unknown }).requestId
    : undefined;
  return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

/**
 * Serve MCP over stdio: one JSON message per line.
 *
 * Each message is dispatched without blocking the read loop. An ask holds the
 * microphone for the better part of a minute, and awaiting it here made `ping`
 * and `notifications/cancelled` structurally unreachable for that whole window:
 * the host could neither health-check the server nor call the turn off. JSON-RPC
 * correlates by id, so replies may come back in any order.
 *
 * stdout carries protocol traffic only. Diagnostics go to stderr, because a
 * stray log line on stdout is a parse error for the host.
 */
export async function runStdioServer(deps: McpServerDeps = {}): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  const inFlight = new Map<string | number, AbortController>();
  const pending = new Set<Promise<void>>();
  const sessionId = `mcp-${crypto.randomUUID()}`;
  const consent = new SessionConsent();
  consent.begin(sessionId);
  const requestConsent = deps.requestConsent ?? requestMcpSessionConsent;

  const send = (payload: object) => {
    // One write per message, and JSON.stringify escapes newlines inside strings,
    // so a multi-line transcript can never split one message into two.
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const dispatch = (message: JsonRpcRequest) => {
    const id = message.id;
    const answerable = id !== undefined && id !== null;
    const controller = new AbortController();
    if (answerable) inFlight.set(id, controller);

    const task = (async () => {
      try {
        const response = await handleMessage(message, {
          ...deps,
          signal: controller.signal,
          ensureConsent: deps.ensureConsent ?? (() => consent.ensure(sessionId, () => requestConsent(controller.signal))),
        });
        // A cancelled request gets no response, per the specification.
        if (response !== null && !controller.signal.aborted) send(response);
      } catch (thrown) {
        const detail = thrown instanceof Error ? thrown.message : String(thrown);
        console.error(`[echo-mcp] handler failed: ${detail}`);
        if (answerable && !controller.signal.aborted) {
          send(error(id, -32603, "Internal error", { detail }));
        }
      } finally {
        if (answerable) inFlight.delete(id);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line.length === 0) continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        // -32700 needs an id to answer against and a malformed line has none;
        // the host will time out its own request. Log and keep serving.
        console.error("[echo-mcp] ignoring unparseable line");
        continue;
      }

      // Cancellation is handled here rather than in the dispatcher because it
      // acts on another request, not on itself. Aborting reaches the recorder
      // through the ask tool's signal, so the microphone closes now.
      if (message.method === "notifications/cancelled") {
        const requestId = cancelledRequestId(message.params);
        if (requestId !== undefined) inFlight.get(requestId)?.abort();
        continue;
      }

      dispatch(message);
    }
  }

  // stdin closing does not entitle an in-flight ask to be dropped: the human may
  // already be speaking, and the recorder is a child of this process.
  await Promise.all([...pending]);
  consent.end();
}

if (import.meta.main) {
  await runStdioServer();
}
