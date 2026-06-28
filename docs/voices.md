# Voices & per-turn persona voice

How per-persona voices are configured and resolved, and how the Claude Code Stop hook speaks each
turn's completion in the right persona's voice. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
for the request flow and [`adapters.md`](adapters.md) for the adapter wiring.

## Voice config & resolution

Per-persona voices live in `core/voices.json` under `agents`, keyed by a short lowercase
name. `getVoiceMapping` (`core/server.ts`) resolves a request `voice_id` by: (1) `agents`
name key, (2) any `elevenlabs.voice_id`, (3) `identity`, else the active provider's default.
Callers send the **name key** (e.g. `"themis"`), not a raw provider voice id.

**Change a voice:** edit that agent's `edgetts.voice`/`speed`, then reload the daemon
(`launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"`). Audition first with
`bun scripts/preview-voices.ts --list` / `--locale`.

**Add a voice/persona:** add a keyed entry (mirror an existing one; validate the voice name
with `--list`), reload the daemon. Then bind the persona in its `atlas-config` brief
(`~/.claude/agents/<Name>.md`): set frontmatter `voiceId: <key>` and make every self-voice
`curl` POST `http://localhost:8888/notify` with `"voice_id":"<key>"`. The self-voice
instruction must be in the brief **body** (frontmatter isn't visible to the agent). Full
walkthrough: README → **Voices**.

`tests/core/voices-config.test.ts` iterates every `agents` entry, so new voices are validated
by `bun test`.

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
