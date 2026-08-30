/**
 * OpenCode plugin entry. OpenCode loads this module and calls every exported
 * plugin function. The host-neutral notify path lives in handler.ts so tests
 * never need a running OpenCode process.
 *
 * Event surface (opencode.ai/docs/plugins + @opencode-ai/schema):
 *   session.created  — new session; greeting is opt-in
 *   session.idle     — turn finished; speak last assistant text
 * Session.parentID marks a subagent; unknown parentID fails closed (silent).
 */
import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { handleOpenCodeEvent, lastAssistantTextFromMessages, type OpenCodeSessionPort } from "./handler.ts";
import { loadOpenCodeVoiceConfig } from "./config.ts";

interface PluginClient {
  session?: {
    get?: (input: unknown) => Promise<unknown>;
    messages?: (input: unknown) => Promise<unknown>;
  };
}

interface PluginInput {
  client?: PluginClient;
  directory?: string;
  worktree?: string;
}

async function callSession(
  client: PluginClient | undefined,
  method: "get" | "messages",
  sessionID: string,
): Promise<unknown> {
  const fn = client?.session?.[method];
  if (!fn) return undefined;
  const shapes: unknown[] = [{ sessionID }, { path: { id: sessionID } }, sessionID];
  for (const args of shapes) {
    try {
      return await fn(args);
    } catch {
      continue;
    }
  }
  return undefined;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

export function sessionPortFromClient(client: PluginClient | undefined): OpenCodeSessionPort {
  return {
    async getSession(id) {
      const raw = unwrap(await callSession(client, "get", id));
      if (!raw || typeof raw !== "object") return null;
      const record = raw as Record<string, unknown>;
      return {
        id: typeof record.id === "string" ? record.id : id,
        parentID: typeof record.parentID === "string" ? record.parentID : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        agent: typeof record.agent === "string" ? record.agent : undefined,
      };
    },
    async lastAssistantText(id) {
      return lastAssistantTextFromMessages(unwrap(await callSession(client, "messages", id)));
    },
  };
}

export async function EchoVoice(input: PluginInput = {}) {
  const port = sessionPortFromClient(input.client);
  return {
    event: async ({ event }: { event: Record<string, unknown> }) => {
      const config = loadOpenCodeVoiceConfig(loadEchoEnvironment(), input.directory ?? input.worktree);
      await handleOpenCodeEvent(event, config, port);
    },
  };
}

export default EchoVoice;
