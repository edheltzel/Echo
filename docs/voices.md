# Voices & per-turn persona voice

How to customize Echo's voices — the default (Atlas) voice, named personas, and
ElevenLabs — plus how a `voice_id` actually resolves, how to debug the wrong voice, and how
the Claude Code Stop hook speaks each turn in the right persona's voice. See
[`configuration.md`](configuration.md) for the full config reference,
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the request flow, and
[`adapters.md`](adapters.md) for the adapter wiring.

**Every change on this page requires a daemon restart** — `voices.json` and the env files are
read once at startup:

```bash
launchctl kickstart -k "gui/$UID/com.echo"
```

## How a `voice_id` resolves

Voices live in `core/voices.json`: `identity` is the default ("Atlas") voice, and each
`agents.<key>` entry is a named persona keyed by a short lowercase **name key** (`kai`,
`themis`, …). `getVoiceMapping` (`core/server.ts`) resolves a request's `voice_id` in this
exact order:

1. `voice_id` omitted (or empty) → `identity`. **This is the only name-free path to the
   Atlas voice.**
2. `agents.<voice_id>` — the name-key match.
3. Any agent whose `elevenlabs.voice_id` equals the value.
4. `identity` when the value equals `identity.elevenlabs.voice_id`.
5. Otherwise **no mapping**: each provider uses its own default voice — except ElevenLabs,
   where the unresolved value is passed through **raw** as an ElevenLabs voice id.

Two traps:

- `"voice_id": "atlas"` (or `"identity"`) is **not** the Atlas path — neither is a
  configured key, so both resolve as `fallback` (step 5). It happens to sound like Atlas
  today only because the edge-tts provider default and `identity.edgetts.voice` are both
  `en-US-AvaNeural`; change either, or make ElevenLabs the active provider (the raw
  pass-through then sends `atlas` as an invalid ElevenLabs id, that attempt fails, and the
  chain falls through), and they diverge. To get the identity voice, **omit `voice_id`**.
- Send the **name key**, not a raw provider voice id — the raw pass-through in step 5 is an
  ElevenLabs-only escape hatch, not the contract.

The resolved mapping supplies the per-provider voice and settings; a caller-supplied
`voice_settings` object or an emotional marker can override them (see
[`http-api.md`](http-api.md)). Every voice-enabled `/notify` logs how it resolved
(`identity-default` | `identity` | `agent-key` | `elevenlabs-id` | `fallback`) — see
"Debug" below.

## Audition edge voices

`scripts/preview-voices.ts` plays short samples so you can choose voices by ear before
editing `core/voices.json`. It calls `edge-tts` directly and is dev tooling — not part of
the runtime request path. `--list` and `--dry-run` are silent (CI-safe); the others play
audio.

```bash
bun scripts/preview-voices.ts --list                                # list English voices, no audio
bun scripts/preview-voices.ts --locale en-GB                        # audition all en-GB voices
bun scripts/preview-voices.ts --voices en-GB-RyanNeural,en-GB-ThomasNeural
bun scripts/preview-voices.ts --voices en-GB-ThomasNeural --rate -6%
bun scripts/preview-voices.ts --dry-run --voices en-GB-RyanNeural   # print synth command, no audio
```

| Flag | Purpose | Default |
|---|---|---|
| `--locale` | Comma-separated locale prefixes to audition | `en-US,en-GB,en-AU,en-IE` |
| `--voices` | Explicit voice ids (overrides `--locale`) | — |
| `--text` | Sample line spoken (`{voice}` is substituted) | `Hi, I'm {voice}. This is how I sound for Atlas.` |
| `--rate` | edge-tts rate applied to every sample | `+0%` |
| `--list` / `--dry-run` | Print matched voices (and synth command) without playing audio | off |

## Change the default (Atlas) voice

1. Audition candidates: `bun scripts/preview-voices.ts --list` / `--locale en-GB` (see above).
2. Edit `identity.edgetts.voice` (and optional `speed`) in `core/voices.json`.
3. Restart the daemon (command above).
4. Verify:

   ```bash
   curl -fsS -X POST http://localhost:8888/notify -H 'Content-Type: application/json' \
     -d '{"message":"default voice check"}'
   tail -1 ~/Library/Logs/echo/voice-resolution.jsonl | jq
   ```

   You should hear the new voice, and the event should read
   `"resolution":"identity-default"` with `"voice"` set to your new voice name.

## Change a persona's voice

1. Audition and confirm the target voice name exists (`--list`, as above).
2. Edit that agent's `edgetts.voice` (and optional `speed`) in `core/voices.json`.
3. Restart the daemon.
4. Verify with `-d '{"message":"voice check","voice_id":"<key>"}'` — the resolution event
   should read `"resolution":"agent-key"` with the new voice.

## Add a persona

1. Add a keyed entry to `agents` in `core/voices.json` — mirror an existing one:
   `description`, optional `catchphrase`, at least an `edgetts` block (validate the voice
   name with `--list`; add `kokoro`/`elevenlabs` blocks for parity). Restart the daemon.
2. Bind the persona to that key in its `atlas-config` brief (`~/.claude/agents/<Name>.md`):
   set frontmatter `voiceId: <key>` and make every self-voice `curl` POST
   `http://localhost:8888/notify` with `"voice_id":"<key>"`. The self-voice instruction must
   be in the brief **body** — frontmatter isn't visible to the agent.

Gotchas that cause silence: the frontmatter-visibility rule above; sending a raw ElevenLabs
id instead of the name key won't resolve while ElevenLabs is disabled; and port `31337` is
wrong — voice traffic is `:8888`.

`tests/core/voices-config.test.ts` iterates every `agents` entry, so new voices are validated
by `bun test`.

## Set up ElevenLabs

Prerequisites: Echo installed and running (`curl -fsS http://localhost:8888/health` returns
JSON); an ElevenLabs API key.

1. Put the key where the daemon reads it (see [`configuration.md`](configuration.md) for all
   accepted locations):

   ```bash
   mkdir -p ~/.config/echo
   echo 'ELEVENLABS_API_KEY=sk_…' >> ~/.config/echo/.env
   ```

2. In `core/voices.json`, set `providers.elevenlabs.enabled` to `true`. Leave
   `apiKey: "${ELEVENLABS_API_KEY}"` as shipped — it expands from the env at startup.
3. Restart the daemon so it re-reads both files.
4. Verify configuration:

   ```bash
   curl -fsS http://localhost:8888/health | jq '.providers.elevenlabs'
   ```

   You should see `"enabled": true`, `"healthy": true`, `"apiKeyConfigured": true`,
   `"wouldEgress": true`, `"egressTarget": "api.elevenlabs.io"`.
5. Verify synthesis — `/health` does not test the key against the API; a real request does:

   ```bash
   curl -fsS -X POST http://localhost:8888/notify -H 'Content-Type: application/json' \
     -d '{"message":"ElevenLabs check","voice_id":"kai"}'
   ```

   With ElevenLabs as the active provider you should hear Kai's ElevenLabs voice and the
   newest resolution event shows `"provider":"elevenlabs","success":true`. If it shows
   `outcome":"failed"`, check `~/Library/Logs/echo.log` for the API error (`401` = bad key).
   With the shipped order, edge-tts still speaks first — ElevenLabs is a fallback until you
   prefer it (next section).

**Prefer ElevenLabs as the primary voice:** set `"defaultProvider": "elevenlabs"` in
`voices.json`, restart, and confirm `curl -fsS http://localhost:8888/health | jq -r
.activeProvider` prints `elevenlabs`. Note ElevenLabs egresses to `api.elevenlabs.io` —
see [`providers-observability.md`](providers-observability.md).

## Debug: wrong voice or silence

Three signals, in order:

1. **Resolution log** — `tail -1 ~/Library/Logs/echo/voice-resolution.jsonl | jq` (fields:
   [`providers-observability.md`](providers-observability.md)). Branch on `resolution`:
   - `fallback` + `resolution_reason` → the `voice_id` isn't a configured name key. List
     valid keys with `jq -r '.agents | keys[]' core/voices.json`, fix the key or add the
     persona.
   - `agent-key` but the wrong `provider` spoke → read `attempts[]`: `disabled` = enable it
     in `voices.json` + restart; `circuit-open` = see `/health` `.circuit_breakers` and
     [`reliability.md`](reliability.md) (auto-retests after 60s); `unhealthy`/`failed` =
     provider-specific. Additive attempt fields (`phase`, `reason`, `stderr`, `timeout_ms`)
     narrow the branch: edge-tts `synthesis` means the real provider failed; edge-tts
     `health-import` appears in `/health` diagnostics only; kokoro usually means
     `127.0.0.1:8880` is down; ElevenLabs usually means the key or API response failed.
   - No new event at all → the request was `voice_enabled:false` (which skips both voice and
     the log write), rate-limited (`429`), or rejected (`400`) — check the HTTP response and
     the daemon log.
2. **`/health`** — `curl -fsS http://localhost:8888/health | jq` for the config/state
   snapshot: `activeProvider`, per-provider `enabled`/`healthy`, breaker state.
3. **Daemon log** — `~/Library/Logs/echo.log` for the human-readable per-request narrative
   (`📨 Notification`, `⏭️ Skipping <provider> (…)`, provider errors).

After any config change: restart, then re-send the test notify.

## Per-turn persona voice (Stop hook)

Every turn, the Claude Code Stop hook `adapters/claudecode/hooks/VoiceCompletion.hook.ts` speaks the
response's voice line. It is **persona-aware in both voice and words**: a single canonical
parser `parseFinalVoiceLine` (`adapters/claudecode/hooks/lib/TranscriptParser.ts`) reads the
response's trailing `🗣️ <Name>:` tag into `{name, words}`, and both the voice resolver and
the words extractor consume it so the chosen voice and the spoken words can never disagree.
`handleVoice` (`adapters/claudecode/hooks/handlers/VoiceNotification.ts`) calls
`selectVoice`/`resolvePersonaKey` (which delegate to `parseFinalVoiceLine`) for the
**voice**; `extractVoiceCompletion` (same parser) yields the **words**. When `<Name>` is a
non-DA persona (e.g. `🗣️ Themis:`), the hook sends that lowercase **name key** as `voice_id`
(daemon resolves `themis` → `en-US-MichelleNeural`) and speaks the persona's own line. When
the speaker is the DA (Atlas) or there is no tag, both voice (`mainDAVoiceID` + prosody) and
words are the unchanged Atlas path.

This is DRY and self-cleaning: the signal is the response the hook already parses (no marker
files, env vars, or registries), so dropping a persona reverts to Atlas on the next turn
automatically. For a **main-session** persona to be voiced, its turns must carry the
`🗣️ <Persona>:` tag (the global response format already does this).
`parseFinalVoiceLine`/`resolvePersonaKey`/`selectVoice` are covered by
`tests/adapters/claudecode/voice-persona-resolution.test.ts`; `extractVoiceCompletion`'s
persona-words behavior by `tests/adapters/claudecode/voice-completion-words.test.ts`.

The Stop hook is repo-owned and registered into `settings.json` by `restore-hooks.ts`
(replacing any unmanaged `~/.claude/hooks/VoiceCompletion.hook.ts`), alongside VoiceGate and
VoiceGreeting. Its transcript parsing lives in
`adapters/claudecode/hooks/lib/{hook-io,TranscriptParser}.ts` (host-specific — never in `core/`).
