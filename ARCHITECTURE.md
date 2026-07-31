# ARCHITECTURE - Echo

A codemap for agents. Start here to learn *where* things live and *what invariants*
to respect; drill into [`AGENTS.md`](AGENTS.md) for commands and the [`docs/`](docs/)
pages for per-area detail.

## Bird's-eye view

Echo is a Bun/TypeScript text-to-speech notification daemon built as a
**host-neutral core plus out-of-process host adapters**. One long-lived process
(`core/server.ts`) listens on `localhost:3246` by default and exposes the notification API plus
its opt-in playback-status and capture-reservation routes (`GET /notify/:request_id/completion`
and `POST /notify/capture-reservations/:reservation_id/{grant,release}`). Any host - a Claude Code
session, a Pi (`@earendil-works/pi-coding-agent`) or oh-my-pi (omp) session, or a raw `curl` -
observes its own lifecycle, extracts a short user-facing line (for Claude Code/Pi, the trailing
`🗣️` line), and POSTs it as JSON. The core sanitizes the text, resolves a voice, and
speaks it through a multi-provider TTS fallback chain (edge-tts → ElevenLabs → Kokoro →
macOS `say`) guarded by per-provider circuit breakers, then shows a macOS banner - unless
the adapter already delivered the visual notification natively (Herdr, or a supported
terminal's OSC escape sequence; `shared/terminal-notify.ts`), in which case it marks the
request `visual_delivery: "native"` and the daemon skips its own banner for that request.

```
  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
  │  Claude Code     │   │  Pi / oh-my-pi   │   │ curl / any   │
  │  (host)          │   │  (host)          │   │ HTTP client  │
  └────────┬─────────┘   └────────┬─────────┘   └──────┬───────┘
   lifecycle events        lifecycle events            │
  (PreToolUse, Session-   (session_start, message_end, │
   Start, Stop hook)       turn_end, session_shutdown) │
           │                       │                    │
  ┌────────▼─────────┐   ┌─────────▼────────┐          │
  │ adapters/        │   │  adapters/pi/    │          │
  │ claudecode/      │   │                  │          │
  │  hooks + restore │   │  index.ts ext    │          │
  └────────┬─────────┘   └─────────┬────────┘          │
           │   POST JSON {message, voice_id?, source, session_id?}
           └───────────────┬───────┴────────────────────┘
                           │  HTTP → http://localhost:3246/notify
              ┌────────────▼───────────────────────────────┐
              │   core/server.ts  (Bun serve, :3246)        │
              │   rate-limit → validate → sanitize →        │
              │   resolve voice → apply pronunciations →    │
              │   speakWithFallback (banner @ accept)       │
              └────────────┬────────────────────────────────┘
                           │  provider order = [default, ...fallback]
       ┌──────────┬────────┴────────┬──────────────┐
       │ edgetts  │  elevenlabs     │   kokoro      │   say
       │ (online) │ (api.eleven…)   │ (local :8880) │ (/usr/bin/say)
       └──────────┴─────────────────┴───────────────┘
                           ▼
                  AUDIO  +  macOS banner
```

First provider to return `true` wins. Notify failures are non-fatal to the host session
by contract - a down voice daemon never breaks an agent turn.

**The other direction.** `converse/` (`@echo/converse`) is a second host-neutral capability: it
speaks a question, captures the spoken reply, transcribes it locally and returns the text. It
uses an additive, opt-in playback completion and capture-reservation protocol in `core/`: the
ordinary `POST /notify` receipt contract remains unchanged, while converse waits on its own
request rather than inferring completion from aggregate queue health. The microphone-versus-
playback interlock also comes from converse *writing* the capture-state file
`core/capture-guard.ts` already reads - the arbitration core ships, used in reverse.

Its coordinator listens on `localhost:32468` and is microphone-free by design; the calling host
opens the microphone in its own process tree, because macOS attributes a microphone grant to the
responsible process and a background service gets none. That measurement, the turn sequence, the
endpoint contract and the v1 limits are in [docs/converse.md](docs/converse.md).

```
 Pi / omp (echo_ask tool)  Claude Code (adapters/mcp)  curl
              \                    |                  /
               \                   |                 /
                +--- POST /turn --> converse/ :32468 (books, speaks, waits)
                |                        |  POST /notify + exact completion/reservation
                |                        v
                |                   core/ :3246 (additive opt-in protocol)
                |                        ^
                +-- capture child --------+  writes recording-state.json,
                    (in the HOST's           so core holds its speech while
                     process tree)           the microphone is open
```

## The boundary that shapes everything

**`core/` never imports a host API.** No PAI, Pi, Claude Code, or OpenCode symbols reach
the daemon. All host coupling lives in `adapters/`, which talk to the core only over the
HTTP `/notify` contract. This is the rule that lets one daemon serve every host.

**Each adapter is self-contained.** `adapters/*` are workspace packages: every relative
import stays inside the package root, shared behavior comes from the `@echo/shared` package
each one declares as a dependency, and configuration comes over HTTP - never by reading the
daemon's `core/` files, which belong to a process that may run from another clone entirely.

The boundary is **mechanically enforced**, not just documented, and it is enforced in *both*
directions:

- `tests/core/no-host-strings.test.ts` greps every file under `core/` for
  `/PAI|Claude|\.claude|OpenCode|\bPi\b/` and fails CI if any appears.
- `tests/core/architecture-invariants.test.ts` scans imports out of `core/`, then scans each
  adapter package for relative imports that escape its root, undeclared dependencies, and
  `core/` filesystem paths. The last check is a string scan on purpose: the violation it
  replaced was a `readFileSync` of `core/voices.json`, which no import-based check can see.

`converse/` sits beside `core/`, not inside it, and has a source-checked split:
`tests/converse/architecture-invariants.test.ts` fails if the coordinator can import a capture
module or spawn any subprocess, if converse imports `core/`, or if it writes state to `/tmp`.
These scans catch direct source regressions; they do not enforce runtime process ancestry.

When you add code to `core/`, `converse/`, or an adapter, a boundary violation is a test failure,
not a review nit.

## Repo layout

| Area | Path | Role |
|---|---|---|
| Universal daemon | `core/server.ts` | The entire TTS engine: config load, sanitization, voice resolution, the four providers, the HTTP handler. |
| Provider circuit breaker | `core/circuit-breaker.ts` | Host-neutral per-provider failure tracking (see Cross-cutting). |
| Serial play queue | `core/play-queue.ts` | Global one-at-a-time playback (Phase 2): newest-per-session coalescing, age/depth caps, player watchdog, injected player. |
| TTS synthesis cache | `core/tts-cache.ts` | Short-phrase disk cache keyed by `(voice, rate, text)` - instant replay for repeated lines (#202). |
| Numeric env parsing | `core/env.ts` | `parseBoundedInt` - every numeric env knob flows through it; `resolveEchoEnv` - non-mutating config reads. |
| `@echo/shared` workspace package | `shared/` | Everything the daemon and the adapters both need, owned once. Sits below both: `core/` imports it, adapters declare it as a dependency, and it imports neither. Members: `echo-env.ts` (process-first configuration loading: `config.json`, then the legacy dotenv fallback), `notify-client.ts`, `terminal-notify.ts` (host-neutral native terminal visual routing: Herdr `notification.show` first, then a safe adapter-owned TTY writer for Ghostty/WezTerm OSC 777, Kitty OSC 99, or iTerm2 OSC 9 - Alacritty stays unsupported), `voice-line.ts`, `persona-scaffold.ts`, `greeting.ts`, `edge-voice.ts` (the edge-tts voice grammar `core/server.ts` also enforces), `daemon-endpoints.ts` (where the daemon lives). |
| Edge rate mapping | `core/edge-rate.ts` | Maps a `speed` multiplier to edge-tts `--rate`. |
| Runtime mute state | `core/mute.ts` | Persisted global mute with lazy expiry (#83); gates the provider loop. |
| Capture guard | `core/capture-guard.ts` | Skips voice lines while an external mic capture is live (reads the capture tool's published state file, pid-liveness checked). |
| Shared wire types/client | `core/types.ts`, `core/notify-client.ts` | `NotifyPayload`/`VoiceSettings`/`NotifyResult` and a reference POST client. |
| Voice + pronunciation config | `core/voices.json`, `core/pronunciations.json`, `core/voices-schema.json` | Provider toggles, per-agent voice map, pre-synthesis regex rules. |
| Claude Code adapter | `adapters/claudecode/` | Claude Code lifecycle hooks + a hook registrar. |
| Pi adapter | `adapters/pi/` | A Pi extension (`index.ts`) that injects + speaks the `🗣️` convention. |
| omp adapter | `adapters/omp/` | The same shape for the oh-my-pi (omp) fork - its own package since #109, sharing behavior through `@echo/shared`, not through `adapters/pi/`. |
| MCP adapter | `adapters/mcp/` | An MCP server exposing `echo_ask` plus its registrar. Claude Code's only route to a two-way turn: its hooks are one-shot lifecycle interceptors with no channel for returning a transcript to the model. |
| `@echo/converse` voice ask | `converse/` | The one-shot voice ask. Coordinator side (`server.ts`, `booking.ts`, `playback.ts`) books the microphone, speaks through core and waits for that request's exact playback completion, and never opens the microphone. Caller side (`client.ts`, `capture.ts`, `capture-state.ts`, `host-tool.ts`) records in the host's own process tree, transcribes locally (`yap` Tier 1, `whisper-cli` Tier 2) and publishes the capture state. Local contract: `converse/AGENTS.md`. |
| Lifecycle scripts | `scripts/{install,start,stop,restart,status,uninstall,mute}.sh` | Service install/lifecycle + runtime mute (#83); `install.sh --adapter <host>` delegates host registration to the adapter's own registrar/reconciler, and stages the daemon payload the LaunchAgent points at (see Invariants). |
| Shell port helper | `scripts/echo-port.sh` | Sourced by every lifecycle script and `cli/echo`: the port they talk to (`PORT` when exported, else 3246) and the shared occupied-port report, so no two surfaces can disagree. Reads the documented config port when no override is present. |
| Control CLI | `cli/echo` | The stable human surface - a bash wrapper over `scripts/*.sh` and the daemon HTTP API that reimplements no daemon logic. Bash on purpose: `echo doctor` must diagnose a *missing* Bun. Command list: `cli/echo --help` and [`AGENTS.md`](AGENTS.md). |
| Other scripts | `scripts/restore-hooks.ts`, `scripts/preview-voices.ts`, `scripts/set-default-voice.ts` | Compatibility wrapper for the Claude Code hook registrar; dev-only edge-voice audition (not on the runtime request path); the `echo voice` writer for the default pi/omp persona. |
| Tests | `tests/core/`, `tests/adapters/`, `tests/converse/`, `tests/scripts/`, `tests/shared/` | `bun test`, plus `tests/e2e-adapters.sh` and `tests/e2e-converse.sh`; see [`docs/development.md`](docs/development.md). |

## Request & voice-resolution flow

A `POST /notify` runs through `core/server.ts` roughly in this order:

1. **Rate-limit** - `checkRateLimit(clientIp)`: 10 requests per 60s per client IP, 429 on
   breach. With no proxy header, all local callers share one `localhost` bucket; the
   per-endpoint carve-outs are in [`docs/http-api.md`](docs/http-api.md).
2. **Validate + sanitize** - `validateInput` (non-empty string, ≤500 chars) then
   `sanitizeForSpeech` (strips `<script`, `../`, shell metacharacters, markdown). Invalid
   input is a 4xx **before** anything is queued.
3. **Banner + enqueue + ack `202`** - the macOS banner fires immediately at accept
   (outside the queue; a superseded/dropped line keeps its banner, and a
   `voice_enabled: false` request is banner-only and never queued), unless the request's
   exact `visual_delivery: "native"` marker says an adapter already showed the notification
   through a native terminal route. The validated VOICE
   line joins the global serial play queue (`core/play-queue.ts`) and the request returns
   immediately (`{status: "accepted", request_id}`). The queue's single consumer runs
   steps 4–6 one line at a time - a new line never plays over an in-flight one; queued
   lines coalesce newest-per-session and age out (dispositions recorded in the
   audio-lifecycle log), and a hung player is bounded by the queue's watchdog.
4. **Resolve the voice** - `getVoiceMapping(voice_id)` resolves the request's `voice_id`
   **name key** in order: (1) `agents` name key (e.g. `"themis"`), (2) any
   `elevenlabs.voice_id`, (3) `identity`, else the active provider's default. Callers send
   the **short name key**, never a raw provider voice id.
5. **Apply pronunciations** - `applyPronunciations` runs word-boundary regex replacements
   from `pronunciations.json` (re-applied per provider).
6. **Speak with fallback** - `speakWithFallback` first checks the runtime mute state
   (`core/mute.ts`, #83): while muted, speech is suppressed before the provider loop (one
   gate covers every provider including `say`) and the drop-off event is tagged `muted`.
   Otherwise it walks `[defaultProvider, ...fallbackOrder]`, skipping any provider that is
   disabled, unhealthy, or circuit-open, and returns the per-provider `attempts` trail plus
   the voice actually used (consumed by the drop-off log).

Full endpoint contract and request body: [`docs/http-api.md`](docs/http-api.md).
Voice config and the per-turn persona voice: [`docs/voices.md`](docs/voices.md).

## Cross-cutting concerns

### Circuit breaker (`core/circuit-breaker.ts`)
Tracks **provider** (synthesis/network) failures per TTS provider, opening after a shared
threshold (default **2**, floor 1; env `ECHO_CIRCUIT_BREAKER_THRESHOLD`) and
skipping that provider for a 60s cooldown before half-opening to retest. The attribution
rule is load-bearing: a **local playback** failure (afplay/mpv) is *not* a provider failure
and never opens the breaker - `EdgeTTSProvider.speak` splits online synthesis (governed,
retried) from local playback. The breaker map covers `edgetts`/`elevenlabs`/`kokoro`; `say`
is local and untracked. Knobs and latency math: [`docs/reliability.md`](docs/reliability.md).

### Egress gating (`getProviderStatus`, `speakWithFallback`)
A **disabled** provider makes **zero** outbound network calls - no synthesis and no
auth/health probe. The guarantee is structural: `speakWithFallback` `continue`s on
`!isEnabled()` before ever calling `isHealthy()`/`speak()`, and `getProviderStatus` only
probes `isHealthy()` when `enabled`. `/health` surfaces a per-provider **egress audit**
(`enabled`, `healthy`, `wouldEgress`, `egressTarget`) so the gating is auditable at a
glance. Note: edge-tts (the default) is Microsoft's **online** service, so the
out-of-the-box state *does* egress. Detail + the fully-local recipe:
[`docs/providers-observability.md`](docs/providers-observability.md).

### Voice-resolution drop-off log (issue #24)
The daemon appends **one structured JSONL event per voice-enabled `/notify`** recording why
a request used (or fell back from) its requested voice - `resolution`, `provider`, the
`attempts[]` trail, and `success`. It lives entirely in `core/server.ts`
(`writeResolutionEvent` + `pruneResolutionLog` + `classifyResolution`), writes to a
user-owned, size-capped file (never `/tmp`, never the repo), and is best-effort (a logging
error never breaks a `/notify`). Fields, path, and retention:
[`docs/providers-observability.md`](docs/providers-observability.md).

### Per-turn persona voice (Claude Code Stop hook)
Each turn, the Claude Code Stop hook `adapters/claudecode/hooks/VoiceCompletion.hook.ts` speaks the
response's trailing `🗣️ <Name>:` line. A single canonical parser `parseFinalVoiceLine`
(`adapters/claudecode/hooks/lib/TranscriptParser.ts`) feeds both voice selection and word
extraction, so the chosen voice and spoken words can never disagree. A non-DA persona
(e.g. `🗣️ Themis:`) is voiced by sending its lowercase name key as `voice_id`; the DA
(Atlas) path uses the main voice. It is DRY and self-cleaning - dropping a persona reverts
to Atlas automatically. Full mechanism: [`docs/voices.md`](docs/voices.md).

## Adapters

Adapters are **fully out-of-process**, import nothing from `core/`, and speak only the
daemon's HTTP contract (`POST /notify`, plus `GET /voices` to learn which persona keys
exist). Host lifecycle behavior remains independent: the Claude Code adapter
suppresses subagents via stdin `agent_id` and reads `~/.claude/settings.json` for identity;
Pi suppresses via `ECHO_VOICE_SUPPRESS` plus run-context (`hasUI === false`, or mode
`json`/`print`). The daemon and the adapters share code only through the `@echo/shared`
package - including the configuration loader (`shared/echo-env.ts`), so
`~/.config/echo/config.json` uses identical precedence in every process. The package boundary,
adapter responsibilities, and the Pi per-turn injection (#15):
[`docs/adapters.md`](docs/adapters.md).

## Invariants (must not do)

These are the rules an agent must not break. The first is mechanically enforced; the rest
are contract.

- **Never import a host API into `core/`** - no PAI, Pi, Claude Code, or OpenCode.
  Enforced by `tests/core/no-host-strings.test.ts`.
- **No new host-named endpoints.** The core exposes the host-neutral notification routes plus
  converse's opt-in completion and capture-reservation grant/release routes under `/notify/`.
  A reservation is released only by its caller-generated id, never by core's predictable
  request id. Unsupported POSTs return JSON 404 with `supported_endpoints`.
- **Do not change the `/notify` request/response contract** without an explicit
  compatibility plan - many callers depend on the body shape and status semantics.
- **All voice traffic is `:3246` by default.** No new `localhost:31337` references (the legacy Pulse
  port).
- **Never write process state to `/tmp`.** Use user-owned cache/log/config paths.
- **Do not broad-kill whatever owns port `3246`** - it may be another service.
- **Bun + TypeScript only.** No npm/npx/node workflows. Python only as the out-of-process
  `edge_tts` dependency.
- **Do not commit secrets or `.env` files.**
- **Do not push directly to `master`.** Work on `dev`, PR `dev` → `master`; Ed owns merges.
- **Adapters are out-of-process `/notify` clients** that suppress child/subagent contexts
  and treat notify failures as non-fatal.
- **The daemon runs from a staged payload, not the checkout** - so editing `core/`/`shared/`
  changes nothing until it is re-staged. Payload path and staging contract: [`AGENTS.md`](AGENTS.md).
- **Config loads once at startup** - editing `voices.json`/`pronunciations.json` requires a
  re-stage plus a daemon restart, which is what `cli/echo update` does.

The authoritative copy of the invariant list and the DOX rail lives in [`AGENTS.md`](AGENTS.md).

## Where to go next

| You want to… | Read |
|---|---|
| Build, test, and run | [`AGENTS.md`](AGENTS.md), [`docs/development.md`](docs/development.md) |
| Operate the installed service (start/stop/update/repo moves) | [`docs/operations.md`](docs/operations.md) |
| Configure JSON settings, migrate dotenv values, ports, and providers | [`docs/configuration.md`](docs/configuration.md) |
| Call or extend the HTTP API | [`docs/http-api.md`](docs/http-api.md) |
| Understand egress / observability | [`docs/providers-observability.md`](docs/providers-observability.md) |
| Tune reliability / circuit breaker | [`docs/reliability.md`](docs/reliability.md) |
| Add a voice or persona | [`docs/voices.md`](docs/voices.md) |
| Write or wire an adapter | [`docs/adapters.md`](docs/adapters.md) |
| Read the security model | [`SECURITY.md`](SECURITY.md) |
| See shipped design decisions | [`docs/design-docs/index.md`](docs/design-docs/index.md) |
