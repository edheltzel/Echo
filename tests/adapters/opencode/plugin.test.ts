import { describe, expect, test } from "bun:test";
import * as pluginModule from "../../../adapters/opencode/plugin.ts";
import { sessionPortFromClient } from "../../../adapters/opencode/session-port.ts";

// OpenCode invokes every exported function as a plugin; a second export would
// register a second event hook and speak every line twice.
test("plugin entry exports exactly one plugin function", () => {
  expect(Object.keys(pluginModule)).toEqual(["EchoVoice"]);
});

// Fakes follow @opencode-ai/sdk v1: `{ path: { id } }` in, `{ data, error }` out, no throw.
describe("OpenCode plugin session client", () => {
  test("reads session and messages through path.id and unwraps data", async () => {
    const calls: unknown[] = [];
    const port = sessionPortFromClient({
      session: {
        get: async (input) => {
          calls.push(input);
          return { data: { id: input.path.id, parentID: "ses_parent", title: "t" } };
        },
        messages: async (input) => {
          calls.push(input);
          return {
            data: [
              { info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
              { info: { role: "assistant", id: "msg_7" }, parts: [{ type: "text", text: "🗣️ OpenCode: Done with the fix." }] },
            ],
          };
        },
      },
    });

    expect(await port.getSession("ses_1")).toEqual({ id: "ses_1", parentID: "ses_parent", title: "t" });
    expect(await port.lastAssistant("ses_1")).toEqual({ id: "msg_7", text: "🗣️ OpenCode: Done with the fix." });
    expect(calls).toEqual([{ path: { id: "ses_1" } }, { path: { id: "ses_1" } }]);
  });

  test("an error result or a throwing client fails closed", async () => {
    const errorPort = sessionPortFromClient({
      session: {
        get: async () => ({ error: { name: "NotFoundError" } }),
        messages: async () => ({ error: { name: "NotFoundError" } }),
      },
    });
    expect(await errorPort.getSession("ses_x")).toBeNull();
    expect(await errorPort.lastAssistant("ses_x")).toEqual({ text: "" });

    const throwingPort = sessionPortFromClient({
      session: {
        get: async () => {
          throw new Error("socket closed");
        },
      },
    });
    expect(await throwingPort.getSession("ses_x")).toBeNull();
  });
});
