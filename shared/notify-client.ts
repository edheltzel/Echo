// Host-neutral notify client for Echo host adapters (Pi, omp, …). Adapters may
// import shared/, never core/. The `source` field is a free-form host tag the
// daemon records for context ("pi", "omp", "claudecode").

import {
  tryNativeVisual,
  type NativeVisualResult,
  type TerminalNotificationContext,
} from "./terminal-notify.ts";

export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

/** The subset of a host adapter's voice config the notify client needs. */
export interface NotifyConfig {
  endpoint: string;
  title: string;
  voiceEnabled: boolean;
  voiceId?: string;
  visualContext?: TerminalNotificationContext;
}

export interface NotifyPayload {
  message: string;
  title?: string;
  voice_id?: string;
  voice_enabled?: boolean;
  session_id?: string;
  source: string;
  visual_delivery?: "native";
  voice_settings?: Record<string, unknown>;
  volume?: number;
  [key: string]: unknown;
}

export interface NotifyResult {
  ok: boolean;
  status: number;
  body: string;
  /** Bounded native-route diagnostics; HTTP callers may ignore this field. */
  visual?: NativeVisualResult;
}

export function buildNotifyPayload(
  config: NotifyConfig,
  message: string,
  source: string,
  sessionId?: string,
): NotifyPayload {
  const payload: NotifyPayload = {
    message,
    title: config.title,
    voice_enabled: config.voiceEnabled,
    source,
  };
  if (config.voiceId) payload.voice_id = config.voiceId;
  if (sessionId) payload.session_id = sessionId;
  return payload;
}

function signalWithTimeout(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
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

export interface NotifyRequestConfig {
  endpoint: string;
  title?: string;
  visualContext?: TerminalNotificationContext;
}

async function postNotification(
  config: NotifyRequestConfig,
  payload: NotifyPayload,
  signal?: AbortSignal,
): Promise<NotifyResult> {
  let nativeResult: NativeVisualResult | undefined;
  const title = typeof payload.title === "string" ? payload.title : "Echo Notification";
  try {
    nativeResult = await tryNativeVisual(
      { title, body: payload.message },
      config.visualContext ?? {},
    );
  } catch {
    // Native delivery is an optimization over the existing POST. A router
    // failure must never prevent the daemon from receiving the notification.
  }

  const requestPayload = nativeResult?.status === "shown"
    ? { ...payload, visual_delivery: "native" as const }
    : payload;

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
    signal,
  });

  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    visual: nativeResult,
  };
}

export async function sendNotification(
  config: NotifyConfig,
  message: string,
  source: string,
  sessionId?: string,
  signal?: AbortSignal,
  visualContext?: TerminalNotificationContext,
): Promise<NotifyResult> {
  const timeout = signalWithTimeout(signal, DEFAULT_NOTIFY_TIMEOUT_MS);

  try {
    return await postNotification(
      { endpoint: config.endpoint, title: config.title, visualContext: visualContext ?? config.visualContext },
      buildNotifyPayload(config, message, source, sessionId),
      timeout.signal,
    );
  } finally {
    timeout.cleanup();
  }
}

/** POST an already-shaped host payload while retaining native visual routing. */
export async function sendNotificationPayload(
  config: NotifyRequestConfig,
  payload: NotifyPayload,
  signal?: AbortSignal,
  visualContext?: TerminalNotificationContext,
): Promise<NotifyResult> {
  const timeout = signalWithTimeout(signal, DEFAULT_NOTIFY_TIMEOUT_MS);
  try {
    return await postNotification(
      { ...config, visualContext: visualContext ?? config.visualContext },
      payload,
      timeout.signal,
    );
  } finally {
    timeout.cleanup();
  }
}
