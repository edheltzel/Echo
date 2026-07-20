# Echo Integration Scoping — a host-agnostic `voice_ask` (two-way voice)

**Scout report for Themis · repo `/Users/ed/Developer/atlasEcho` @ `dev` · read-only, every structural claim grounded in codegraph + the on-disk source.**

Goal: scope **where** a `voice_ask` capability — *speak a question aloud, capture the
user's spoken reply, transcribe it, return text to the calling agent* — would sit in
Echo's architecture, and recommend one design that respects Echo's invariants.

---

## 0. The one fact that reframes everything

**Echo today is one-directional. It has zero microphone-capture and zero
speech-to-text (STT) machinery anywhere in the tree.** I grepped `core/`, `adapters/`,
`shared/`, `scripts/` for `whisper|transcrib|speech-to-text|getUserMedia|arecord|sox` —
no matches. Echo synthesizes speech *out* (`edge-tts → ElevenLabs → Kokoro → say`) and
shows banners. That is the whole product.

The name that *sounds* like input — `core/capture-guard.ts` — is not input. Read its
header (verbatim, lines 1–21): it **reads** a state file that an **external** tool
(VoiceLayer's "VoiceBar") writes when *that* tool holds the mic, and it makes Echo *go
silent* so Echo's TTS doesn't pollute the other tool's recording. The contract comment is
explicit: *"Echo never writes this file."* `readCaptureState` (`core/capture-guard.ts:52`)
only ever `readFileSync`s. So the capture guard is a **consumer of someone else's
microphone**, not a microphone.

Why this matters: `voice_ask` is not an extension of the notify pipeline. It introduces
**three brand-new concerns** Echo has never had —

1. **Microphone capture** (macOS mic access → TCC permission surface).
2. **Speech-to-text** (a new heavy dependency — a local model binary or a cloud API).
3. **A blocking request/response interaction model.** `/notify` is fire-and-forget:
   validate → 202 → async play (`core/server.ts:1745`, `acceptNotification` at
   `core/server.ts:1670`). `voice_ask` must *block the caller* until the human has
   answered and the audio is transcribed. Those are opposite shapes.

Everything below follows from taking that seriously. The interesting design question is
not "which endpoint" — it's "where do the mic, the STT dependency, and the blocking turn
live so that Echo's lean, host-neutral, fire-and-forget TTS daemon stays exactly what it
is."

---

## 1. The boundary you must not break (grounded)

Echo's whole architecture is one rule: **`core/` is host-neutral and knows nothing about
who is calling it.** ARCHITECTURE.md §"The boundary that shapes everything" and the
AGENTS.md invariant list. Crucially, this rule is **mechanically enforced by tests**, not
just documented — so a violation is a red CI run, not a review nit. The two enforcers:

**`tests/core/no-host-strings.test.ts`** — greps every file under `core/` for
`/PAI|Claude|\.claude|OpenCode|\bPi\b/`. Any host name in `core/` fails CI.

**`tests/core/architecture-invariants.test.ts`** (I read it in full) — import-precise and
adds the structural rules. Its six tests, and what each means for `voice_ask`:

| Test | Rule | `voice_ask` consequence |
|---|---|---|
| Invariant 1 (`:79`) | `core/` imports no `adapters/**`, no `@earendil-works/*` (Pi SDK), no `@anthropic-ai/*`, no `claude-code`/`opencode`/`pai` | An STT client that pulls a host SDK **cannot** live in `core/`. A neutral STT binary (like `edge_tts`) *could*. |
| Invariant 2 (`:105`) | no `:31337` anywhere in `core/` | trivially satisfied |
| Invariant 3 (`:121`) | `core/` runtime source: no `/tmp` | any capture buffer / partial-audio scratch file must be user-owned, never `/tmp` |
| Invariant 4 (`:138`) | `core/server.ts` route literals (`url.pathname === "…"`) may not match `pai\|claude\|opencode\|^pi(-\|$)` | **`POST /ask` is allowed** — "ask" is host-neutral. The route-name rule bans *host* names, not new neutral routes. |
| Invariant 5 (`:156`) | legacy PAI stow tree stays deleted | N/A |
| Invariant 6 (`:170`) | `adapters/pai` name stays retired | N/A |

**Read Invariant 4 carefully, because it kills a lazy assumption.** A neutral endpoint
like `POST /ask` on `core/server.ts` would *pass* both enforcement tests — it is not a
host-named route, and it imports no host API. So the invariants do **not** forbid putting
`voice_ask` on the core daemon. The reason to keep it *off* core is not the letter of the
tests; it's the **spirit** (the Bun-only, zero-heavy-dep, fire-and-forget, no-privileged-
permissions posture) plus the **operational** consequences (§5, TCC). That distinction
runs through the whole option analysis.

The `/notify` contract itself is a hard invariant: *"Do not change the `/notify`
request/response contract without an explicit compatibility plan"* (AGENTS.md). `voice_ask`
must not touch `/notify`'s body or status semantics — it is additive, never a mutation of
notify.

---

## 2. The decision space: three placements

### Option (a) — Extend `core/server.ts` with `POST /ask` on `:8888`

The daemon grows a fifth endpoint. The `fetch` handler at `core/server.ts:1717` dispatches
on `url.pathname`; you'd add an `=== "/ask"` branch that: speaks the question, opens the
mic, runs STT, and **blocks** until it can return `{ text: "<transcript>" }`.

- **Passes the invariant *tests*** — `/ask` is neutral; no host import needed.
- **Reuses the TTS chain in-process** for the question half — cheapest possible reuse.
- **Violates the *posture*, hard.** It bolts mic capture + an STT dependency + a
  long-blocking request onto the fire-and-forget TTS daemon. `core/`'s only out-of-process
  dep today is Python `edge_tts` (AGENTS.md: *"Python only as the out-of-process `edge_tts`
  dependency"*). STT would be a *second* such dep — defensible by precedent, but it lands
  in the daemon that is deliberately lean.
- **Poisons the daemon's permission profile (the real killer — see §5).** The moment
  `com.echo` opens the mic, the *entire always-on TTS LaunchAgent* becomes a
  microphone-accessing background process and triggers a TCC grant. Every install that
  wants notifications now also carries a persistent, easy-to-miss mic grant on a daemon.
  That is a large, permanent trust escalation for a feature most notify users won't use.
- **Blocking-vs-async clash.** The play queue (`core/play-queue.ts`) is built entirely
  around *"one voice at a time, fire-and-forget, 202 on receipt."* A blocking duplex turn
  is a different state machine grafted next to it.

**Verdict:** legal, but it changes what the TTS daemon *is*. Reject on posture + TCC.

### Option (b) — A sibling neutral daemon `echo-converse` beside `core/`

A **second host-neutral daemon** (own port, e.g. `:8889`, own LaunchAgent
`com.echo.converse`) owns the three new concerns — mic, STT, and the blocking turn — and
**coordinates with `core` over the capture-state file contract that already exists.**

The turn:

1. Agent → `echo-converse`: `POST /ask {question, session_id}` (blocking).
2. `echo-converse` speaks the question by **POSTing to core `/notify`** — full reuse of
   the existing TTS fallback chain, zero duplication, `core` untouched.
3. It waits for that line to finish playing (observe `core`'s `/health` →
   `play_queue.{depth,in_flight_ms}`, both already exported — see `docs/http-api.md`
   §`/health`).
4. It then **writes** the `recording-state.json` file (state=`recording`) and opens the
   mic. Because `core/capture-guard.ts` already *reads* that file (`isCaptureActive`,
   `core/capture-guard.ts:88`), **core automatically holds all TTS while converse
   records** — the mic-vs-playback arbitration we shipped works *in reverse, for free*
   (§4).
5. STT → transcript → set state back to `idle` → return `{ text }` to the agent.

- **`core/` never changes** — contract stable, no new core endpoint, no core mic, no core
  STT dep. Every invariant test stays green untouched.
- **The heavy/permissioned concern is quarantined** in a sibling that can carry its own
  dep and its own (separate, reasoned-about) mic grant.
- **Reuses the existing coordination seam** rather than inventing one. The only new twist:
  `echo-converse` becomes a **writer** of the recording-state contract that `capture-guard`
  currently only reads — a documented, deliberate inversion (§4).
- **Cost:** a second long-lived process + LaunchAgent to install, operate, and reconcile.
  Mitigable by making capture an **on-demand child** rather than always-on (§5).

**Verdict:** best fit to Echo's own "neutral capability daemon + out-of-process
integration" philosophy. This is the recommendation's backbone.

### Option (c) — An MCP server package that adapters register per host

Ship an **MCP server** exposing a `voice_ask` tool; each host registers it.

The critical realization: **(c) answers a different question than (a)/(b).** (a)/(b) decide
*where the mic + STT live*. (c) decides *how a host's model actually invokes the tool*.
An MCP server still needs a capture+STT backend behind it — MCP is the **transport/
consumption** layer, not the capture engine.

And for **Claude Code specifically, MCP is not optional — it is the only mechanism that
works** (§3). But "MCP server = the whole feature, capturing directly" is the wrong read:
if every host's MCP server captured the mic itself, you'd have N processes fighting for one
microphone with no coordinator, N TCC grants, and N copies of the STT dep. That reproduces
exactly the fragmentation Echo's single-daemon design exists to avoid.

**Verdict:** MCP is the right **consumption adapter**, wrong as the **whole architecture**.
It belongs *in front of* (b), as a thin client — not instead of it.

---

## 3. How each host actually consumes `voice_ask`

This is where the boundary bites, because the three hosts have **very different
capabilities**, and a naive "just add an endpoint" misses that hooks can't do this at all.

### Claude Code — **hooks cannot; you need MCP**

I read `adapters/claudecode/hooks/VoiceGate.hook.ts` end to end for the exact hook I/O
model. A Claude Code hook is a **one-shot subprocess**: it reads a JSON blob from
`Bun.stdin.text()` (`VoiceGate.hook.ts:43`), makes one decision, writes one JSON verdict to
stdout (`{continue:true}` or `{decision:"block",…}`, `:71`/`:77`), and exits. That is the
entire surface. Hooks are **lifecycle interceptors** — they fire on `PreToolUse`,
`SessionStart`, `Stop`, etc., can *block/allow* a tool call, and can *inject* context. They
have **no channel to hand arbitrary data back to the model as a tool result**, and they are
**not model-invokable** — the model cannot decide "call voice_ask now." They fire on
*Claude's* lifecycle events, not on Claude's *intention*. So a two-way `voice_ask` — which
is fundamentally *"the model calls a tool and receives text back"* — **cannot be a hook.**

Confirmed: there is **no MCP infrastructure in the repo today** (grep for
`modelcontextprotocol|mcp server|registerTool|mcp__` across `adapters/scripts/core/docs` →
zero hits). Everything Claude-Code-side is hooks + the Stop-hook voice
(`adapters/claudecode/hooks/VoiceCompletion.hook.ts`) + the `restore-hooks.ts` registrar.

Therefore, to give the Claude Code **model** a callable `voice_ask` that returns a
transcript, the *only* path is an **MCP server** registered in the Claude Code MCP config.
The model calls `voice_ask` → the MCP server (a thin HTTP client) POSTs `echo-converse
/ask` → blocks → returns the transcript as the tool result. Hooks remain what they are.

### Pi / oh-my-pi — extension API, tool registration **unverified**

I read `adapters/pi/index.ts` in full. The Pi extension gets an `ExtensionAPI` object
(`pi`, `index.ts:63`) and uses exactly two capabilities today:

- `pi.on(event, handler)` — lifecycle listeners (`before_agent_start`, `session_start`,
  `message_end`, `turn_end`, `session_shutdown`).
- `pi.registerCommand(name, {description, handler})` (`index.ts:159`, the `voice-status`
  command).

`registerCommand` is a **user-typed slash command**, *not* a model-invokable tool — same
gap as Claude Code hooks: it's human-initiated, not agent-initiated. **Whether the Pi
`ExtensionAPI` can register a model-invokable *tool* is UNVERIFIED** — the SDK
(`@earendil-works/pi-coding-agent`) is a **type-only peer dependency** (`package.json`
`peerDependencies`, and the build uses `--external @earendil-works/pi-coding-agent`), so it
is **not vendored in `node_modules`** and I could not introspect the full interface. **This
is the single most important open question for the Pi consumption path — Themis should have
someone check the installed Pi SDK's `ExtensionAPI` for a `registerTool`/`tool`-style
method before committing.**

Two outcomes:
- **If Pi extensions *can* register tools:** the Pi adapter grows a `voice_ask` tool that
  is a thin HTTP client of `echo-converse` — cleanest, mirrors the existing adapter.
- **If they cannot:** Pi consumes the **same MCP server** as Claude Code (if Pi speaks
  MCP), or falls back to a slash command that's less ergonomic for autonomous asks.

### Scripts / any HTTP client — trivial

`echo-converse`'s `POST /ask` is plain HTTP, exactly like `POST /notify`. A `curl` or a
`core/notify-client.ts`-style helper (`sendNotifyPayload`, `core/notify-client.ts:41`)
gets a `voice_ask` sibling. No host, no MCP, no extension — just POST and read the JSON
reply. This is the lowest-common-denominator path and it comes for free from (b).

**Consumption summary:**

| Host | Can the *model* call it? | Mechanism | Confidence |
|---|---|---|---|
| Claude Code | Only via MCP | **MCP server** (hooks structurally cannot) | High — hook I/O model read directly |
| Pi / omp | Maybe via extension tool | Extension-registered tool **or** MCP | **Unverified — check the SDK** |
| Scripts | N/A (imperative) | Raw HTTP `POST /ask` | High |

---

## 4. What existing Echo machinery is reusable

`voice_ask` is a big new capability, but it does **not** start from zero. Three existing
pieces carry real weight.

### 4.1 The capture guard — reuse *by inversion* (the elegant part)

Today: an **external** tool writes `recording-state.json`; `core/capture-guard.ts` reads it
and Echo holds TTS while that tool records (`speakWithFallback` returns early with
`held_for_capture: true`, `core/server.ts:1308`). Contract (from the file header): a state
file at `~/.local/state/voicelayer/recording-state.json` (overridable via
`ECHO_CAPTURE_STATE_PATH`), shape `{state, pid, updated_at}`, `state ∈
idle|recording|transcribing`, only honored while `pid` is alive.

For `voice_ask`, **`echo-converse` becomes the writer of that exact contract.** When it
opens the mic it writes `state:"recording"` (and `state:"transcribing"` while STT runs)
with its own pid. Consequence, for free: **`core` sees the capture active and holds every
queued TTS line** — the mic-vs-playback arbitration we just shipped is precisely the
cross-process lock a conversation needs, and it already works in the required direction. No
new coupling; converse writes the file, core already reads it.

**Two subtleties to design around (flagging, not hand-waving):**

- **The self-hold trap.** If converse sets `state:"recording"` and *then* asks core to
  speak the question via `/notify`, core's own capture guard would **hold the question**
  (converse silenced itself). Correct ordering: **speak the question with state `idle` →
  wait for playback to finish → *then* flip to `recording` and open the mic.** The turn
  must never overlap its own output with its own capture.
- **Observing "question finished playing."** `/notify` is 202-async
  (`core/server.ts:1774`); the caller does not learn when the line actually *plays*.
  Converse must gate step 4 on completion. `core`'s `/health` already exposes
  `play_queue.{depth, in_flight_ms}` (`docs/http-api.md` §`/health`), so converse can poll
  for `depth==0 && in_flight_ms==null` before opening the mic. This is **slightly racy**
  (another session could enqueue in the gap) and is the cleanest reuse that touches nothing
  in core. If v1 wants it airtight, the *one* core change worth considering is a small
  per-request completion signal — but that touches the `/notify` contract, so treat it as a
  follow-up, not v1.

### 4.2 The play queue — a template and a serialization *sibling*, not a host

`core/play-queue.ts` serializes **playback**: one voice at a time, single async consumer,
newest-per-session coalescing, age cap, depth cap, watchdog. `voice_ask` reuses it
**indirectly** — the question audio goes through `/notify`, so it rides the existing queue
and honors global one-at-a-time-ness automatically.

But note what the queue does **not** solve: it serializes *output*. `voice_ask` needs to
serialize a **full duplex turn** (speak → capture → transcribe) and, critically, **the
microphone** — only one agent can own the mic at once. That's a *different* lock living in
`echo-converse` (§5, session booking). The play queue is the **design template** for it
(single consumer, injectable clock, disposition reporting — all patterns worth copying) and
its serialization *complements* converse's mic lock, but the queue itself is not the mic
arbiter.

### 4.3 Plumbing that ports directly

- **`core/notify-client.ts`** (`sendNotifyPayload`, `:41`; `signalWithTimeout`, `:22`) —
  the reference POST-with-timeout-and-abort client. `echo-converse` uses it verbatim to
  speak the question via core, and the MCP/HTTP adapters use the same shape to call
  `echo-converse`.
- **The TTS fallback chain** (`speakWithFallback`, `core/server.ts:1287`) — reused *whole*
  for the question half, purely by POSTing `/notify`. Converse writes no TTS code.
- **`shared/echo-env.ts`** — the process-first, first-file-per-key env loader that already
  spans the daemon and the Pi adapter (AGENTS.md invariant: *"Adapters may import
  `shared/`, never `core/`"*). `echo-converse` and its adapters read config (STT provider,
  port, mic device, `ECHO_CAPTURE_STATE_PATH`) through this same loader, so
  `~/.config/echo/.env` stays the one durable config surface.
- **`core/circuit-breaker.ts`** — the per-provider breaker pattern is a ready template if
  STT is a cloud provider that needs the same egress-gating + failure-tracking discipline.

---

## 5. Risks, platform reality, and operations

### 5.1 Microphone TCC — the load-bearing platform decision

macOS gates mic access through **TCC**, and *which process opens the mic* determines the
whole permission story:

- **If the always-on daemon (`com.echo` **or** a `com.echo.converse` LaunchAgent) opens the
  mic**, the **background daemon** is the responsible process. Background LaunchAgents get
  TCC prompts that are **easy to miss** (no foreground app to attach the dialog to), and the
  result is a **persistent, standing mic grant on an always-on process** — a meaningful,
  permanent privacy ask.
- **If mic capture runs in an on-demand *child process* spawned from the host's terminal**,
  TCC attributes to the **terminal app** (Terminal/iTerm/Ghostty/etc.), which the user
  grants mic to **once** and which then covers all children. This is a far gentler, more
  legible permission model.

**This tension is the strongest argument for a design nuance inside Option (b):** make
`echo-converse`'s **coordination/booking** logic the durable part (tiny, no mic), and make
the **actual capture** an **on-demand child** so TCC lands on the terminal, not a daemon.
The booking layer can still be a small daemon or even a lock-file, but the privileged mic
access should be as ephemeral and as terminal-attributed as possible. **This is the single
biggest thing to prototype early** — get the TCC flow right before building anything else,
because it constrains process topology.

### 5.2 Concurrency — one mic, N agents (session booking)

The `core` daemon is a **singleton** serving every host and session. Two agents (two Claude
Code windows; a Claude Code + a Pi session) can call `voice_ask` at the same instant. There
is exactly **one microphone and one human.** So `echo-converse` needs an explicit **mic
booking lock**: the first `/ask` acquires it; a second concurrent `/ask` must **fail fast
(`409 Conflict`) or queue with a bounded wait** — never open a second mic stream, never ask
two questions into one recording. The play queue's single-consumer pattern
(`core/play-queue.ts`) is the design model; the semantics differ (a booking is a blocking
resource lease, not a fire-and-forget drop-if-stale). Decide up front: **409-and-let-the-
agent-retry** is simpler and more honest than an invisible queue for an interactive prompt.

### 5.3 STT dependency vs. the zero-heavy-dep posture

Echo's stated posture: **Bun + TypeScript only; Python only as the out-of-process
`edge_tts` dep** (AGENTS.md). STT forces a choice:

- **Local** (whisper.cpp / a `whisper` binary): **no egress, no API key**, but a new binary
  dependency and model download. Fits the *"out-of-process binary like edge_tts"* precedent
  best, and keeps Echo's local-first identity (per Ed's Echo policy — local chain,
  ElevenLabs disabled).
- **Cloud** (OpenAI/Deepgram/etc.): trivial to integrate but adds **egress + a secret** —
  and Echo has a whole egress-gating + secret-handling discipline (`getProviderStatus`,
  SECURITY.md, *"never commit secrets/.env"*) it would have to honor. Reuse
  `core/circuit-breaker.ts`'s pattern if you go cloud.

Quarantining STT in `echo-converse` (not `core`) means this dependency choice **never
touches the TTS daemon's dependency surface** — a direct payoff of Option (b).

### 5.4 LaunchAgent & lifecycle implications

`com.echo` is the current label (plist `~/Library/LaunchAgents/com.echo.plist`, log
`~/Library/Logs/echo.log`). A converse daemon means a **second** service identity
(`com.echo.converse`), its own log, and its own lifecycle in
`scripts/{start,stop,restart,status,uninstall}.sh`. AGENTS.md warns: *"Do not broad-kill
whatever owns port 8888"* — the same discipline applies to converse's port. Prefer the
**booking-daemon-is-tiny / capture-is-a-child** topology from §5.1 to minimize the
always-on footprint.

### 5.5 No `/tmp`; buffers are user-owned

Invariant 3 is enforced for `core/` but the *spirit* applies to converse: partial-audio
capture buffers, WAV scratch, and any session state go to user-owned cache paths
(`~/Library/Caches/...` / `$XDG_STATE_HOME`), **never `/tmp`**. The recording-state file
converse writes must match the capture-guard contract path
(`~/.local/state/voicelayer/recording-state.json` by default, honoring
`ECHO_CAPTURE_STATE_PATH`) so core reads it correctly.

---

## 6. Registration & install — the #77 reconcile-and-prune contract

Whatever adapters `voice_ask` ships (an MCP server for Claude Code; a Pi extension tool or a
shared MCP server for Pi), each **MUST** obey the issue-#77 registration contract
(`docs/adapters.md` §"Registration contract"). That contract, verbatim in spirit:

1. **Set the canonical path explicitly**, derived from the adapter's own `import.meta.url`
   — never a hardcoded clone location.
2. **Prune stale variants** — a repo rename must not leave a dead registration behind
   (this bit production twice on 2026-07-02; it is the reason append-only registration is
   *forbidden*).
3. **Idempotent** — rerunning on a correct config is a byte-for-byte no-op.
4. **`--check`** — reports pending changes without mutating; exit **0** current / **3**
   pending.
5. **Edit through symlinks** — replace the resolved real file, never the symlink.

Existing implementations to copy (I confirmed the wiring in `scripts/install.sh`):

- Claude Code hooks → `adapters/claudecode/restore-hooks.ts` (edits
  `~/.claude/settings.json`). An **MCP server registration** would follow the same shape,
  writing the MCP-server entry into Claude Code's MCP config instead of the hooks array.
- Pi packages entry → `adapters/pi/reconcile.ts` (`~/.pi/agent/settings.json`).
- omp symlink → `adapters/pi/reconcile-omp.ts` (`~/.omp/agent/extensions/`, strict
  ownership — only the `echo-voice` name, FATAL on collision).

**And you must wire into `scripts/install.sh` in two places** (both confirmed in the
source): the `preflight` switch (`install.sh:98`, runs `reconcile --check` tolerating exit
3) and the `install_adapter` switch (`install.sh:223`, runs the reconcile). `install.sh
--check` aggregates every adapter's check mode plus the plist paths — *"a new adapter must
plug its reconcile and check commands into both."* A converse MCP adapter (likely
`adapters/mcp/`) is a new adapter and inherits all of this. Future hosts (Codex/OpenCode
#30) inherit the same contract.

---

## 7. Recommendation — one architecture

> **Build `voice_ask` as a dedicated host-neutral converse capability that reuses the
> capture-state contract as its coordination seam, and expose it to each host through a
> thin adapter. Concretely:**
>
> **(1) A neutral `echo-converse` capability** (sibling to `core/`, its own port e.g.
> `:8889`) owns the mic, the STT dependency, the duplex-turn state machine, and the
> single-mic **booking lock**. It **speaks the question by POSTing `core` `/notify`**
> (reusing the entire TTS chain), waits for playback via `/health`, then **writes the
> `recording-state.json` capture file** — so `core/capture-guard.ts` auto-holds all TTS
> while it records (the arbitration we shipped, used in reverse). It writes no TTS code and
> `core/` changes **not at all**.
>
> **(2) Per-host thin adapters** that are pure HTTP clients of `echo-converse`:
> - **Claude Code → an MCP server** (`adapters/mcp/`) exposing the `voice_ask` tool.
>   Non-negotiable: **hooks structurally cannot** return a transcript to the model.
> - **Pi/omp → an extension-registered tool if the SDK allows it** (⚠️ **verify** — see
>   §3), else the same MCP server.
> - **Scripts → raw `POST /ask`.**
>
> **(3) Registration** of every adapter via the **#77 reconcile-and-prune** contract, wired
> into `scripts/install.sh` `preflight` + `install_adapter` + `--check`.
>
> **(4) Minimize the always-on mic footprint:** keep the booking layer tiny and run the
> actual **capture as an on-demand child** so **mic TCC attributes to the host terminal,
> not to an always-on daemon** (§5.1). Prototype this TCC flow **first** — it constrains
> the process topology.

**Why this and not the alternatives:**

- **Not (a) `POST /ask` on core** — it *passes the invariant tests* but changes what the
  TTS daemon *is*: it gives the always-on `com.echo` a standing mic grant (§5.1) and a
  second heavy dep, and grafts a blocking duplex model onto a fire-and-forget engine. The
  posture cost outweighs the in-process-reuse convenience, and (b) recovers that reuse
  anyway by POSTing `/notify`.
- **Not (c) MCP-as-the-whole-thing** — MCP is the *correct* Claude Code consumption layer
  (and (b) uses it there), but if each host's MCP server captured the mic directly you'd get
  N mic-contending processes, N TCC grants, N STT copies — the exact fragmentation Echo's
  single-daemon design rejects. MCP belongs *in front of* the single converse capability, as
  a thin client.
- **(b) is the only option that keeps `core/` byte-for-byte host-neutral, keeps the TTS
  daemon lean and mic-free, quarantines the STT dependency, and reuses the capture-state
  contract as a ready-made cross-process lock** — every constraint satisfied, and it mirrors
  Echo's own "neutral capability + out-of-process adapters" philosophy rather than fighting
  it.

**Two things to resolve before building:** (i) **verify the Pi `ExtensionAPI` tool-
registration capability** (SDK not vendored locally; determines the Pi path); (ii)
**prototype the mic-TCC flow** to lock the daemon-vs-child topology. Both are cheap and both
gate the design.

---

## Executive summary

`voice_ask` is not a new endpoint on an existing pipeline — it is a **new capability class**
for Echo, which today is a purely one-directional, fire-and-forget TTS daemon with **zero
microphone or speech-to-text machinery** (the deceptively-named `core/capture-guard.ts` only
*reads* an external tool's recording-state file to stay silent; *"Echo never writes this
file"*). Delivering it means introducing three concerns Echo has never had — mic capture, an
STT dependency, and a *blocking* request/response turn — without disturbing the host-neutral,
lean, permission-light `core/` that two CI tests (`no-host-strings`, `architecture-
invariants`) mechanically defend. Those tests would actually *permit* a neutral `POST /ask`
on the core daemon, but doing so would give the always-on TTS LaunchAgent a standing
microphone grant and a second heavy dependency — a posture and TCC cost that outweighs the
convenience. The right shape is a **dedicated host-neutral `echo-converse` capability** that
owns the mic, STT, the duplex state machine, and a single-mic booking lock; speaks its
questions by POSTing the existing `core` `/notify` chain (zero TTS duplication); and **writes
the very `recording-state.json` file that `core`'s capture guard already reads — so the
mic-vs-playback arbitration we just shipped becomes, for free, the cross-process lock a
conversation requires.** Hosts consume it through thin adapters: **Claude Code must use an
MCP server** (its hooks are one-shot lifecycle interceptors that structurally cannot hand a
transcript back to the model), **Pi/omp use an extension-registered tool if their SDK
supports one — an open question to verify, since the SDK isn't vendored locally — otherwise
the same MCP server**, and scripts use raw HTTP. Every adapter registers via the #77
reconcile-and-prune contract wired into `scripts/install.sh`. The two decisions to settle
first, because they constrain everything downstream, are the **microphone TCC topology**
(favor an on-demand capture child so permission attaches to the host terminal, not an
always-on daemon) and the **Pi tool-registration capability**. This design leaves `core/`
untouched, quarantines the heavy dependency and the privileged permission, and extends Echo
along the exact grain of its "neutral capability daemon + out-of-process adapters"
architecture.
