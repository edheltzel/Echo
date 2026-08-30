import { describe, expect, test } from "bun:test";
import { sessionPortFromClient } from "../../../adapters/opencode/plugin.ts";

describe("OpenCode plugin session client", () => {
  test("session.get uses the current SDK sessionID parameter first", async () => {
    const calls: unknown[] = [];
    const port = sessionPortFromClient({
      session: {
        get: async (input: unknown) => {
          calls.push(input);
          if (
            input &&
            typeof input === "object" &&
            "sessionID" in input &&
            (input as { sessionID: string }).sessionID === "ses_1"
          ) {
            return { data: { id: "ses_1", parentID: "ses_parent", title: "Main", agent: "build" } };
          }
          throw new Error("unsupported shape");
        },
      },
    });

    expect(await port.getSession("ses_1")).toEqual({
      id: "ses_1",
      parentID: "ses_parent",
      title: "Main",
      agent: "build",
    });
    expect(calls[0]).toEqual({ sessionID: "ses_1" });
  });

  test("falls back to the legacy path.id client shape", async () => {
    const port = sessionPortFromClient({
      session: {
        get: async (input: unknown) => {
          if (input && typeof input === "object" && "sessionID" in input) {
            throw new Error("current SDK shape unavailable");
          }
          if (
            input &&
            typeof input === "object" &&
            "path" in input &&
            (input as { path: { id: string } }).path?.id === "ses_legacy"
          ) {
            return { id: "ses_legacy" };
          }
          throw new Error("unsupported shape");
        },
      },
    });

    expect(await port.getSession("ses_legacy")).toEqual({
      id: "ses_legacy",
      parentID: undefined,
      title: undefined,
      agent: undefined,
    });
  });

  test("unknown session.get results fail closed", async () => {
    const port = sessionPortFromClient({
      session: {
        get: async () => {
          throw new Error("NotFoundError");
        },
      },
    });

    expect(await port.getSession("ses_missing")).toBeNull();
  });
});
