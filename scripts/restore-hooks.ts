#!/usr/bin/env bun
/** Compatibility wrapper for the Claude Code adapter hook-registration script. */
await import(new URL("../adapters/claudecode/restore-hooks.ts", import.meta.url).href);
