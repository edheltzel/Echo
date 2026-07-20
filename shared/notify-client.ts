// Host-neutral notify client for Echo host adapters (Pi, omp, …). Adapters may
// import shared/, never core/. The `source` field is a free-form host tag the
// daemon records for context ("pi", "omp", "claudecode").

export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

/** The subset of a host adapter's voice config the notify client needs. */
export interface NotifyConfig {
  endpoint: string;
  title: string;
  voiceEnabled: boolean;
  voiceId?: string;
}

export interface NotifyPayload {
  message: string;
  title?: string;
  voice_id?: string;
  voice_enabled?: boolean;
  session_id?: string;
  source: string;
}

export interface NotifyResult {
  ok: boolean;
  status: number;
  body: string;
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

export async function sendNotification(
  config: NotifyConfig,
  message: string,
  source: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<NotifyResult> {
  const timeout = signalWithTimeout(signal, DEFAULT_NOTIFY_TIMEOUT_MS);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildNotifyPayload(config, message, source, sessionId)),
      signal: timeout.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } finally {
    timeout.cleanup();
  }
}
