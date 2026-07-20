# VoiceLayer `voice_ask` — Anatomy for a Pure-TS/Bun Rebuild

**Lane:** cross-vendor explorer (Themis dispatch, project Echo)
**Target repo:** `/Users/ed/Developer/_AI/voicelayer` (codegraph-indexed; every structural claim below is grounded in `codegraph_explore` with `file:line` evidence)
**Deliverable:** onboarding-grade anatomy of the *production* `voice_ask` conversation loop — mine for a rebuild, don't port.
**Sibling doc note:** `ts-portability.md` (same directory) claims Silero VAD is "the Python/onnxruntime anchor via silero-vad + torch." **That is wrong** — see §6/§1. VAD already runs in-process through `onnxruntime-node`, a native addon, with zero Python. Correct the rebuild plan accordingly.

---

## 0. TL;DR orientation

`voice_ask` is one MCP tool that (1) speaks a question aloud, (2) records the user's spoken reply, (3) transcribes it locally, (4) cleans + LLM-polishes the text, and (5) returns the string. It is **strictly sequential** — TTS fully drains before the mic opens. There is **no real-time "interrupt the question by talking" barge-in** in the shipping path (that lives in an unwired `voicesdk/` SDK; see §2).

The runtime is mostly TypeScript/Bun shelling out to **self-contained binaries** (`sox`/`rec`, `whisper-cli`, `afplay`, `ffmpeg`) plus **one native Node addon** (`onnxruntime-node` for VAD). The only *installed-Python-runtime* dependencies are three **optional** subprocess servers/scripts: `edge-tts` (preset TTS), the `tts_daemon.py` MLX Qwen3-**TTS** daemon (cloned voices, port 8880), and `mlx_lm.server` (STT text **polish** LLM, port 8080). None of the three is on the critical path for a minimal `voice_ask` with a whisper model installed.

---

## 1. End-to-end `voice_ask` lifecycle

### 1.1 MCP tool entry → dispatch

- MCP JSON-RPC lands in `handleMcpRequest` (`src/mcp-handler.ts:58`). `voice_ask` is in `KNOWN_TOOLS` (`src/mcp-handler.ts:13-25`, alongside the `qa_voice_*` back-compat aliases). `tools/call` routes to an injected `executeTool` (`src/mcp-handler.ts:148`).
- The executor dispatches `voice_ask` → `handleVoiceAsk` (`src/handlers.ts:182`), which just normalizes args and delegates to `handleConverse` (`src/handlers.ts:242`). `voice_ask` == "converse mode."

### 1.2 Session booking mutex (the "line is busy" lock)

Inside `handleConverse` (`src/handlers.ts:255-273`):

- `isVoiceBooked()` (`src/session-booking.ts:173`) cleans stale locks then reads the current lock. If booked by *another* PID → returns a `formatBusy` error immediately (no recording).
- If unbooked → `bookVoiceSession()` (`src/session-booking.ts:109`) writes `LOCK_FILE` with the **`wx` exclusive-create flag** (`src/session-booking.ts:137`) — atomic, TOCTOU-safe; `EEXIST` means another session raced and won.
- `LOCK_FILE = /tmp/voicelayer-session-{SESSION_TOKEN}.lock` (`src/paths.ts:63`), where `SESSION_TOKEN` is 8 random bytes generated once per process (`src/paths.ts:60`).
- Staleness: `cleanStaleLock()` (`src/session-booking.ts:80`) removes a lock whose PID is dead immediately, or whose PID is alive-but-not-ours only after `ORPHAN_TIMEOUT_MS`. Our own live lock is never timed out.

### 1.3 Speak the question (blocking) then open the mic

Still in `handleConverse`, wrapped in an **outer hard-timeout guard** of `(timeoutSeconds + 15)s` (`src/handlers.ts:287`, `320-336`) racing the whole flow so a stuck pipeline can't hang forever. The `converseFlow` (`src/handlers.ts:288-318`) runs, in order:

1. `assertSpeakerClear()` (`src/tts.ts:61`) — **refuse** (not queue) if the user is already recording; throws `SPEAKER_OUTPUT_REFUSED_MESSAGE`.
2. `await awaitCurrentPlayback()` (`src/tts.ts:986`) — drain the whole playback queue.
3. `await speak(message, { mode:"converse", waitForPlayback:true })` (`src/handlers.ts:299`) — **fully blocks** until the question audio finishes playing (see §1.7 for the TTS cascade).
4. `await waitForInput(timeoutSeconds*1000, silenceMode, pressToTalk)` (`src/handlers.ts:307`) — record + transcribe.
5. Return `formatAsk(response)` text, or the null/timeout variant.

`silenceMode` defaults to `thoughtful` for converse (`src/handlers.ts:77`, `253`); `timeoutSeconds` clamped to `[5, 3600]` (`src/handlers.ts:248`).

### 1.4 Mic capture — `waitForInput` → `recordToBuffer`

`waitForInput` (`src/input.ts:1751`) orchestrates; `recordToBuffer` (`src/input.ts:1338`) does the raw capture.

**Device access mechanism:** capture is a **`sox` `rec` subprocess** — not CoreAudio bindings. `resolveBinary("rec", ["/opt/homebrew/bin/rec","/usr/local/bin/rec"])` (`src/input.ts:1370`) then `Bun.spawn([recPath, "-r", nativeRate, "-c", nativeChannels, "-b","16","-e","signed","-t","raw","-q","-"], {stdout:"pipe", stderr:"pipe"})` (`src/input.ts:1527`). Raw PCM streams over stdout.

**Native-rate capture + JS resampling (hard-won):** it records at the *device's native* sample rate/channels (`detectNativeInputFormat`, `src/input.ts:1387`) and resamples/downmixes to 16 kHz mono **in JS** (`resamplePCM16`/`downmixPCM16ToMono`, `src/input.ts:1626-1631`). The `AIDEV-NOTE` at `src/input.ts:1384-1386` explains why: sox buffer-overruns when asked to resample during a streaming pipe (e.g. AirPods at 24 kHz → 16 kHz).

**Decoupled reader/processor (hard-won, "R66 fix"):** `pipeReader` (`src/input.ts:1602`) reads stdout as fast as possible with **no async/ONNX inside the loop**, extracting fixed-size chunks into a queue; `chunkProcessor` (`src/input.ts:1639`) runs VAD on the queue. Comment at `src/input.ts:1594-1597`: ONNX inference (5–50 ms) inside the read loop caused Bun to recycle pipe buffers before JS consumed them (`rms=0`). They also defensively copy every chunk (`new Uint8Array(value)`, `src/input.ts:1609`, "R65").

**VAD vs PTT modes:**
- **VAD (default):** each 16 kHz / 512-sample chunk → `processVADChunk` (`src/vad.ts:178`) → speech probability; `isSpeech()` at threshold 0.5 (`src/vad.ts:41,218`). Recording ends when `consecutiveSilentChunks >= silenceChunksForMode(mode)` after speech was seen (`src/input.ts:1706`). Silence windows: quick 0.5 s / standard 1.5 s / thoughtful 2.5 s (`src/vad.ts:46-50`). A pre-speech timeout of 15 s ends a recording where no speech ever starts (`src/input.ts:133`, `1714`).
- **PTT (`press_to_talk:true`):** no VAD; `silenceChunksNeeded = Infinity` (`src/input.ts:1360`). Ends only on the stop signal, with a fixed post-stop drain (`PTT_STOP_CAPTURE_DRAIN_MS`, `beginPttStopDrain`/`isPttStopDrainComplete`, `src/input.ts:1434-1452`, `1318`).
- Stop signal is polled every **50 ms** via a `setInterval` (`src/input.ts:1510-1521`, unref'd), independent of the VAD loop.

**Silero VAD internals (pure TS + native addon, no Python):** `src/vad.ts:25` `const ort = require("onnxruntime-node")`. `processVADChunk` converts PCM→float32, prepends 64 samples of carried context to the 512-sample chunk (576 total, `src/vad.ts:192-196`), builds an `ort.Tensor`, and runs `vad.session.run({input, state, sr})` **in-process** (`src/vad.ts:200`). The RNN hidden state (`2×1×128`) is threaded call-to-call (`src/vad.ts:207`); `resetVAD` re-zeros it between recordings (`src/vad.ts:226`). Model file: `models/silero_vad.onnx`.

### 1.5 Post-capture gates (before STT)

`waitForInput` runs a gauntlet on the returned PCM before it will transcribe:
- **Cancel check #1** — `consumeCancelSignalForRecording()` (`src/input.ts:1814`): if the user hit ✕, keep a recovery WAV, archive as "not-transcribed", and return `null`.
- **Trailing-silence trim** — `trimTrailingSilenceForSTT` (`src/input.ts:1851`).
- **No-speech gate** — `evaluateNoSpeechGate` (`src/input.ts:1866`): drops recordings too short/quiet (RMS/dBFS), with `classifyCaptureFailure` producing a user-facing error when it looks like a broken mic (`src/input.ts:1874-1907`).
- **PTT speech gate** — `evaluatePttSpeechGate` (`src/input.ts:1911`): since PTT skips live VAD, it re-checks after the fact that *some* speech is present.
- Every stage emits a `control-layer-journal` event (`capture.started`, `capture.no_speech`, `capture.cancelled`, `capture.stt_trim`, …) via `appendControlLayerEvent`.

### 1.6 STT — whisper.cpp vs whisper-server vs Wispr (auto mode)

Backend chosen by `getBackend()` (`src/stt.ts:1453`), **cached for the process lifetime** (`cachedBackend`, `src/stt.ts:1447,1454`). Preference from `QA_VOICE_STT_BACKEND` (default `auto`):

- Explicit `whisper` / `whisper-server`|`resident` / `wispr` → that backend or a hard error.
- **`auto` order (`src/stt.ts:1491-1515`):**
  1. `WhisperServerBackend` (resident) if `isServerAvailable()` — needs a `whisper-server` binary **and** a model;
  2. else `WhisperCppBackend` (one-shot CLI);
  3. else `WisprFlowBackend` (cloud) if `QA_VOICE_WISPR_KEY` set;
  4. else throw with install instructions.

**`WhisperCppBackend` (`src/stt.ts:833`):** binary probe `whisper-cli` then `whisper-cpp` (`src/stt.ts:767`, `770-778`); model search: `QA_VOICE_WHISPER_MODEL` → `~/.cache/whisper/ggml-large-v3-turbo.bin` → any `ggml-*.bin` in `~/.cache/whisper/` (`src/stt.ts:782-812`). Runs `Bun.spawn([bin, "-m", model, "-f", audioPath, "--no-timestamps", ...langArgs, "--no-prints"])` (`src/stt.ts:897-912`). Metal shaders wired via `GGML_METAL_PATH_RESOURCES` from `brew --prefix whisper-cpp` (`src/stt.ts:874-877`). Language + initial-prompt vocabulary come from `language-config` and `stt-cleanup` (auto/hebrew/english; `src/stt.ts:882-895`).

**`WhisperServerBackend` (`src/stt.ts:961`):** talks to a resident whisper HTTP server (`transcribeViaServer`, `src/whisper-server.ts:750`), and **falls back to `WhisperCppBackend` per-request** if the sidecar dies or returns empty (`src/stt.ts:975`, `1009-1021`, `1048-1063`). This is where most of the STT complexity lives — chunked decode of long recordings (`transcribeChunkedLongRecording`, ≥90 s, 30 s windows/3 s overlap, `src/stt.ts:1170`), leading-punctuation repair (`verifyLeadingPunctuation`, `src/stt.ts:1066`), tail re-verification (`verifyTailForLongRecording`, `src/stt.ts:1118`), and echoed-trailing-phrase cleanup. Server binary probe `whisper-server` (`src/whisper-server.ts:157`); 8 s inference timeout (`src/whisper-server.ts:743`).

**`WisprFlowBackend` (`src/stt.ts:1307`):** cloud fallback. Opens a WebSocket to `wss://platform-api.wisprflow.ai/...` (`src/stt.ts:1330`), auths, streams the WAV as 1-second base64 packets (`src/stt.ts:1362-1385`), commits, and resolves on the first non-empty `text` frame; 30 s timeout.

The transcribing phase in `waitForInput`: `setRecordingState("transcribing")` → broadcast `warming` → `getBackend()` → `backend.transcribe(wavPath)` (or a chunked path when `QA_VOICE_CHUNKED_STT` is on, `src/input.ts:1966-1989`) → `finalizeTranscriptionTextForSurface` (`src/input.ts:1955-1995`).

### 1.7 STT-polish "server" — the Qwen3-**4B** text LLM (NOT the TTS daemon)

The task brief calls this the "Qwen3 STT-polish server." Precisely: it is a **separate OpenAI-compatible LLM server** that rewrites the raw transcript into clean prose. It is **not** the Qwen3-TTS daemon (§1.8) — different model, different port, different job.

- Raw text → `finalizeTranscriptionTextForSurface` (`src/input.ts:170`) → deterministic `finalizeTranscriptionText` cleanup **+** `polishTranscriptionText` (`src/stt-polish.ts:1159`).
- `polishTranscriptionText` mode from `QA_VOICE_STT_POLISH` (`off`|`on`|`shadow`, default `on`, `src/stt-polish.ts:86`). When on, it health-checks the endpoint (`/v1/models`), POSTs `raw+cleaned` to `/v1/chat/completions`, applies the candidate, and can retry no-op/rejected polishes once (`src/stt-polish.ts:1190-1277`). A Unix-socket transport (`polish.sock`) exists as an alternative when `QA_VOICE_STT_POLISH_SOCKET` is set (`src/stt-polish.ts:1279-1315`).
- **What launches it:** `ensureSTTPolishServer` (`src/stt-polish-server.ts:77`). `findPolishServerBinary()` looks for **`mlx_lm.server`** at `/Library/Frameworks/Python.framework/Versions/3.13/bin/mlx_lm.server`, Homebrew, or PATH (`src/stt-polish-server.ts:307-317`) — i.e. the **third-party `mlx-lm` pip tool**. It spawns `mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --host 127.0.0.1 --port 8080` (`src/stt-polish-server.ts:127-135`), polls `/v1/models` up to 120 s for readiness (`src/stt-polish-server.ts:159-182`), and reaps stale port-8080 owners first (`reapStaleDefaultPolishPortOwners`, `src/stt-polish-server.ts:206`).
- Constants: `DEFAULT_POLISH_ENDPOINT = http://127.0.0.1:8080/v1/chat/completions`, `DEFAULT_POLISH_MODEL = mlx-community/Qwen3-4B-Instruct-2507-4bit` (`src/stt-polish.ts:76-77`). Warmed at record-start (`warmPolishEndpointAtRecordingStart`, `src/input.ts:212`, `1769-1771`); auto-recovered after a failure (`recoverDefaultSTTPolishServerAfterFailure`, `src/stt-polish-server.ts:96`).
- **Rebuild note:** replaceable by any local OpenAI-compatible chat server, or by a direct call to a hosted model. The only Python here is the *third-party* `mlx_lm.server` binary; VoiceLayer just spawns it by argv.

### 1.8 Answer return + TTS response path (the question voice)

- After polish, `waitForInput` archives the recording, broadcasts `transcription`, sets state `idle`, and returns the string (`src/input.ts:2018-2051`). `handleConverse` wraps it via `formatAsk` and returns the MCP `textResult`.
- The **question** itself is synthesized by `speak()` (`src/tts.ts:1032`), a cascade gated on the resolved voice (`resolveVoice`, `src/tts.ts:1052`):
  - Guards: `assertSpeakerClear`, SSML strip (`sanitizeTtsText`), pronunciation fixups, `isTTSDisabled` flag (`src/tts.ts:1037-1049`).
  - Short-announce shortcut: cloned + `mode:"announce"` + `<50` chars → straight to edge-tts for speed (`src/tts.ts:1073-1085`).
  - **Cloned cascade (`src/tts.ts:1088-1177`):** Tier 0 **XTTS-v2** (`isXTTSAvailable`, `synthesizeXTTS`) → Tier 1a **F5-TTS MLX** (`profile.engine==="f5-tts-mlx"`, `synthesizeF5TTS`) → Tier 1b **Qwen3-TTS daemon** (`synthesizeCloned`, HTTP) → edge-tts fallback (unless a clone is *mandated*, in which case it throws `VoiceProfileUnavailableError`).
  - **Preset/default:** `speakWithEdgeTTS` (`src/tts.ts:1179-1180`).
- **Qwen3-TTS daemon** (`src/tts/qwen3.ts:527` `synthesizeCloned`): POST `http://127.0.0.1:8880/synthesize` with `{text, reference_wav, reference_text}` + bearer token, returns base64 MP3 (`src/tts/qwen3.ts:558-586`). `DAEMON_URL` = `http://127.0.0.1:8880` (`src/tts/qwen3.ts:27`).
- **edge-tts** (`speakWithEdgeTTS`, `src/tts.ts:1187`): spawns `python3 scripts/edge-tts-words.py --text=… --voice=… --rate=… --write-media=… --write-metadata=…` (`src/tts-health.ts:147-167`, `synthesizeWithRetry` at `src/tts-health.ts:193` with one retry + per-attempt timeout). Word-boundary NDJSON metadata drives the VoiceBar teleprompter.
- Playback: `playAudioNonBlocking` → `PlaybackQueueManager` → `afplay` subprocess (macOS); ring buffer of 20 MP3s (`RING_BUFFER_SIZE = 20`, `src/tts.ts:57`). `waitForPlayback` awaits `proc.exited` (`src/tts.ts:1297`).

---

## 2. Barge-in semantics (production vs SDK)

**Production `voice_ask` has no speech-onset barge-in.** The flow is sequential (§1.3): the question TTS drains *before* the mic opens. "Barge-in" in the shipping path means **terminating an in-flight subprocess on a signal**, two cases:

1. **Kill the recorder** — `terminateRecorderProcess` (`src/input.ts:1151`): `kill("SIGTERM")`, wait `graceMs=300`, then `kill("SIGKILL")`. Fired from `recordToBuffer`'s `finish()` on: stop signal (VAD loop `src/input.ts:1697-1704` or the 50 ms poll `src/input.ts:1518-1519`), VAD silence, PTT drain complete, timeout, or error.
2. **Kill playback** — `PlaybackQueueManager.stop()` (`src/tts.ts:690-714`): flushes pending jobs and `active.proc.kill("SIGTERM")` on the `afplay` process. Reached via the socket `stop` command and `stopPlayback()`.

**The real "user starts talking → stop the question" barge-in exists but is NOT wired into `voice_ask`.** It lives in the newer `src/voicesdk/session.ts` `speak()` (`monitorDuringPlayback` → `onSpeechStart` → `soundLayer.cancellation.stopPlayback()`, emitting `user.speech_started`/`user.interrupted`, `src/voicesdk/session.ts:172-208`). Treat this as a *separate capability to design fresh*, not something the current tool ships.

---

## 3. State files, flag files, and stop/cancel signals

Two storage tiers by trust level:

**Security-sensitive → `STATE_DIR = ~/.local/state/voicelayer/` (0700, user-only):**
- `recording-state.json` — `{state, pid, updated_at}` where `state ∈ {idle, recording, transcribing}` (`src/recording-state.ts:4,15-19`). Written atomically via `safeWriteFileSync` (symlink-refusing, `src/paths.ts:195-208`). Cross-process read-back verifies the write (`persistRecordingState`, `src/recording-state.ts:56-72`). `getEffectiveRecordingState()` (`src/recording-state.ts:99`) treats a persisted non-idle state as stale if its PID is dead (`process.kill(pid,0)` probe) — this is how the speaker-output gate and the "recording already in progress" guard see *another* process's capture. Path overridable via `QA_VOICE_RECORDING_STATE_PATH`.
- `STOP_FILE = STATE_DIR/stop-{SESSION_TOKEN}` (`src/paths.ts:66`) — touch to end recording/playback. `hasStopSignal()`/`clearStopSignal()` (`src/session-booking.ts:191,198`).
- `CANCEL_FILE = STATE_DIR/cancel-{SESSION_TOKEN}` (`src/paths.ts:69`) — set alongside STOP to **discard** the recording (skip transcription). Checked at three points in `waitForInput` (pre-STT, and again post-STT `src/input.ts:2009`). Comment at `src/paths.ts:65` notes STATE_DIR (not `/tmp`) is deliberate anti-symlink hardening.

**Coordination/kill flags → `/tmp` (world-readable, low-trust):**
- `.claude_tts_disabled` (`TTS_DISABLED_FILE`, `src/paths.ts:112`) — suppress TTS (`isTTSDisabled`).
- `.claude_mic_disabled` (`MIC_DISABLED_FILE`, `src/paths.ts:115`) — suppress mic (`isMicDisabled`, `src/input.ts:1138`, checked first in `recordToBuffer`).
- `.claude_voice_disabled` (`VOICE_DISABLED_FILE`, `src/paths.ts:118`) — hook-level block of all voice tools.
- `.voicelayer-daemon-disabled` (`src/paths.ts:126`) — MCP daemon polls this to exit cleanly.
- `/tmp/voicelayer-mcp.pid` (`MCP_PID_FILE`, `src/process-lock.ts:18`) — MCP singleton lock; `acquireProcessLock` SIGTERMs orphan owners on startup (`src/process-lock.ts:81-129`). Header comment (`src/process-lock.ts:10-13`) calls orphan MCP processes "the #1 reliability fix."

Lifecycle: `releaseVoiceSession()` (`src/session-booking.ts:159`) unlinks the lock and clears STOP on release. `SESSION_TOKEN` scopes STOP/CANCEL/LOCK per process so concurrent Claude sessions don't cross signals.

---

## 4. The Unix-socket NDJSON protocol

**Topology:** **VoiceBar (Swift) is the socket *server*; the TS MCP/CLI processes are *clients*.** Fixed path `/tmp/voicelayer.sock` (`getVoiceBarSocketPath`, `src/paths.ts:149`). VoiceBar survives MCP reconnects; there is no discovery file. Framing is **NDJSON** — one JSON object per line: `broadcast()` writes `serializeEvent(event)` to the connection (`src/socket-client.ts:95-103`); the Swift side buffers "NDJSON" per fd (`flow-bar/Sources/VoiceBar/SocketServer.swift:67`).

**Events — VoiceLayer → VoiceBar** (`SocketEvent` union, `src/socket-protocol.ts:169-180`):
| Event | Purpose |
|---|---|
| `state` | `idle`/`recording`/`transcribing`/`speaking` (+ `mode`, `silence_mode`, `source`) |
| `speech` | VAD detected speech onset (`detected:true`) |
| `transcription` | final transcript (+ optional `recording_path`) |
| `transcription_status` | `warming`/`transcribing` progress |
| `audio_level` | normalized RMS ~every 100 ms for the waveform |
| `error` | `{message, recoverable, capture_failure?, show_during_bar_recording?}` |
| `subtitle` | teleprompter word/caption feed |
| `queue` | playback queue snapshot (`depth`, ordered `items`) (`src/socket-protocol.ts:111-117`) |
| `command_mode` | dictation-command phase (`listening`→…→`done`) (`src/socket-protocol.ts:127-133`) |
| `clip_marker` | clip mark/consume markers |
| `ack` | ack of a received command (`{command, outcome, id?, reason?}`) (`src/socket-protocol.ts:161-167`) |

**Commands — VoiceBar → VoiceLayer** (`SocketCommand` union, `src/socket-protocol.ts:272-288`):
`stop`, `cancel`, `replay`, `retranscribe_last`, `retranscribe_recording{audio_path}`, `toggle{scope:all|tts|mic, enabled}`, `record{timeout_seconds?, silence_mode?, press_to_talk?}`, `health`, `command{operation, text, prompt?}`, `mark_clip{label, source?}`, `vocab_add{from,to}`, `vocab_list`, `vocab_remove{from}`, `vocab_add_term{term}`, `vocab_remove_term{term}`, `set_whisper_effort{effort}`.

The `record` command (`src/socket-protocol.ts:215-223`) is how the **VoiceBar hotkey** triggers a capture out-of-band from an MCP `voice_ask` — same `waitForInput` engine, `archiveSource:"voicebar"`.

---

## 5. VoiceBar — what it is and its role in capture

- **What:** a native **macOS SwiftUI app** (`flow-bar/`, `Package.swift`; UI in `flow-bar/Sources/VoiceBarUI/`, app/host in `flow-bar/Sources/VoiceBar/`). Installed as `/Applications/VoiceBar.app`. It is a persistent floating "pill" (status, waveform, teleprompter, transcription preview) plus a Settings window and a global **F5 hotkey** gesture state machine (tap/hold/double-tap/lock, `flow-bar/Sources/VoiceBar/HotkeyManager.swift:58-273`).
- **Socket role:** it *is* the server on `/tmp/voicelayer.sock` (`SocketServer.swift`, POSIX sockets + GCD), receiving events and sending commands (§4).
- **Daemon ownership (critical for capture):** per `CLAUDE.details.md`, launchd → `VoiceBar.app` → child `src/mcp-server-daemon.ts`. VoiceBar launches the MCP daemon as a **child process** *specifically so macOS Microphone TCC is inherited from the app bundle*. VoiceBar restarts the child on crash/clean-exit/broken-mic-silence unless `.voicelayer-daemon-disabled` exists.
- **VoiceBar does NOT capture audio itself.** Mic capture is always the TS side spawning `sox`/`rec` (§1.4). VoiceBar's part is: show state, and *request* captures via the `record` command. Swift path constants mirror `src/paths.ts` (`flow-bar/Sources/VoiceBar/VoiceLayerPaths.swift`).

---

## 6. Per-component language & runtime-dependency inventory

**Legend for "TS depends on it at runtime?":** `shell-out` = TS spawns it by argv and talks over pipe/HTTP/WS (swappable); `native addon` = loaded in-process; `n/a` = not TS.

| Component | Language / kind | Role in `voice_ask` | TS runtime dependency |
|---|---|---|---|
| MCP server / handlers / `input.ts` / `stt.ts` / `tts.ts` | **TypeScript (Bun)** | The whole orchestration | — (this *is* the app) |
| `onnxruntime-node` + `models/silero_vad.onnx` | **Native Node addon + ONNX model file** | Silero VAD endpointing, in-process (`src/vad.ts:25,200`) | **native addon (in-process)** — no Python |
| `sox` / `rec` | **Native binary** | Mic capture → raw PCM (`src/input.ts:1527`) | shell-out (required for capture) |
| `whisper-cli` / `whisper-cpp` + `ggml-large-v3-turbo.bin` | **Native binary + GGML model** | Local STT (`src/stt.ts:908`) | shell-out (required for local STT) |
| `whisper-server` | **Native binary (HTTP)** | Resident STT sidecar, auto-preferred (`src/whisper-server.ts`) | shell-out/HTTP (optional; falls back to CLI) |
| Wispr Flow | **Cloud WebSocket API** | Cloud STT fallback (`src/stt.ts:1330`) | network (optional; needs key) |
| `mlx_lm.server` (`mlx-lm` pip tool) + `Qwen3-4B-Instruct-2507-4bit` | **Python (MLX) binary, OpenAI-compatible HTTP :8080** | STT text **polish** LLM (`src/stt-polish-server.ts:307`) | shell-out/HTTP (optional; polish `off` disables) |
| `src/tts_daemon.py` + `mlx-audio` + Qwen3-TTS-4bit model :8880 | **Python (FastAPI/uvicorn/mlx-audio)** | Cloned-voice TTS daemon (`src/tts/qwen3.ts:558`) | shell-out/HTTP (optional; edge-tts fallback) |
| `scripts/edge-tts-words.py` + `edge-tts` | **Python CLI** | Preset TTS + word boundaries (`src/tts-health.ts:157`) | shell-out (default question voice) |
| `synthesizeXTTS` / `synthesizeF5TTS` (`src/tts/xtts.ts`, `f5tts.ts`) | **TS → Python MLX subprocess** | Higher-tier cloned TTS (`src/tts.ts:1093,1123`) | shell-out (optional) |
| `afplay` / `ffmpeg` | **Native binaries** | Audio playback / WAV→MP3 (`src/tts.ts`) | shell-out (macOS) |
| VoiceBar (`flow-bar/`) | **Swift / SwiftUI** | UI, socket server, MCP-daemon parent, hotkey | separate process (IPC) |

**Every Python file in the tree** (`find … -name '*.py'`) and its job:
- **On the runtime path (optional servers/scripts):** `src/tts_daemon.py` (Qwen3-TTS daemon, port 8880 — the only *project-authored* runtime Python), `scripts/edge-tts-words.py` (edge-tts CLI wrapper). The STT-polish server is the *third-party* `mlx_lm.server`, not a file in this repo.
- **Not on the runtime path:** `scripts/install-karabiner-voicebar-rule.py` (setup helper), `flow-bar/mock_server.py` (test double for the socket), `voice-coach.py` + `voice_coach/*.py` (a separate experimental coaching app, own `tts.py`/`stt.py`/`loop.py`/`audio.py`), `eval/*.py` (STT benchmark harness — `backends.py` re-implements whisper/wispr backends in Python, `speech_bakeoff.py`, `metrics.py`, `datasets.py`, etc.), `src/cli/extract.py` + `src/cli/clone.py` (voice-cloning setup CLIs, not `voice_ask`), `src/voicereview-web/kg_evidence.py` (web tool). **None of these run during a `voice_ask`.**

**Native (non-Python) dependencies and their exact job:** `onnxruntime-node` (in-process Silero VAD inference), `sox` (mic capture to raw PCM), `whisper.cpp` `whisper-cli`/`whisper-server` (STT decode; Metal-accelerated), `ggml-large-v3-turbo.bin` (whisper weights), `afplay` (playback), `ffmpeg` (WAV→MP3 for cloned audio).

**Bottom line for the rebuild:** a minimal pure-TS/Bun `voice_ask` needs only `sox` + `whisper-cli`/`ggml model` + `onnxruntime-node` + `afplay`. VAD is *already* Python-free. The only things that would drag in installed Python are the **optional** polish LLM and the **cloned-voice** TTS engines — both have non-Python fallbacks (skip polish; use edge-tts, itself a self-contained pip CLI you can swap for any TTS binary).

---

## 7. Config / env surface & macOS permissions

**STT:** `QA_VOICE_STT_BACKEND` (`auto`|`whisper`|`whisper-server`|`wispr`), `QA_VOICE_WHISPER_MODEL`, `QA_VOICE_WISPR_KEY`, `QA_VOICE_CHUNKED_STT`, `QA_VOICE_WHISPER_PERFORMANCE_EFFORT` (fast/balanced/accurate), language via `language-config`.
**STT polish** (`STTPolishEnv`, `src/stt-polish.ts:17-28`): `QA_VOICE_STT_POLISH` (off/on/shadow), `QA_VOICE_STT_POLISH_ENDPOINT`, `QA_VOICE_STT_POLISH_MODEL`, `QA_VOICE_STT_POLISH_SOCKET`, `..._TIMEOUT_MS`, `..._HEALTH_TIMEOUT_MS`, `..._LOG_PATH`, `VOICELAYER_STT_POLISH_WARMUP[_TIMEOUT_MS]`.
**TTS:** `QA_VOICE_TTS_VOICE`, `QA_VOICE_TTS_RATE`, `QA_VOICE_TTS_REQUIRE_CLONE`; TTS daemon secret via `VOICELAYER_TTS_DAEMON_SECRET_FILE` (`src/tts_daemon.py:52`).
**Paths/overrides:** `QA_VOICE_SOCKET_PATH`, `QA_VOICE_MCP_SOCKET_PATH`, `QA_VOICE_MCP_PID_PATH`, `QA_VOICE_RECORDING_STATE_PATH`, `QA_VOICE_RETAINED_RECORDING_PATH`, `DISABLE_VOICELAYER`, `QA_VOICE_DISABLE_FLAG_PATH`, `QA_VOICE_THINK_FILE`.

**macOS permissions (TCC) — three surfaces** (per `CLAUDE.details.md` Settings panel: "Microphone + Accessibility + Input Monitoring"):
- **Microphone** — required for `sox`/`rec`. Granted to `VoiceBar.app`; the MCP daemon inherits it by being launched as VoiceBar's **child** (the whole reason for that parent/child design). A bare terminal-launched MCP would need the terminal app itself granted mic access (see the `recordToBuffer` error hint, `src/input.ts:1380`).
- **Accessibility** — VoiceBar reads the frontmost selection / pastes dictation (`FrontmostSelectionReader`, command-mode).
- **Input Monitoring** — VoiceBar's global F5 hotkey / event tap.

---

## 8. What's genuinely hard-won vs boilerplate

**Hard-won (keep the lessons, they encode real bugs):**
- **Native-rate capture + JS resample** to dodge sox streaming buffer-overruns on non-16 kHz devices (AirPods 24 kHz) — `src/input.ts:1384-1386`.
- **Decoupled pipe-reader / VAD-processor** so ONNX latency never starves the sox pipe (`rms=0` bug) + defensive chunk copies — `src/input.ts:1594-1609` (R65/R66).
- **VAD RNN state threading** (context carry + `2×1×128` hidden state, reset between recordings) — `src/vad.ts:192-234`.
- **Cross-process recording-state with PID-liveness staleness**, so speaker-output gates and the recording-conflict guard see other processes' captures without deadlocking on a crashed one — `src/recording-state.ts:99-105`.
- **Atomic `wx` session lock + orphan-timeout cleanup** (TOCTOU-safe) and the MCP PID orphan-reaper (their self-declared #1 reliability fix) — `src/session-booking.ts:80-154`, `src/process-lock.ts`.
- **STT resiliency ladder**: resident-server → per-request CLI fallback → cloud; plus long-recording chunked decode and leading-punctuation / tail re-verification / echo-cleanup — `src/stt.ts:1066-1274`, `1491-1515`.
- **Capture gate gauntlet** (no-speech / trailing-silence trim / PTT post-gate / triple cancel checks with recovery-WAV retention) — `src/input.ts:1807-1926`, `2009-2016`.
- **Fail-closed cloned-voice policy** (a *mandated* clone throws rather than silently downgrading to a preset voice) and the SSML-injection strip — `src/tts.ts:1054-1065,1160-1168,1039-1040`.
- **Server supervision**: readiness polling, stale-port reaping, and auto-recovery-after-failure for both the whisper server and the polish server.
- **Security hardening**: STOP/CANCEL/recording-state in `~/.local/state` (0700) not `/tmp`, symlink-refusing writes, bearer-token + Host/Origin allowlist on the TTS daemon (`src/tts_daemon.py:104-159`).

**Boilerplate / mechanical (safe to reimplement from scratch):** MCP JSON-RPC envelope handling (`src/mcp-handler.ts`), the socket event/command type unions (`src/socket-protocol.ts`), WAV header assembly, ring-buffer bookkeeping, arg validation/`formatAsk`/`formatBusy` formatting, and the disable-flag file checks.

---

## Executive summary

VoiceLayer's `voice_ask` is a strictly sequential, mostly-TypeScript/Bun conversation turn: an MCP call (`handleVoiceAsk`→`handleConverse`) books an atomic per-session mutex, speaks the question through a cloned-voice→edge-tts cascade and *fully drains playback*, then opens the mic — `sox`/`rec` streamed into a decoupled reader/VAD-processor loop where **Silero VAD runs in-process via the `onnxruntime-node` native addon (no Python, contradicting the sibling `ts-portability.md`)** — endpoints on silence (VAD) or a stop-signal (PTT), passes the PCM through a no-speech/trim/cancel gauntlet, transcribes via an auto-selected whisper-server→whisper-cli→Wispr ladder, optionally polishes the text through a spawned third-party `mlx_lm.server` (Qwen3-4B LLM on :8080, distinct from the Qwen3-**TTS** daemon on :8880), and returns the string. State lives in files by trust tier (recording-state.json + STOP/CANCEL in `~/.local/state` 0700; kill-flags and PID locks in `/tmp`), and a **Swift SwiftUI VoiceBar app is the fixed-path `/tmp/voicelayer.sock` NDJSON server plus the launchd-supervised parent of the MCP daemon — the mechanism that grants microphone TCC — but it never captures audio itself**. "Barge-in" in the shipping tool is only SIGTERM-then-SIGKILL of the `rec`/`afplay` subprocesses on signal; true speak-over interruption exists only in an unwired `voicesdk/` SDK. For a pure-TS rebuild the Python surface is smaller than it looks: VAD, capture, STT, and playback are already Python-free binaries/addons, and the only Python (polish LLM + cloned-voice TTS) is optional with self-contained fallbacks.
