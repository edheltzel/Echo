# voice_ask in pure TypeScript/Bun — portability scoping (2026)

**Lane:** cross-vendor explorer (Themis dispatch, project Echo)
**Question:** rebuild VoiceLayer's `voice_ask` (speak a question → capture spoken answer → local STT → return text) as pure TypeScript/Bun, no Python runtime.
**Date:** 2026-07-13
**Author:** explorer lane

---

## 0. Framing: what "no Python" actually means here, and what we're replacing

Echo already shells out to non-TS binaries everywhere — `core/server.ts` spawns `/usr/bin/afplay`, `/usr/bin/say`, `osascript`, and `python3` (edge-tts) via `node:child_process` `spawn` / `Bun.spawn`. So "no Python" cannot mean "no subprocesses." The operative constraint, confirmed by Echo's own edge-tts usage, is:

> **No Python *libraries / daemons to install and maintain* (pip, venvs, torch, mlx, onnxruntime, a FastAPI server to babysit). Self-contained subprocess binaries invoked with argv are fine** — that is already the house pattern.

This reframing matters because it changes the whole answer. VoiceLayer's current `voice_ask` pipeline (read from `/Users/ed/Developer/_AI/voicelayer`) is:

| Stage | VoiceLayer today | Python-bound? |
|---|---|---|
| Mic capture | `sox` (`rec`) | **No** — it's a binary |
| VAD / endpointing | **Silero VAD (ONNX) via `silero-vad` + torch**, `models/silero_vad.onnx`, silence modes quick/standard/thoughtful | **Yes** — this is the Python/onnxruntime anchor |
| STT | `whisper.cpp` (`whisper-cli`/`whisper-cpp`), `ggml-large-v3-turbo.bin` in `~/.cache/whisper/` | **No** — it's a binary |
| Cleanup / TTS | mlx-audio + Qwen3 daemon (port 8880), fastapi/uvicorn/numpy/pydantic/soundfile | **Yes** — heavy Python |

The Python that has to die is concentrated in **exactly two places: the Silero-VAD ONNX/torch path and the mlx/Qwen cleanup+TTS stack.** Mic (`sox`) and STT (`whisper-cli`) are *already* Python-free binaries Echo can call directly. So the rebuild is smaller than it looks.

The single most important 2026 development that unlocks a clean rebuild: **whisper.cpp now ships built-in Silero VAD as a native ggml model (`--vad` / `--vad-model`)**, which deletes the onnxruntime dependency entirely (see §3). And on macOS 26, **Apple's on-device SpeechAnalyzer** (via the `yap` binary) collapses capture+VAD+STT into one binary with *zero model download and zero Python* (see §1).

---

## 1. Local STT

### Option A — `yap` (Apple SpeechAnalyzer/SpeechTranscriber CLI) · **wrap-binary + OS-service** · ⭐ recommended primary on macOS 26

`finnvoor/yap` — a Swift CLI over Apple's `SpeechAnalyzer`/`SpeechTranscriber` (the framework introduced at WWDC25, requires **macOS 26+**). `[HIGH]`

- **Install story (fresh Mac):** `brew install yap` (also `mint install finnvoor/yap`). No model download — the speech model is part of the OS / Apple Intelligence. `[HIGH]`
- **Capabilities:** file transcription (`yap transcribe`), **and live commands**: `yap dictate` (microphone), `yap listen` (system audio), `yap listen-and-dictate` (both). Output formats txt/srt/vtt/json, stream to stdout. **Ships its own MCP server** (`yap mcp`; `claude mcp add yap -- yap mcp`). `[HIGH]`
- **Why it's special:** `yap dictate` is capture + endpointing + STT in one on-device process. No `sox`, no VAD model, no whisper model, no Python, nothing on disk. This is the smallest possible `voice_ask`.
- **Size:** binary is tiny (Swift); models are OS-resident (0 bytes added). `[HIGH]`
- **Latency:** on-device, real-time streaming. Independent testing (MacStories/Daring Fireball/MacRumors, Jun 2025) measured Apple's SpeechAnalyzer at **~2.2× faster than MacWhisper's Whisper large-v3-turbo** on a 7 GB file with no quality regression. `[HIGH]`
- **License:** **CC0-1.0** (public domain) — forkable/vendorable with zero obligation, which de-risks the single-maintainer concern. `[HIGH]`
- **Maintenance risk:** single maintainer, young project, and **hard-gated to macOS 26** — a very recent OS, so it excludes anyone not yet upgraded. Mitigation: CC0 means Echo can vendor a frozen copy or reimplement the ~200-line Swift shim itself. `[MED]`
- **TCC caveat:** `yap dictate` opens the mic → same LaunchAgent attribution problem as any capture path (see §2).

### Option B — whisper.cpp CLI (`whisper-cli`) · **wrap-binary** · ⭐ recommended portable fallback

`ggml-org/whisper.cpp`, MIT. This is what VoiceLayer already uses, so it's proven in this exact role. `[HIGH]`

- **Install:** `brew install whisper-cpp` gives `whisper-cli`. Model is a separate download, e.g. `ggml-large-v3-turbo.bin` (~1.6 GB) or a smaller `ggml-base.en.bin` (~150 MB) / `ggml-small.en.bin` (~500 MB) into `~/.cache/whisper/`. `[HIGH]`
- **Latency:** on Apple Silicon (Metal), `base`/`small` run comfortably faster than real-time; `large-v3-turbo` is slower but is the accuracy sweet spot VoiceLayer settled on. VoiceLayer exposes effort tiers by tweaking beam-search/best-of (`-bo/-bs`) on the *same* turbo model. `[HIGH]`
- **Model-load penalty:** the CLI reloads the model every invocation. Fine for a one-shot `voice_ask` (one file per question), painful for a chatty loop. If per-turn latency bites, move to Option C. `[HIGH]`
- **License:** MIT (binary) + model weights (MIT-ish, ggml redistributions). `[HIGH]`
- **Maintenance risk:** low — large, active, canonical project.

### Option C — whisper.cpp **server** (`whisper-server`) · **OS-service (self-hosted binary)** · v2 upgrade

Same engine, kept warm behind an HTTP REST API (OpenAI-compatible endpoints, JSON/SRT/VTT out; single-threaded, mutex-serialized). Eliminates the per-call model-load penalty — the right move if `voice_ask` becomes a back-and-forth loop rather than one-shot. `[HIGH]`

- **Install friction (real):** `whisper-server` is **not in the Homebrew `whisper-cpp` bottle** — it must be compiled from source (`cmake`/`make` in the whisper.cpp tree). VoiceLayer's own ROADMAP flags this exact blocker for its streaming plan. So v1 should stay on the CLI; server is a deliberate v2 step with a build step in `scripts/`. `[HIGH]`
- **Fit with Echo:** a warm `whisper-server` is philosophically identical to Echo's own daemon — a localhost HTTP service. Echo could even supervise it as a sibling LaunchAgent. `[MED]`

### Option D — native Node bindings (smart-whisper / whisper.node / nodejs-whisper) · **native-binding** · ✖ avoid under Bun

`JacobLinCool/smart-whisper` (NAPI addon, auto model offload), `mybigday/whisper.node`, `ChetanXpro/nodejs-whisper` all wrap whisper.cpp as **NAPI native addons**. In-process, no subprocess — attractive on paper. `[HIGH]`

- **The problem:** they are the *same class of artifact* as `onnxruntime-node`, whose NAPI bindings **segfault/bus-error under Bun** across multiple versions (see §3, Bun issues #18079, #3574, opencode #26630). None of these whisper NAPI addons advertise or test Bun support. `[MED]` (direct Bun test not found for smart-whisper specifically; the failure mode is inherited from the NAPI-under-Bun pattern, which is well-documented `[HIGH]`).
- **Verdict:** the in-process convenience is not worth betting Echo's STT on Bun's shakiest surface. A `whisper-cli` subprocess is strictly safer and matches Echo's existing spawn idiom. **Wrap the binary, don't bind the library.**

### Option E — `hear` (older Apple Speech) · **wrap-binary + OS-service** · niche/legacy

`sveinbjornt/hear` — CLI over the *older* `SFSpeechRecognizer`. Works below macOS 26, `-d` forces on-device. But: the on-device recognizer is weaker than SpeechAnalyzer, and non-`-d` mode hits Apple's cloud with a **~500-character hard limit**. Only interesting if you must support pre-macOS-26 *and* refuse to ship a whisper model. Generally dominated by Option B. `[MED]`

---

## 2. Microphone capture on macOS from a Bun process

If you pick `yap dictate` for STT, **capture is solved inside that binary** — skip this section for the macOS-26 path. This section is for the portable (whisper) path, which needs a separate recorder.

### Option A — `sox` / `rec` · **wrap-binary** · ⭐ recommended

VoiceLayer already uses `sox`. `brew install sox`. Tiny, CoreAudio-native, GPL. `[HIGH]`

- **The killer feature for us:** sox's built-in **`silence` effect gives energy-threshold endpointing for free**, e.g.
  `rec out.wav rate 16k silence 1 0.1 3% 1 2.0 3%` — start on sound, **auto-stop after 2.0 s below 3% threshold**. That is end-of-utterance detection with **no VAD model, no onnxruntime, no Python** (see §3). `[HIGH]`
- **Echo fit:** one `spawn('rec', [...])`, identical to how `core/server.ts` already spawns `afplay`. Write to a **user-owned cache path, not `/tmp`** (Echo invariant forbids `/tmp`; VoiceLayer's `/tmp/voicelayer-stop-{TOKEN}` pattern must be relocated to e.g. `~/Library/Caches/echo/`).

### Option B — `ffmpeg -f avfoundation` · **wrap-binary** · alternative

`ffmpeg -f avfoundation -i ":<idx>" out.wav` (enumerate with `ffmpeg -f avfoundation -list_devices true -i ""`). Heavier binary, no built-in silence-stop as clean as sox's, but ubiquitous and already a VoiceLayer dep. Prefer sox for the silence-effect endpointing. `[HIGH]`

### Option C — small Swift/CoreAudio helper · **native-binding (out-of-process)** · v2 only

A ~100-line signed Swift binary (AVAudioEngine) invoked as a subprocess. Buys you: proper code-signing for clean TCC attribution, and tap-level PCM you can stream to a VAD/STT. Cost: you now ship and maintain a compiled helper. Only worth it if TCC attribution (below) proves intractable with sox. `[MED]`

### Option D — Web Audio via hidden browser · ✖ reject

`getUserMedia` in a headless/hidden Chrome (the approach `speak2me-mcp` and `cc-gc-stts` take with a persistent Chrome window). Drags a whole browser runtime and its own permission surface into a daemon. Antithetical to Echo's lean, binary-first design. Reject for Echo. `[HIGH]`

### TCC / mic-permission attribution — the real portability hazard `[HIGH]`

macOS gates the mic behind TCC, and TCC uses a **"responsible process" model**: when a process opens the mic, TCC walks *up* the process tree and attributes the request to the responsible ancestor — normally the GUI app that started the chain.

For a **headless LaunchAgent daemon** (which is exactly what Echo is, `com.echo`), this is genuinely awkward:

- A daemon spawning `sox`/`yap`/`ffmpeg` makes the child request the mic, but the **responsible process resolves to the daemon** — which has no GUI, so **the TCC consent prompt may never surface, and the mic access is silently denied** (documented daemon-vs-TCC failure mode; also seen in VS Code #307364 and t3code #728 where terminal-spawned children can't raise mic/camera prompts). `[HIGH]`
- Practical consequences to design around:
  1. **First-run consent must be triggered from a user-facing context**, not the daemon. Options: ship a tiny signed helper app that requests mic once; or run the very first capture from an interactive Terminal/agent session so the prompt attributes to (and is granted to) that GUI app; or pre-seed the grant.
  2. Whoever is listed as responsible needs `NSMicrophoneUsageDescription` and the grant in **System Settings → Privacy → Microphone**. For a subprocess chain, that's the *responsible ancestor*, which may show up as "Terminal" / "iTerm" / the agent host rather than "echo" — confusing for users, so **document who to grant**.
  3. `yap`/`sox` invoked from a logged-in Terminal generally works because Terminal is the responsible GUI app and already tends to hold mic permission. The failure surface is specifically the *background LaunchAgent* invocation.

**This is the #1 thing that will bite the rebuild** and deserves an explicit spike before committing to the daemon-spawns-recorder architecture. A clean mitigation: keep `voice_ask` capture attached to the invoking agent/terminal session (the thing that "asked the question") rather than the `com.echo` daemon, so consent lands on a real GUI app.

---

## 3. VAD / end-of-utterance

This is where the Python was, and where 2026 lets us delete it.

### Option A — sox `silence` effect (energy-threshold DSP, in the recorder) · **wrap-binary** · ⭐ recommended v1

Covered in §2A. Energy-threshold endpointing as a side effect of recording. No model, no onnxruntime, no Python, no extra process. Good enough for turn-taking in a quiet room; the classic weakness is noisy environments (it keys on loudness, not "speech-ness"). `[HIGH]`

### Option B — whisper.cpp built-in `--vad` (native Silero) · **wrap-binary** · ⭐ recommended for STT-time filtering

**The dependency-killer.** whisper.cpp now bundles **Silero VAD as a native ggml model**:
`whisper-cli --file in.wav --model ggml-base.en.bin --vad --vad-model ggml-silero-v6.2.0.bin` (short `-vm`). Model fetched via `./models/download-vad-model.sh silero-v6.2.0` (~a few MB). `[HIGH]`

- This gives you **the exact Silero quality VoiceLayer used, with zero onnxruntime and zero Python** — it runs inside the whisper binary you're already spawning. It replaces `models/silero_vad.onnx` + `silero-vad`/torch outright.
- **Caveat:** `--vad` operates on a *complete file* (it strips non-speech before transcription); it is **not a streaming end-of-utterance detector**. So it improves accuracy/speed of the STT pass, but it does **not** by itself decide "the user stopped talking." Pair it with Option A (sox silence) or Option D (push-to-talk) for the live stop decision. `[HIGH]`

### Option C — silero-vad via `onnxruntime-node` · **native-binding** · ✖ avoid (Ed's red-team flag confirmed)

Ed's red-team flagged `onnxruntime-node` as a zero-deps detonator. **Confirmed:** `onnxruntime-node`'s NAPI binding **crashes under Bun** — file-path/encoding breakage in Bun 1.2.5 (Bun #18079), **segfault in `onnxruntime_binding.node`** in Bun 1.3.13 (opencode #26630), bus error on init (Bun #3574). The upstream `ricky0123/vad-node` (server-side Node) is **being wound down / no further updates**. There is a WASM path (`onnxruntime-web` + `@ricky0123/vad-web`), but it's browser/worklet-oriented and would drag the hidden-browser problem back in. **Given Option B exists, there is no reason to touch onnxruntime under Bun.** `[HIGH]`

### Option D — push-to-talk only · **pure-TS / OS-service** · ⭐ recommended v1 dodge

Skip automatic endpointing for v1: press a key to start, press (or release) to stop. Echo **already has hotkey infrastructure** (the mute hotkey bindings via `osascript`/Karabiner documented in the HTTP API doc), and VoiceLayer already ships a stop-signal pattern (touch a token file). Reuse it: touch `~/Library/Caches/echo/voice-ask-stop-{token}` to end capture (relocated off `/tmp` per Echo invariant). Zero DSP, zero model, deterministic, and it's the most robust option in noisy/real-world conditions. `[HIGH]`

### Option E — energy-threshold VAD in pure TS · **pure-TS** · optional

Read PCM frames off the recorder's stdout and threshold RMS in TypeScript. ~30 lines, no deps, full control (hangover timers, adaptive noise floor). Only worth writing if you want endpointing *and* refuse to let sox own the stop decision. Marginal over Option A. `[MED]`

---

## 4. STT polish / cleanup (VoiceLayer's Qwen3 stage)

**Dispensable for v1.** `[HIGH]` Reasoning:

- whisper `large-v3-turbo` (and Apple SpeechAnalyzer) already emit punctuated, well-cased transcripts. The historical reason for an LLM cleanup pass — disfluency removal, homophone/entity fixing — matters most when the transcript is the *final artifact*. In `voice_ask`, **the transcript is immediately consumed by a capable calling agent (Claude/Codex)**, which interprets "um, yeah, the, uh, second one" without help.
- **v1: return the raw transcript.** If desired, add one line to the tool's response schema — a hint like *"transcript is raw ASR; interpret intent, don't quote verbatim."* Cost: zero infra.
- **v2 (if a standalone clean transcript is ever needed):** `llama.cpp` `llama-server` (**wrap-binary / self-hosted, no Python**) with a small instruct model (e.g. a 1–3B GGUF) doing a fixed "clean this transcript" prompt. This mirrors the whisper-server pattern and keeps the no-Python invariant. Avoid resurrecting a Qwen *Python* daemon. `[MED]`

The mlx-audio/Qwen3 **TTS** side of VoiceLayer is out of scope here — Echo already owns TTS (edge-tts + ElevenLabs). `voice_ask` only needs the *input* half.

---

## 5. Existing prior art worth mining

| Project | Stack | STT / mic / VAD choices | Relevance |
|---|---|---|---|
| **finnvoor/yap** (github.com/finnvoor/yap) | Swift CLI, CC0 | Apple SpeechAnalyzer on-device; `dictate` = live mic; ships an MCP `transcribe` tool | **Highest.** Vendorable, is literally the macOS-26 capture+STT engine we'd wrap. `[HIGH]` |
| **SmartLittleApps/local-stt-mcp** (github.com/SmartLittleApps/local-stt-mcp) | TypeScript MCP server | whisper.cpp, Apple-Silicon-optimized, "15×+ real-time", diarization | Reference for a **TS wrapper around whisper.cpp as an MCP tool** — closest architectural twin to the whisper path. `[HIGH]` |
| **sandipchitale/cc-gc-stts** (github.com/sandipchitale/cc-gc-stts) | Node 18+/TS, esbuild | `stt`+`tts` MCP tools + `/stts` **loop** (stt→answer→tts until silent); uses Web Speech API via a persistent Chrome window | Mine the **loop/turn-taking UX**; reject the hidden-Chrome capture approach for Echo. `[HIGH]` |
| **shreyaskarnik/voice-mcp** (github.com/shreyaskarnik/voice-mcp) | MCP, Apple Silicon | STT = Voxtral Realtime (4B int4) via **mlx-audio (Python)**; TTS = Kokoro | Good bidirectional-loop reference but **Python-bound STT** — the thing we're avoiding. Study the ergonomics, not the stack. `[MED]` |
| **CodingButter/speak2me-mcp** (github.com/CodingButter/speak2me-mcp) | **Elysia (Bun)** backend + React PWA | STT = Google Gemini (cloud); TTS = ElevenLabs; SSML via OpenAI | Useful as **Bun-native MCP server prior art**, but STT is cloud — wrong for local/private. `[MED]` |
| **regevbr/voice-mcp** (github.com/regevbr/voice-mcp) | MCP, local | local TTS+STT loop | Secondary reference. `[LOW]` |

No maintained project was found that already does the *exact* target (Bun-native, 100% local, no-Python `voice_ask` loop). The closest primitives are **yap** (macOS-26 engine) and **local-stt-mcp** (TS-over-whisper.cpp pattern) — compose those two and you've covered both OS tiers.

---

## Recommended v1 stack (smallest credible pipeline)

**Design rule: wrap self-contained binaries, spawn them exactly like `core/server.ts` already spawns `afplay`/`say`/`edge-tts`. Zero NAPI, zero onnxruntime, zero pip. Two tiers, chosen at runtime by OS version.**

```
                     ┌─ macOS 26+  ──▶  yap dictate  ──────────────▶  transcript
POST /notify (ask) ──┤                  (mic + endpoint + STT, one on-device binary,
  speak question     │                   no model download, no Python)
  via existing TTS   │
                     └─ macOS < 26 ──▶  rec (sox) ──▶ whisper-cli ──▶  transcript
                        (or user pref)   capture +      --vad (native
                                         silence-effect  silero ggml)
                                         endpointing      STT
```

- **Speak the question:** reuse Echo's existing TTS path (edge-tts/ElevenLabs) — already built.
- **Capture + endpoint + STT, Tier 1 (macOS 26):** `yap dictate` — one binary, `brew install yap`, CC0, nothing on disk, fastest. Handles all three stages.
- **Capture + endpoint, Tier 2 (portable):** `rec` (sox) with `silence 1 0.1 3% 1 2.0 3%` for energy-threshold end-of-utterance → WAV in `~/Library/Caches/echo/`. **Or** push-to-talk stop (touch-file / existing hotkey infra) for robustness in noise.
- **STT, Tier 2:** `whisper-cli --vad --vad-model ggml-silero-v6.2.0.bin` on the WAV. Native Silero VAD, no onnxruntime.
- **Cleanup:** none. Return the raw transcript; let the calling agent interpret.
- **Contract:** add a `voice_ask`-style endpoint/tool that returns `{ transcript, engine, durationMs }`. Keep it out of `core/` if it carries host specifics; the capture+STT wrapper is host-neutral and can live near `core/` as long as it only spawns binaries.

**What this buys:** no Python libraries, no onnxruntime, no NAPI-under-Bun risk, ≤2 Homebrew installs on the portable tier (`sox`, `whisper-cpp` + a model) and **0 extra installs** on macOS 26 (`yap`). Every moving part is a subprocess Echo already knows how to supervise.

**The one spike to do first:** TCC mic-permission attribution for a **LaunchAgent-spawned** recorder (§2). Resolve *who* the consent prompt attributes to before wiring capture into the `com.echo` daemon — likely by attaching capture to the invoking agent/terminal session rather than the headless daemon.

## v2 upgrade path

1. **Warm STT:** compile `whisper-server` (source build in `scripts/`), keep the model resident, POST audio chunks — kills the per-turn model-load penalty when `voice_ask` becomes conversational. (VoiceLayer's own roadmap targets ~1.5–2 s streaming latency this way.)
2. **Streaming/partial transcripts:** `yap dictate` already streams; on the whisper tier, chunked POST to `whisper-server` for live words.
3. **Optional transcript cleanup:** `llama-server` (llama.cpp) with a small GGUF, fixed clean-up prompt — only if a standalone clean transcript is ever needed. Still no Python.
4. **Signed capture helper:** if TCC attribution stays messy, a ~100-line signed Swift/CoreAudio recorder gives clean permission handling and PCM streaming.

---

### Confidence / verification notes
- `yap` install, live-mic commands, CC0, MCP server: verified by direct fetch of github.com/finnvoor/yap. `[HIGH]`
- whisper.cpp native `--vad`/`--vad-model` with downloadable Silero ggml: from whisper.cpp docs/issue #3003 + usage examples. `[HIGH]`
- onnxruntime-node breaking under Bun: multiple open Bun/opencode issues (#18079, #3574, opencode #26630). `[HIGH]`
- SpeechAnalyzer ~2.2× vs Whisper turbo: MacStories/MacRumors/Daring Fireball, Jun 2025 hands-on. `[HIGH]`
- VoiceLayer current stack (sox/whisper-cli/Silero-ONNX/Qwen): read from its `CLAUDE.details.md`, `README.md`, `ROADMAP.md`, `server.json`. `[HIGH]`
- smart-whisper/whisper.node specific Bun test: not found; risk inferred from the shared NAPI-under-Bun failure mode. `[MED]`
