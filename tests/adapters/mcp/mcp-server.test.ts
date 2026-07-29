import { describe, expect, test } from "bun:test";
import { handleMessage, SUPPORTED_PROTOCOL_VERSIONS } from "../../../adapters/mcp/server.ts";
import { ECHO_ASK_PARAMETERS } from "../../../converse/host-tool.ts";

// The MCP server is Claude Code's only route to a two-way turn: its hooks are
// one-shot lifecycle interceptors with no channel for returning a transcript to
// the model. The wire shapes below are the published ones (specification
// 2025-11-25, lifecycle and tools), not remembered ones.
//
// No test here starts a real turn: `ask` is injected.

const askReturns = (text: string) => async () => ({
  text,
  turn_id: "t-1",
  engine: "yap" as const,
  capture_ms: 800,
  spoke: { notify_status: 202, drained: true, waited_ms: 900, polls: 1 },
  ancestry: ["900 bun", "800 wezterm-gui"],
});

describe("initialize", () => {
  test("answers with tool capability and server identity", async () => {
    const response: any = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe("2025-11-25");
    expect(response.result.capabilities.tools).toEqual({});
    expect(response.result.serverInfo.name).toBe("echo-converse");
    expect(response.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("answers an older client in its own version", async () => {
    const response: any = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    expect(response.result.protocolVersion).toBe("2024-11-05");
  });

  test("answers an unknown version with one this server does speak", async () => {
    const response: any = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1.0.0" },
    });

    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(response.result.protocolVersion);
  });

  test("notifications get no reply at all", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
  });
});

describe("tools/list", () => {
  test("advertises echo_ask with its input schema", async () => {
    const response: any = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(response.result.tools.length).toBe(1);
    const [tool] = response.result.tools;
    expect(tool.name).toBe("echo_ask");
    expect(tool.inputSchema).toEqual(ECHO_ASK_PARAMETERS);
    expect(tool.description).toContain("spoken answer");
  });
});

describe("tools/call", () => {
  test("returns the transcript as tool content", async () => {
    const response: any = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_ask", arguments: { question: "Ready?" } } },
      { ask: askReturns("yes, go ahead") },
    );

    expect(response.result.content).toEqual([{ type: "text", text: "yes, go ahead" }]);
    expect(response.result.isError).toBe(false);
  });

  test("a turn nobody answered is a tool error, not a protocol error", async () => {
    const response: any = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_ask", arguments: { question: "Ready?" } } },
      {
        ask: async () => {
          throw new Error("the recording contained no speech");
        },
      },
    );

    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("no speech");
  });

  test("an unknown tool name is an invalid-params error", async () => {
    const response: any = await handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "not_a_tool", arguments: {} },
    });

    expect(response.error.code).toBe(-32602);
    expect(response.error.data.available).toEqual(["echo_ask"]);
  });

  test("a call with no question is reported to the model, not thrown", async () => {
    const response: any = await handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo_ask", arguments: {} },
    });

    expect(response.result.isError).toBe(true);
  });
});

describe("unsupported methods", () => {
  test("ping is answered so a keepalive does not look like a dead server", async () => {
    const response: any = await handleMessage({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(response.result).toEqual({});
  });

  test("an unknown method is method-not-found", async () => {
    const response: any = await handleMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(response.error.code).toBe(-32601);
  });
});

// The dispatcher tests above prove the shapes; this one proves the transport,
// by running the real entry point and speaking to it the way a host does.
describe("stdio transport", () => {
  test("a spawned server completes a handshake and lists its tool", async () => {
    const child = Bun.spawn(["bun", "adapters/mcp/server.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    await child.stdin.flush();

    const lines: any[] = [];
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk as Uint8Array, { stream: true });
      for (const line of buffered.split("\n").slice(0, -1)) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      if (lines.length >= 2) break;
    }
    child.stdin.end();
    child.kill();

    // Exactly two replies for three messages: the notification is not answered.
    expect(lines.length).toBe(2);
    expect(lines[0].result.serverInfo.name).toBe("echo-converse");
    expect(lines[1].id).toBe(2);
    expect(lines[1].result.tools[0].name).toBe("echo_ask");
  }, 15_000);
});
