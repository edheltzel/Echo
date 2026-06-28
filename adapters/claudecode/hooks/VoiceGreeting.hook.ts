#!/usr/bin/env bun
/**
 * VoiceGreeting.hook.ts - Speak catchphrase at Session Start (async)
 *
 * PURPOSE:
 * Sends voice notification with the startup catchphrase from settings.json.
 * Runs as an async hook so it doesn't block session startup.
 *
 * For named subagents (Intern, Engineer, etc.), announces with THAT agent's
 * voice settings instead of Atlas's — giving each agent a distinct audio identity.
 *
 * TRIGGER: SessionStart (async: true)
 *
 * SIDE EFFECTS:
 * - Sends HTTP request to voice server (fire-and-forget)
 * SUBAGENT DETECTION (layered):
 * 0. PAI_SUPPRESS_VOICE=true → skip (programmatic claude spawning, e.g., SessionExtract)
 * 1. CLAUDE_CODE_AGENT_TASK_ID is set → skip (Task tool subagents)
 * 2. CLAUDE_AGENT_TYPE === "loop-worker" → skip (algorithm.ts workers)
 * 3. CLAUDE_PROJECT_DIR contains /.claude/Agents/ → skip
 * 4. Source check via stdin JSON — ONLY greet when source="startup" is confirmed.
 *    If stdin parsing fails (source="unknown"), we do NOT greet (safe default).
 * 5. CLAUDE_AGENT_TYPE is a named agent (Intern, Engineer, etc.) → agent voice
 *
 * PERFORMANCE:
 * - Async: Yes (runs in background, doesn't block startup)
 * - Uses Bun.file().json() for native file reads (faster than readFileSync + JSON.parse)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { hookLog } from './lib/hook-logger';
import { getIdentity } from './lib/identity';

const CLAUDE_DIR = join(process.env.HOME!, '.claude');
const NOTIFY_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Layer 0: Programmatic voice suppression (e.g., SessionExtract.ts spawned claude) ───
// When a hook spawns a new Claude Code process programmatically, it should set
// PAI_SUPPRESS_VOICE=true to prevent duplicate voice greetings. This takes precedence
// over all other checks.
if (process.env.PAI_SUPPRESS_VOICE === 'true') {
  hookLog('VoiceGreeting', 'SessionStart', 'skip: PAI_SUPPRESS_VOICE=true');
  console.error('[VoiceGreeting] skip: programmatic suppression (PAI_SUPPRESS_VOICE=true)');
  process.exit(0);
}

// ── Layer 1: Skip Task tool subagents ────────────────────────────────────────
if (process.env.CLAUDE_CODE_AGENT_TASK_ID) {
  hookLog('VoiceGreeting', 'SessionStart', 'skip: task-agent', { taskId: process.env.CLAUDE_CODE_AGENT_TASK_ID });
  console.error(`[VoiceGreeting] skip: task-agent (${process.env.CLAUDE_CODE_AGENT_TASK_ID})`);
  process.exit(0);
}

// ── Layer 2: Skip loop-workers (algorithm.ts spawned workers) ─────────────────
const agentType = process.env.CLAUDE_AGENT_TYPE;

if (agentType === 'loop-worker') {
  console.error('[VoiceGreeting] skip: loop-worker');
  process.exit(0);
}

// ── Layer 3: Skip for Agents/ path-based subagents ────────────────────────────
const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
if (claudeProjectDir.includes('/.claude/Agents/')) {
  console.error(`[VoiceGreeting] skip: agents-path (${claudeProjectDir})`);
  process.exit(0);
}

// ── Named agent types that get their own voice announcement ──────────────────
const NAMED_AGENT_TYPES = [
  'Algorithm', 'Architect', 'Artist', 'ClaudeResearcher', 'CodexResearcher',
  'Designer', 'Engineer', 'GeminiResearcher', 'GrokResearcher', 'Intern',
  'Pentester', 'PerplexityResearcher', 'QATester', 'Themis',
];

const isNamedAgent = agentType != null && NAMED_AGENT_TYPES.includes(agentType);

// ── Layer 4: Source check (confirmed startup only) ───────────────────────────
// Claude Code passes { source } in stdin JSON. Only greet when source is
// confirmed as "startup". If stdin parsing fails (async hook timeout),
// source stays "unknown" and we skip — false silence beats duplicate greetings.
let hookSource = 'unknown';
let hookSessionId: string | undefined;
try {
  const reader = Bun.stdin.stream().getReader();
  let raw = '';
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value, { stream: true });
    }
  })();
  await Promise.race([read, new Promise<void>(r => setTimeout(r, 1000))]);
  if (raw.trim()) {
    const input = JSON.parse(raw);
    hookSource = input.source || 'unknown';
    hookSessionId = input.session_id || input.sessionId || undefined;
  }
} catch {
  // stdin parse failed — expected for async hooks
}

hookLog('VoiceGreeting', 'SessionStart', `source="${hookSource}"`, { pid: process.pid });
console.error(`[VoiceGreeting] source="${hookSource}", pid=${process.pid}`);

// Only greet on confirmed startup — never on unknown source.
// The settings.json matcher already filters to "startup" events, but async hooks
// may fail to parse stdin (1s timeout), leaving source as "unknown". In that case,
// we DON'T greet — false silence is better than duplicate greetings.
if (hookSource !== 'startup') {
  hookLog('VoiceGreeting', 'SessionStart', `skip: source="${hookSource}" (not startup)`);
  console.error(`[VoiceGreeting] skip: source="${hookSource}" (only greeting on confirmed startup)`);
  process.exit(0);
}

// ── Parse simple YAML frontmatter from an agent .md file ──────────────────────
interface AgentFrontmatter {
  voiceId?: string;
  voice?: {
    stability?: string;
    similarity_boost?: string;
    style?: string;
    speed?: string;
    use_speaker_boost?: string;
    volume?: string;
  };
  persona?: {
    name?: string;
    title?: string;
  };
}

function parseAgentFrontmatter(content: string): AgentFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentObj: Record<string, any> | null = null;

  for (const line of lines) {
    const indent = (line.match(/^(\s*)/)?.[1].length) ?? 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (indent === 0) {
      if (val) {
        // Simple scalar — strip surrounding quotes
        result[key] = val.replace(/^["']|["']$/g, '');
        currentKey = '';
        currentObj = null;
      } else {
        // Nested object
        result[key] = {};
        currentKey = key;
        currentObj = result[key] as Record<string, any>;
      }
    } else if (currentObj) {
      if (val) {
        currentObj[key] = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result as AgentFrontmatter;
}

// ── Agent voice announcement ───────────────────────────────────────────────────
if (isNamedAgent && agentType) {
  try {
    // Read Atlas voice ID as fallback (from settings.json)
    const settings = await Bun.file(join(CLAUDE_DIR, 'settings.json')).json();
    const atlasVoiceId: string =
      settings.daidentity?.voices?.main?.voiceId ||
      settings.daidentity?.voiceId ||
      '';

    // Read agent .md frontmatter
    const agentFile = join(CLAUDE_DIR, 'agents', `${agentType}.md`);
    let fm: AgentFrontmatter = {};
    try {
      const agentContent = readFileSync(agentFile, 'utf-8');
      fm = parseAgentFrontmatter(agentContent);
    } catch (err) {
      console.error(`[VoiceGreeting] agent_file_fail: ${agentType} - ${err}`);
    }

    // Resolve voice ID: use agent's own if real, else fall back to Atlas
    const PLACEHOLDER = 'YOUR_VOICE_ID_HERE';
    const voiceId = (fm.voiceId && fm.voiceId !== PLACEHOLDER)
      ? fm.voiceId
      : atlasVoiceId;

    // Build announcement message using agent's persona name if available
    const personaName = fm.persona?.name;
    const message = personaName
      ? `${personaName}, standing by`
      : `${agentType} online`;

    // Build voice_settings from agent frontmatter (gives each agent a distinct sound)
    const voice = fm.voice;
    const voice_settings = voice ? {
      stability: parseFloat(voice.stability ?? '0.5'),
      similarity_boost: parseFloat(voice.similarity_boost ?? '0.8'),
      style: parseFloat(voice.style ?? '0.5'),
      speed: parseFloat(voice.speed ?? '1.0'),
    } : undefined;

    const body: Record<string, unknown> = {
      message,
      title: `${agentType} ready`,
      source: 'claudecode',
    };
    if (hookSessionId) body.session_id = hookSessionId;
    if (voiceId) body.voice_id = voiceId;
    if (voice_settings) body.voice_settings = voice_settings;

    console.error(`[VoiceGreeting] speaking: "${message}" (agent: ${agentType})`);
    const t0 = Date.now();
    const resp = await fetchWithTimeout('http://localhost:8888/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.error(`[VoiceGreeting] fetch_ok: ${resp.status} in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[VoiceGreeting] agent_voice_fail: ${err}`);
  }

  process.exit(0);
}

// ── Atlas greeting (main session) ─────────────────────────────────────────────
try {
  // Bun.file().json() is faster than readFileSync + JSON.parse:
  // uses Bun's native C++ file I/O and SIMD JSON parser
  const settings = await Bun.file(join(CLAUDE_DIR, 'settings.json')).json();

  // Resolve the DA name through identity.ts (the single source of truth); it falls back to
  // the neutral DEFAULT_IDENTITY when settings.json has no daidentity — never assuming a name.
  const daName = getIdentity().displayName;

  const catchphrases = settings.daidentity?.startupCatchphrases;
  const catchphrase = (
    catchphrases?.length
      ? catchphrases[Math.floor(Math.random() * catchphrases.length)]
      : settings.daidentity?.startupCatchphrase || `${daName} standing by`
  ).replace(/\{name\}/gi, daName);
  const personality = settings.daidentity?.personality;

  const url = personality?.baseVoice
    ? 'http://localhost:8888/notify/personality'
    : 'http://localhost:8888/notify';

  const body: Record<string, unknown> = personality?.baseVoice
    ? {
        message: `[🎯 focused] ${catchphrase}`,
        title: `${daName} says`,
        source: 'claudecode',
        personality: {
          name: daName.toLowerCase(),
          base_voice: personality.baseVoice,
          enthusiasm: personality.enthusiasm,
          energy: personality.energy,
          expressiveness: personality.expressiveness,
          resilience: personality.resilience,
          composure: personality.composure,
          optimism: personality.optimism,
          warmth: personality.warmth,
          formality: personality.formality,
          directness: personality.directness,
          precision: personality.precision,
          curiosity: personality.curiosity,
          playfulness: personality.playfulness,
        },
      }
    : { message: catchphrase, title: `${daName} says`, source: 'claudecode', play: true };

  if (hookSessionId) body.session_id = hookSessionId;

  hookLog('VoiceGreeting', 'SessionStart', `speaking: "${catchphrase}"`, { url, pid: process.pid });
  console.error(`[VoiceGreeting] speaking: "${catchphrase}" via ${url}`);
  const t0 = Date.now();
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.error(`[VoiceGreeting] fetch_ok: ${resp.status} in ${Date.now() - t0}ms`);
} catch (err) {
  console.error(`[VoiceGreeting] atlas_voice_fail: ${err}`);
}
