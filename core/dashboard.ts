// =============================================================================
// Local dashboard helpers (ATL-ECHO-SNOOZE-DASH-01, Slice 2)
// =============================================================================
//
// The daemon serves a static control page at http://localhost:<port>/ (loopback
// only, no new port). This module holds the two pieces of logic that page
// needs from the server: the same-origin write guard and the read-only,
// secret-free config view. The page itself is core/dashboard.html.

import { readFileSync } from "node:fs";

/**
 * Same-origin write guard for the controls the dashboard drives
 * (/mute, /mode, /replay). Not authentication - it only stops a page on
 * another origin from POSTing through the user's browser.
 *
 * - No Origin and no Referer (curl, CLI, host adapters): allowed, unchanged.
 * - Origin present: must be http://localhost:<port> or http://127.0.0.1:<port>.
 * - Origin absent, Referer present: the Referer's origin must match likewise.
 */
export function isSameOriginWrite(origin: string | null, referer: string | null, port: string): boolean {
  const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  if (origin) return allowed.has(origin);
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return true;
}

const SECRET_KEY = /key|token|secret|password|passwd|auth|credential/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Read-only config view: config.json only (never `.env`), with any key that
 * looks secret redacted. Missing or invalid files report that instead.
 */
export function readDashboardConfig(path: string): { path: string; present: boolean; config: unknown; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { path, present: false, config: null };
  }
  try {
    return { path, present: true, config: redact(JSON.parse(raw)) };
  } catch {
    return { path, present: true, config: null, error: "config.json is not valid JSON" };
  }
}
