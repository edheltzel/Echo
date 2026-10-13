/**
 * OpenCode plugin entry. OpenCode loads this module and calls every exported
 * plugin function. The host-neutral notify path lives in handler.ts so tests
 * never need a running OpenCode process.
 *
 * Event surface (opencode.ai/docs/plugins + @opencode-ai/sdk 1.18 types):
 *   session.created  - new root session; says "Open code, ready." unless greet is disabled
 *   session.idle     — turn finished; speak last assistant text
 * Session.parentID marks a subagent; an unreadable session fails closed (silent).
 */
import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { handleOpenCodeEvent, isSpokenEvent } from "./handler.ts";
import { loadOpenCodeVoiceConfig } from "./config.ts";
import { sessionPortFromClient, type PluginClient } from "./session-port.ts";

// OpenCode calls every exported function as a plugin: export exactly one.
interface PluginInput {
  client?: PluginClient;
  directory?: string;
  worktree?: string;
}

export const EchoVoice = async (input: PluginInput = {}) => {
  const port = sessionPortFromClient(input.client);
  return {
    event: async ({ event }: { event: Record<string, unknown> }) => {
      // Every streamed chunk is an event; read config only for the two that speak.
      if (!isSpokenEvent(event)) return;
      const config = loadOpenCodeVoiceConfig(
        loadEchoEnvironment(),
        input.directory ?? input.worktree,
        undefined,
        input.worktree,
      );
      await handleOpenCodeEvent(event, config, port);
    },
  };
};
