import type { NotifyPayload, NotifyResult } from "./types";

export const DEFAULT_NOTIFY_ENDPOINT = "http://localhost:3246/notify";
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

export function normalizeNotifyPayload(payload: NotifyPayload): NotifyPayload {
  const normalized: NotifyPayload = {
    message: payload.message,
  };

  if (payload.title) normalized.title = payload.title;
  if (payload.voice_enabled !== undefined) normalized.voice_enabled = payload.voice_enabled;
  if (payload.voice_id) normalized.voice_id = payload.voice_id;
  if (payload.voice_name) normalized.voice_name = payload.voice_name;
  if (payload.voice_settings) normalized.voice_settings = payload.voice_settings;
  if (payload.session_id) normalized.session_id = payload.session_id;
  if (payload.source) normalized.source = payload.source;
  if (payload.visual_delivery === "native") normalized.visual_delivery = "native";

  return normalized;
}

function signalWithTimeout(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function sendNotifyPayload(
  payload: NotifyPayload,
  endpoint = DEFAULT_NOTIFY_ENDPOINT,
  signal?: AbortSignal,
): Promise<NotifyResult> {
  const timeout = signalWithTimeout(signal, DEFAULT_NOTIFY_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizeNotifyPayload(payload)),
      signal: timeout.signal,
    });

    const body = await response.text();
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(body) as { request_id?: unknown };
      if (typeof parsed.request_id === "string") requestId = parsed.request_id;
    } catch {
      // Non-JSON responses are still useful to callers as raw body text.
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
      requestId,
    };
  } finally {
    timeout.cleanup();
  }
}
