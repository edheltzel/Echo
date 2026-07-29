#!/usr/bin/env bun
// Standalone entry for the echo-converse coordinator.
//
// Separate from server.ts on purpose: importing the server module must never
// start a listener, so tests can construct instances on ephemeral ports without
// a stray daemon appearing on :32468.
//
// There is no LaunchAgent for this capability. An always-on background service
// is exactly the topology the TCC spike ruled out for microphone work, and the
// coordinator is cheap enough to start on demand (converse/client.ts does it).

import { resolveConverseConfig } from "./config.ts";
import { createConverseServer } from "./server.ts";

const config = resolveConverseConfig();
const handle = createConverseServer({
  config,
  log: (line) => console.log(`[echo-converse] ${line}`),
});

console.log(`[echo-converse] coordinator listening on http://127.0.0.1:${handle.port}`);
console.log(`[echo-converse] core: ${config.coreBaseUrl} · booking lock: ${config.bookingLockPath}`);
console.log("[echo-converse] microphone-free by design: callers capture in their own process tree");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[echo-converse] ${signal} received, stopping`);
    handle.stop();
    process.exit(0);
  });
}
