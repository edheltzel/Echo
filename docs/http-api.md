# HTTP API

The universal core (`core/server.ts`) listens on `localhost:3246` by default (override: `PORT`) and
exposes five endpoints. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for where this sits
in the request flow, [`../SECURITY.md`](../SECURITY.md) for the trust boundary, and
[`configuration.md`](configuration.md) for the config the server reads at startup.

**Rate limit:** 10 requests per 60s per client; exceeding it returns
`429 {"status":"error","message":"Rate limit exceeded"}`. All local callers share one
`localhost` bucket, with two carve-outs that each get their own:

- `POST /mute` - so a notification flood can never starve the mute control (#83).
- `GET /voices` - adapters read it once per turn immediately before that turn's `/notify`.
  On the shared bucket that would halve every host's notification budget and let the read
  starve the write it precedes.

## `POST /notify`

Primary host-neutral endpoint. Body (every field optional):

```json
{
  "title": "Voice Notification",
  "message": "Task complete",
  "voice_enabled": true,
  "voice_id": "kai",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0,
    "use_speaker_boost": true
  },
  "session_id": "host-session-id",
  "source": "pi",
  "visual_delivery": "native",
  "await_playback": false,
  "capture_bypass_nonce": "per-turn secret from the capture owner's own state file"
}
```

| Field | Default | Notes |
|---|---|---|
| `title` | `Voice Notification` (`ECHO_DEFAULT_TITLE`) | macOS notification title |
| `message` | `"Task completed"` | The spoken/displayed text |
| `voice_enabled` | `true` | `false` = silent (notification only, no TTS, **no resolution-log event**) |
| `voice_id` | - (identity voice) | Short persona **name key** (e.g. `"themis"`), not a raw provider voice id - resolution order and traps in [`voices.md`](voices.md). `voice_name` is accepted as an alias; `voice_id` wins when both are present |
| `voice_settings` | - | Pass-through override, see below |
| `session_id`, `source` | - | Echoed into the daemon log for correlation |
| `visual_delivery` | - | Only the exact value `"native"` is recognized; an adapter sets it after it has already shown the notification through a native terminal route (Herdr, or a supported terminal's OSC sequence - see `shared/terminal-notify.ts`), and the daemon skips its own macOS banner for that request. Any other value, or omitting the field, keeps the legacy banner - raw HTTP callers are unaffected |
| `await_playback` | `false` | Only the exact value `true` is recognized. Holds the response open until this line reaches a terminal disposition and answers `200` with it instead of `202` on receipt - see [Awaiting one line's playback](#awaiting-one-lines-playback) |
| `capture_bypass_nonce` | - | Speaks this one line even while the capture guard holds, but only when the string equals the `nonce` the capture owner published in its own state file. A missing, empty, stale or wrong value is held exactly as before, never an error, and a capture published without a nonce cannot be bypassed at all. Why the nonce and not the pid: [`../SECURITY.md`](../SECURITY.md) |

### Native terminal visual delivery

Host adapters attempt visual delivery before they POST to `/notify`, in this order:

1. Herdr's `notification.show` route, when the adapter has a documented Herdr session or
   socket context and Herdr returns `shown: true`.
2. The adapter's explicitly owned controlling TTY, using the terminal protocol selected from
   its environment.
3. The normal `/notify` request without `visual_delivery: "native"`; the daemon then uses its
   macOS `osascript` notification as the final visual fallback.

The native marker is an exact success contract. It is added only after route 1 or 2 reports
`status: "shown"`; the daemon then suppresses its own AppleScript banner, so one native
success produces one visual notification. A failed, unavailable, unsupported, headless, or
unproven route never receives the marker and preserves the legacy fallback.

Supported terminal protocols and limits:

| Terminal | Route | Limit |
|---|---|---|
| Ghostty | OSC 777 | Requires Ghostty terminal identity. |
| WezTerm | OSC 777 | Requires `TERM_PROGRAM_VERSION` as well as WezTerm identity. |
| Kitty | OSC 99 | Recognized route; delivery counts as `shown` on a successful write, with no capability-query negotiation (verified live against Kitty 0.48.1). |
| iTerm2 | OSC 9 | Uses iTerm2 identity or `ITERM_SESSION_ID`; delivery is terminal-native but less structured than OSC 777/99. |
| Alacritty | Unsupported | Echo deliberately refuses the route, even if another environment variable looks supported. |

Echo never writes escape sequences to arbitrary `stdout` or `stderr`: adapters must provide an
explicit TTY writer, and a controlling TTY is opened only when it is actually a TTY. This keeps
hook protocols and piped/headless/SSH sessions free of terminal control bytes. When running
inside tmux, Echo reads `allow-passthrough` and sends the tmux DCS envelope only for `on` or
`all`; it never changes the tmux setting. Verify it without changing state with:

```bash
tmux show-options -p -t "${TMUX_PANE:?}" -v allow-passthrough
```

SSH or headless runs normally have no safe local TTY and therefore use the fallback path. Native
delivery never focuses a pane or terminal: Kitty uses `a=-focus`, and the other protocols do
not send focus actions. To inspect an adapter-level result, inspect its `NotifyResult.visual`
value; it reports `shown` plus `route` (`herdr` or `terminal`) and, for terminal delivery, the
terminal name. The daemon's `/health`, `~/Library/Logs/echo.log`, and the audio lifecycle and
voice-resolution logs remain the authoritative service diagnostics.

When the fallback appears as a macOS notification from **Script Editor**, that is the daemon's
final AppleScript route, not a WezTerm notification. It means the adapter did not establish a
native-success marker for that request. Conversely, a native route that reports `shown` adds
the exact marker and suppresses AppleScript, even if a host compositor or Herdr UI later fails to
render the visual toast; that latter case is a host-display boundary, not duplicate Echo delivery.
For focused WezTerm diagnostics, `notification_handling="AlwaysShow"` can be supplied as a
temporary command-line override. Do not change the user's global WezTerm configuration merely
to make an acceptance screenshot pass.

Validation: `title` and `message` are each rejected with `400` when over **500 characters**,
then sanitized for speech - shell metacharacters (`` ;&|><`$\ ``) stripped, markdown
(bold/italic/inline code/headers) unwrapped, `<script` and `../` removed. A message that is
empty after sanitization is a `400`. Square-bracketed `[markers]` are stripped from the
spoken text.

**Emotional markers:** a `[<emoji> <name>]` marker anywhere in `message` (e.g. `[🎯 focused]`,
`[🚨 urgent]`) selects a preset that overrides `stability`/`similarity_boost` after voice
resolution. The emoji and name must agree with the server's preset table
(`EMOTIONAL_PRESETS` in `core/server.ts`; count surfaced in `/health`). Audible only on
ElevenLabs - edge-tts/kokoro consume just `speed`.

**`voice_settings` semantics:** any non-empty object switches settings to full
**pass-through** - it replaces the persona's stored settings entirely (missing fields are
filled from server defaults: stability 0.5, similarity 0.75, style 0.0, speed 1.0,
speaker-boost true), and the resolved persona mapping then contributes only the voice
name/id. `speed` is consumed by edge-tts/kokoro; the rest by ElevenLabs.

Response: `202 {"status":"accepted","message":"Notification queued","request_id":"req-…"}`,
or `200` with the playback verdict when the request set `await_playback` (below).
Errors: `400 {"status":"error","message":"Invalid …","request_id":…}` for validation
failures (rejected **before** the line is queued), `500` otherwise.

**`202` on receipt (Phase 2 serialization).** `/notify` acks as soon as the request is
validated; the macOS **banner fires immediately at accept** (it is not audio and never
waits behind playback) unless the request carries the exact `visual_delivery: "native"`
marker, in which case an adapter already delivered the visual notification through a
native terminal route and the macOS banner is skipped. Synthesis and playback of
**voice lines only** run
asynchronously from a **global serial play queue** - one voice at a time across all
sessions and hosts, a new line never starts while another plays, and the in-flight line is
never interrupted. A `voice_enabled: false` request is banner-only: it never enters the
queue and can never delay or supersede a queued voice line. Queued voice lines coalesce
newest-per-session (an older *queued* line from the same `session_id` is replaced and
recorded `superseded` - its banner already showed) and age out (`dropped-stale`) past
`ECHO_PLAY_QUEUE_AGE_CAP_MS`; a hung player is bounded by the queue's watchdog
(`ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS`). Knobs in [`configuration.md`](configuration.md).

*Compatibility note (pre-Phase-2 callers):* the response stays 2xx, so `response.ok`
remains `true` and callers that treat any 2xx as success - including the shipped adapters,
which only log the status - are unaffected. The semantics shift from "delivered" to
"accepted": a `202` no longer means the line was spoken. True playback outcome lives in
the audio-lifecycle log (`~/.agents/Echo/audio-lifecycle.jsonl`), where each request's row
records a `disposition` - `played` (reached the player; carries the measured play window
unless muted), `superseded`, `dropped-stale` (waited past the age cap at dequeue, or
evicted by the depth cap at enqueue - `disposition_reason` says which), or
`held-for-capture` (skipped at speak time because an external mic capture was live and the
request presented no matching `capture_bypass_nonce` - see `ECHO_CAPTURE_STATE_PATH` in
[`configuration.md`](configuration.md); the banner still showed). Voice-disabled lines are
not logged (the lifecycle log records spoken lines only). A caller that cannot read that log
and needs its own line's outcome in the response opts into `await_playback` instead.

### Awaiting one line's playback

`await_playback: true` keeps the request open until that one line settles, then answers `200`:

```json
{"status": "played", "disposition": "played",
 "message": "Notification playback awaited", "request_id": "req-…"}
```

`status` is `played` only for the `played` disposition and `not_played` for every other one;
`disposition` carries which:

| `disposition` | Means |
|---|---|
| `played` | Reached the player and finished |
| `held` | The capture guard held it (no matching `capture_bypass_nonce`) |
| `muted` | Accepted and logged, audio suppressed by the runtime mute |
| `dropped` | Never reached the player - coalesced, aged out, or evicted by the depth cap |
| `failed` | The speak path threw, or the queue's watchdog fired |
| `timeout` | The wait's own bound elapsed first; the line may still be queued or playing |
| `not_queued` | `voice_enabled: false`, so there was never anything to play |

The wait is bounded by the queue's own watchdog (`ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS`) plus a
fixed margin (`AWAIT_PLAYBACK_MARGIN_MS` in `core/server.ts`), so it cannot outlive the work it
is waiting for and never hangs. Deriving it from the watchdog is deliberate: a shorter bound of
its own would time out a line that was still legitimately playing.

The field is additive. A request that omits it gets the `202`-on-receipt behavior above,
byte for byte. It exists because polling `/health` cannot answer for one particular line -
`play_queue.depth` is global, so an idle reading cannot distinguish "my line finished" from
"my line has not started yet". The one caller that needs the distinction is a voice ask, which
must not open a microphone until its own question has finished: [`converse.md`](converse.md).

## `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`. Always voice-enabled,
default title, identity voice; same validation and response shape (success message
`"Personality notification queued"`). Lines feed the same global play queue and always ack
`202` on receipt - `await_playback` and `capture_bypass_nonce` are read by `/notify` only; a
`session_id` here coalesces against `/notify` lines from the same session (one queue, one key).

## `POST /mute`

Global runtime mute (#83). While muted, notifications are accepted, logged, and
voice-resolved normally - audio alone is suppressed across **every** provider, including the
macOS `say` fallback. Muted lines are not held for later replay: they flow through the play
queue as usual and are suppressed at speak time; the `/notify` contract is unchanged.
The resolution drop-off log tags suppressed events `"muted": true`.

An explicit JSON body sets state; an **empty body toggles** (a one-keystroke hotkey needs no
state knowledge). The response is always the resulting state:

```json
{ "muted": true, "muted_until": "2026-07-03T23:30:00.000Z" }
```

- `muted` (boolean, required in a non-empty body) - target state.
- `duration_minutes` (positive number, optional) - timed mute; omitted = indefinite.
  The mute auto-expires **silently** at the deadline (lazy - voice simply resumes on the
  next notification). Invalid bodies return `400` and leave state untouched.

State persists across daemon restarts, deadline included, in a user-owned state file - its
location and the `ECHO_MUTE_STATE_PATH` override are in [`configuration.md`](configuration.md).
A missing or corrupt state file means unmuted - never a crash.

Day-to-day mute usage - the `scripts/mute.sh` wrapper - lives in
[`operations.md`](operations.md).

### Hotkey bindings

The empty-body toggle is designed for one-keystroke bindings (Raycast, Apple Shortcuts,
Stream Deck - anything that can run a command or make an HTTP request):

```bash
# Raycast Script Command / Stream Deck "System: Open" / any shell binding
curl -fsS -X POST http://localhost:3246/mute

# Explicit variants
curl -fsS -X POST http://localhost:3246/mute -H 'Content-Type: application/json' \
  -d '{"muted": true, "duration_minutes": 30}'   # mute for 30 minutes
curl -fsS -X POST http://localhost:3246/mute -H 'Content-Type: application/json' \
  -d '{"muted": false}'                           # unmute now
```

In Apple Shortcuts, use **Get Contents of URL** → Method `POST` → URL
`http://localhost:3246/mute` (leave the request body empty to toggle).

## `GET /health`

Returns `status`, `port`, `activeProvider` (= `defaultProvider`), `fallbackOrder`, provider
status, `macos_fallback_voice`, pronunciation rule count, emotional preset count, live
`play_queue` (`{depth, in_flight_ms, stalled}` - backlog, how long the current line has
been playing (null when idle), and whether the consumer has outlived its own watchdog), live
`circuit_breakers` state (per-provider `open`/`failures`, plus `threshold` and
`reset_after_ms`), the current mute state (`mute: {muted, muted_until}`), the capture
guard (`capture_guard: {path, state, pid}` - the resolved recording-state file, its current
reading, and which process holds the capture; `state` is `idle` unless a mic capture is live,
and `pid` is `null` whenever it is. `pid` is what lets a caller tell its own hold from a
foreign tool's recording; the hold's `nonce` is never exposed here), and the configuration
audit below.

`config: {path, present, valid, ignored_keys, errors}` reports what
`~/.config/echo/config.json` contributed at startup: where it was resolved from, whether it
existed, and - because a key that fails validation is dropped on its own rather than
discarding the file - exactly which keys were ignored and why. `valid: false` with a
non-empty `ignored_keys` is the machine-readable form of "your config partly applied", so a
typo is discoverable without reading `~/Library/Logs/echo.log`:

```bash
curl -fsS http://localhost:3246/health | jq '.config'
```

Full key reference and the validation rules: [`configuration.md`](configuration.md).

Each provider entry carries an **egress audit** (`getProviderStatus` in `core/server.ts`):
`enabled`, `healthy`, and `wouldEgress` (true only when the provider is *both* enabled and
makes an outbound network request when used), plus `egressTarget` when `wouldEgress` is
true. This makes the gating guarantee auditable at a glance - a disabled provider always
reports `wouldEgress: false` and omits `egressTarget`. An unhealthy provider may also include
`health_diagnostic` (`phase`, `reason`, `elapsed_ms`, `timeout_ms`, `exit_code`, `stderr`,
`command`). For edge-tts, that health diagnostic is status-only: `/notify` does not skip Edge
just because the import probe is slow or failed. The kokoro entry adds its `endpoint`; the
elevenlabs entry adds `apiKeyConfigured` (reflects only the `voices.json` `apiKey`
indirection, not the bare-env fallback - see [`configuration.md`](configuration.md)). Detail
in [`providers-observability.md`](providers-observability.md).

## `GET /voices`

Read-only projection of the daemon's resolved voice config. This is how a caller asks
"which persona keys exist?" without reading `core/voices.json` off disk - a co-located
checkout is not part of the contract, and the daemon may be running from a different clone
or a different `VOICES_PATH` than the caller can see.

```json
{ "agents": ["architect", "engineer", "themis"], "default_provider": "edgetts" }
```

| Field | Notes |
|---|---|
| `agents` | Sorted persona **name keys** from `voices.json` - exactly the values `/notify` resolves as `voice_id`. Never a raw provider voice id |
| `default_provider` | Same value `/health` reports as `activeProvider` |

Unlike `/health`, this route probes no provider, so it is cheap enough to call per turn, and
it has its own rate-limit bucket (see above) so a per-turn read never spends the caller's
notification budget. Adapters cache the answer per process - the Claude Code Stop hook is a
fresh process each turn, so that is one GET per turn. When the daemon is down, the 2s read
timeout precedes the notify attempt, so a fully-unreachable daemon costs the hook ~7s rather
than ~5s before it gives up.
The Claude Code adapter uses it to validate a `🗣️ <Name>:` persona tag before sending the
key, so an unknown name falls back to the DA voice instead of degrading to the daemon
default (see [`voices.md`](voices.md)). Callers must fail closed: an unreachable daemon or
an unexpected body means "no known personas", never "assume it resolves".

Adapters resolve this URL through `shared/daemon-endpoints.ts` rather than hard-coding a
port, so pointing a host at a second instance is one variable (`ECHO_DAEMON_URL`) -
see [`configuration.md`](configuration.md).

## Unsupported paths

Unsupported POST paths return an explicit JSON `404` with a `supported_endpoints` list; the
universal core does not expose a host-named route. (See the invariants in
[`../AGENTS.md`](../AGENTS.md).)
