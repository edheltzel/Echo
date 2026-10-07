/**
 * OpenCode plugin entry. OpenCode loads this module and calls every exported
 * plugin function. The host-neutral notify path lives in handler.ts so tests
 * never need a running OpenCode process.
 *
 * Event surface (opencode.ai/docs/plugins + @opencode-ai/sdk 1.18 types):
 *   session.created  — new session; greeting is opt-in
 *   session.idle     — turn finished; speak last assistant text
 * Session.parentID marks a subagent; an unreadable session fails closed (silent).
 */
import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { handleOpenCodeEvent, lastAssistantTextFromMessages, type OpenCodeSessionPort } from "./handler.ts";
import { loadOpenCodeVoiceConfig } from "./config.ts";

// The plugin `client` is the v1 SDK (`createOpencodeClient`): every call takes
// `{ path: { id } }` and returns `{ data, error }` without throwing.
type SdkResult = { data?: unknown; error?: unknown };
interface PluginClient {
  session?: {
    get?: (input: { path: { id: string } }) => Promise<SdkResult>;
    messages?: (input: { path: { id: string } }) => Promise<SdkResult>;
  };
}

interface PluginInput {
  client?: PluginClient;
  directory?: string;
  worktree?: string;
}

async function sessionData(
  client: PluginClient | undefined,
  method: "get" | "messages",
  id: string,
): Promise<unknown> {
  try {
    return (await client?.session?.[method]?.({ path: { id } }))?.data;
  } catch {
    return undefined;
  }
}

export function sessionPortFromClient(client: PluginClient | undefined): OpenCodeSessionPort {
  return {
    async getSession(id) {
      const raw = await sessionData(client, "get", id);
      if (!raw || typeof raw !== "object") return null;
      const record = raw as Record<string, unknown>;
      return {
        id: typeof record.id === "string" ? record.id : id,
        parentID: typeof record.parentID === "string" ? record.parentID : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
      };
    },
    async lastAssistantText(id) {
      return lastAssistantTextFromMessages(await sessionData(client, "messages", id));
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
