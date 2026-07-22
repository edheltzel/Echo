// Single place that knows the daemon's address.
//
// Adapters talk to the daemon over HTTP and nothing else — they must not read its
// config files, and they must not each hard-code `localhost:8888`. Both the URL a
// host adapter POSTs to and the URLs it reads from derive from one base here, so a
// second daemon instance (a test instance on another port) is reachable by setting
// one variable instead of patching call sites.

export type EndpointEnv = Record<string, string | undefined>;

export const DEFAULT_DAEMON_BASE = "http://localhost:8888";

/**
 * Origin of the Echo daemon. `ECHO_DAEMON_URL` is the explicit knob; otherwise the
 * origin is taken from a configured `ECHO_NOTIFY_URL` (and its legacy aliases) so
 * the long-standing single-URL setups keep working unchanged.
 */
export function resolveDaemonBase(env: EndpointEnv): string {
  const explicit = env.ECHO_DAEMON_URL;
  if (explicit) return stripTrailingSlash(explicit);

  const notify = configuredNotifyUrl(env);
  if (notify) {
    try {
      return new URL(notify).origin;
    } catch {
      // A malformed override is not worth crashing a host session over.
    }
  }
  return DEFAULT_DAEMON_BASE;
}

/** `POST /notify` — where a host adapter sends a line to be spoken. */
export function resolveNotifyUrl(env: EndpointEnv): string {
  return configuredNotifyUrl(env) ?? `${resolveDaemonBase(env)}/notify`;
}

/** `GET /voices` — the daemon's read-only projection of its configured personas. */
export function resolveVoicesUrl(env: EndpointEnv): string {
  return `${resolveDaemonBase(env)}/voices`;
}

function configuredNotifyUrl(env: EndpointEnv): string | undefined {
  return env.ECHO_NOTIFY_URL ?? env.ATLAS_VOICE_NOTIFY_URL ?? env.VOICESYSTEM_NOTIFY_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
