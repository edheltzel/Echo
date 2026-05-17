# atlas-voicesystem

Standalone, multi-provider TTS notification server. Currently ships with PAI integration as the primary host, but the server itself is host-agnostic — any local process that can POST JSON to `localhost:8888/notify` can speak. Lives outside `~/.claude/` so it survives upstream PAI updates; symlinked into `~/.claude/PAI/USER/Voice/` via GNU Stow.

> **Status:** v0.1 working installation. The architectural direction is to **decouple from PAI entirely** and make the server a universal TTS notification primitive that coding agents, terminals, scripts, and future harnesses (Pi, OpenCode) consume. See **Roadmap** below.

## Architecture (short version)

- **server.ts** — Bun daemon on port 8888 with provider chain: edge-tts → elevenlabs → kokoro → say. Per-provider circuit breakers. Free-tier resilient (falls through 402s to next provider, ends at `say` floor).
- **voices.json** — single source of truth for provider config + per-agent voice mappings.
- **pronunciations.json** — word-boundary regex replacements (Kai → Kye, PAI → pie, ISC → I S C).
- **hooks/** — PAI session lifecycle integration (will become *one of many* host adapters): VoiceGate (subagent flood protection), VoiceGreeting (SessionStart catchphrase), VoiceNotification (Stop-phase 🗣️ speaker).
- **LaunchAgent** at `~/Library/LaunchAgents/com.pai.voice-server.plist` (created by `install.sh`).

## Stow layout

```
~/Developer/atlas-voicesystem/        ← project root (this repo)
├── README.md                          ← project docs (not stowed)
├── MIGRATIONS.md                      ← PAI-core edits to re-apply after upstream updates
└── claudecode/                        ← Stow package
    └── .claude/PAI/USER/Voice/        ← live voice system (real files)
```

Stow into home: `cd ~/Developer/atlas-voicesystem && stow -v -t ~ claudecode`
Unstow: `stow -v -t ~ -D claudecode`

After stow, `~/.claude/PAI/USER/Voice` is a directory symlink pointing here.

## Operation

```bash
# Install LaunchAgent (run from the canonical path so plist references real paths)
bash ~/Developer/atlas-voicesystem/claudecode/.claude/PAI/USER/Voice/install.sh

# Health
curl http://localhost:8888/health | jq

# Speak
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'

# Stop / Start / Restart
bash ~/.claude/PAI/USER/Voice/{stop,start,restart,status}.sh
```

## Patches applied (vs. original backup)

1. **server.ts:143-147** — added `~/.config/PAI/.env` to env-search paths (PAI v5+ env location).
2. **server.ts:455-460** — tightened `escapeForAppleScript` to also collapse newlines/returns/tabs (RedTeam PT-1: AppleScript injection defense).
3. **hooks/handlers/VoiceNotification.ts** — inlined the `ParsedTranscript` type that previously imported from `skills/PAI/Tools/TranscriptParser` (source no longer exists in current PAI).

See MIGRATIONS.md for the PAI-core integration edits that must be re-applied after every upstream PAI release.

## Investigation log — phantom-voice / zombie-session race (2026-05-16)

After migrating from the failing Pulse → ElevenLabs path to the working edge-tts server, voice began firing during periods of perceived inactivity. Hypothesis: race between zombie/stale claude sessions and the new audible TTS pipeline.

**Diagnostic methodology.** A behaviour-neutral patch added per-request caller resolution to `server.ts`: source TCP port → `lsof -nP -iTCP:<port>` → PID → six-level `ps -p` ancestry walk → structured append to `~/.claude/PAI/MEMORY/VOICE/voice-callers.jsonl`. No drops, no gates, no false silences — pure observability. Patch later reverted (`git checkout`) once findings were captured.

**Stress test.** A herdr workspace with 2 tabs × 2 panes spawned 4 parallel claude sessions on the same `cd && claude` dispatch. Server log captured four `[🎯 focused] Atlas, standing by.` calls within **315 ms** (`req-20` → `req-23`). `afplay` serialised the audio across 4.6 s of wall-clock with no overlap, no drops, no crash. The diagnostic captured per-event ancestry chains rooted at the user's terminal multiplexer in every legitimate case; the only `ppid:1` (orphan-style) signature observed was the *intended* Pulse cron alert from `CostTracker.ts`.

**Conclusion.** No race condition. The "Atlas talking with no session" perception decomposes into two real, separable phenomena, neither of which is a bug:

1. **Autonomous voice from Pulse cron** (CostTracker, DA morning brief) — fires on schedule with no claude session involved, exactly as designed.
2. **Per-instance SessionStart greeting** — every fresh `claude` window legitimately greets on startup, so N background claude windows produce N "Atlas, standing by" announcements. Previously masked by ElevenLabs 402/502 failures; now audible because edge-tts works.

The architecture is sound. Further work is about *fit* (universal voice server, multi-host adapters) and *ergonomics* (presence detection, debounce, configurability), not correctness.

## Roadmap

Tracked as GitHub issues on this repo. High-level themes:

1. **PAI-independence / universal voice server** — the server should not import or assume PAI; PAI integration becomes an external adapter package.
2. **Pi-extension** + Claude-Code-agnostic adapters — first non-PAI consumer.
3. **NPM package** — pair with pi-extension for easier installation across hosts.
4. **Dependency graph / flowchart** — document required vs. optional third-party systems (edge-tts, Ollama, ElevenLabs, macOS `say`, Kokoro).
5. **Local dev / testing / installation docs** — possibly using `vp`.
6. **Dual install/config docs** — separate sections for humans and for AI agents working on this codebase.
7. **Contribution guidelines.**

See the [GitHub issues](https://github.com/edheltzel/atlas-voicesystem/issues) for current status, dependencies, and acceptance criteria.
