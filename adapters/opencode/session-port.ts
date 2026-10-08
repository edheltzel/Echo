import { lastAssistantTextFromMessages, type OpenCodeSessionPort } from "./handler.ts";

// The plugin `client` is the v1 SDK (`createOpencodeClient`): every call takes
// `{ path: { id } }` and returns `{ data, error }` without throwing.
type SdkResult = { data?: unknown; error?: unknown };
export interface PluginClient {
  session?: {
    get?: (input: { path: { id: string } }) => Promise<SdkResult>;
    messages?: (input: { path: { id: string } }) => Promise<SdkResult>;
  };
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
