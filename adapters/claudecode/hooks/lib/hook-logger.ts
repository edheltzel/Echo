/**
 * hook-logger.ts — Structured Hook Debug Logger
 *
 * PURPOSE:
 * Provides a centralized, structured logging utility for all adapter hooks.
 * Writes JSONL entries to MEMORY/HOOKS/hook-debug.jsonl for fast debugging.
 *
 * USAGE:
 *   import { hookLog } from './lib/hook-logger';
 *   hookLog('VoiceGreeting', 'SessionStart', 'skip: programmatic suppression');
 *   hookLog('VoiceGreeting', 'SessionStart', 'greeting sent', { pid: process.pid });
 *
 * DEBUG:
 *   tail -f ~/.claude/MEMORY/HOOKS/hook-debug.jsonl
 *   tail -f ~/.claude/MEMORY/HOOKS/hook-debug.jsonl | jq 'select(.hook == "VoiceGreeting")'
 *
 * PERFORMANCE:
 *   - Uses appendFileSync (non-blocking at OS level, synchronous in process)
 *   - ~0.1ms per call — negligible vs hook timeout budgets (5-90s)
 *   - Silently swallows errors to never crash the calling hook
 */

import { appendFileSync, mkdirSync } from 'fs';
import { paiPath } from './paths';

const HOOKS_LOG_DIR = paiPath('MEMORY', 'HOOKS');
const HOOKS_LOG_FILE = paiPath('MEMORY', 'HOOKS', 'hook-debug.jsonl');

let dirEnsured = false;

interface HookLogEntry {
  ts: string;
  hook: string;
  event: string;
  msg: string;
  meta?: Record<string, string | number | boolean | null>;
}

/**
 * Log a structured debug entry for a hook execution.
 *
 * @param hook - Hook name without extension (e.g., "VoiceGreeting")
 * @param event - Claude Code event type (e.g., "SessionStart", "Stop", "PreToolUse")
 * @param msg - Human-readable message describing what happened
 * @param meta - Optional key-value metadata (pid, source, voiceId, etc.)
 */
export function hookLog(hook: string, event: string, msg: string, meta?: Record<string, string | number | boolean | null>): void {
  try {
    if (!dirEnsured) {
      mkdirSync(HOOKS_LOG_DIR, { recursive: true });
      dirEnsured = true;
    }

    const entry: HookLogEntry = {
      ts: new Date().toISOString(),
      hook,
      event,
      msg,
    };
    if (meta) {
      entry.meta = meta;
    }

    appendFileSync(HOOKS_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Silent — never crash the calling hook
  }
}
