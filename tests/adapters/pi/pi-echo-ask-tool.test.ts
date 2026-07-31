import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import atlasVoicePiAdapter from "../../../adapters/pi/index.ts";
import { loadPiVoiceConfig } from "../../../adapters/pi/config.ts";
import { ECHO_ASK_PARAMETERS, ECHO_ASK_TOOL_NAME } from "../../../converse/host-tool.ts";

// The Pi adapter's side of two-way voice: it registers the model-invokable
// echo_ask tool. The tool's behavior is covered in tests/converse/host-tool;
// what matters here is that this adapter registers it, that it survives a
// runtime without the tool API, and that the existing command surface is intact.
//
// No test here executes the tool: executing it would start a real turn.

interface Doubles {
  handlers: Map<string, unknown>;
  commands: Map<string, unknown>;
  tools: Map<string, Record<string, any>>;
  api: ExtensionAPI;
}

function mockHost(options: { withToolApi?: boolean } = {}): Doubles {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, Record<string, any>>();
  const api: Record<string, unknown> = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerCommand: (name: string, opts: unknown) => commands.set(name, opts),
  };
  if (options.withToolApi !== false) {
    api.registerTool = (definition: Record<string, any>) => tools.set(String(definition.name), definition);
  }
  return { handlers, commands, tools, api: api as unknown as ExtensionAPI };
}

describe("Pi adapter: echo_ask tool", () => {
  test("registers the shared ask tool", () => {
    const host = mockHost();

    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));

    const tool = host.tools.get(ECHO_ASK_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.parameters).toEqual(ECHO_ASK_PARAMETERS);
    expect(typeof tool!.execute).toBe("function");
  });

  test("a runtime without registerTool still gets the voice adapter", () => {
    const host = mockHost({ withToolApi: false });

    expect(() => atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}))).not.toThrow();

    expect(host.tools.size).toBe(0);
    // The notification path is the adapter's main job and must be unaffected.
    expect(host.handlers.has("message_end")).toBe(true);
    expect(host.commands.has("voice-status")).toBe(true);
  });

  test("the existing commands are still registered alongside the tool", () => {
    const host = mockHost();

    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));

    expect([...host.commands.keys()].sort()).toEqual(["echo-voice", "voice-status"]);
  });
});
