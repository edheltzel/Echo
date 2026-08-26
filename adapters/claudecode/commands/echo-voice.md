---
description: Give the current project its own Echo persona (name + voice), overriding the global one in this repo only.
argument-hint: [persona name] [edge-tts voice, optional]
allowed-tools: Bash, Read, Edit, Write
---

You are scaffolding a **project-local Echo persona** for the current repository.
Echo resolves the DA identity with layered precedence - `.claude/settings.local.json`
→ `.claude/settings.json` → `~/.claude/settings.json` → defaults, per key - so a
`daidentity` block in *this* project's `.claude/settings.json` overrides the global
persona **for this repo only** (name + voice on every per-turn line). Follow the
authoritative startup policy in `docs/voices.md#per-project-persona--voice`.
Every other repo keeps the global persona.

Arguments (either may be omitted): `$ARGUMENTS`
- First token → the persona **name** (e.g. `Echo`).
- Second token → an **edge-tts voice** id (e.g. `en-US-AndrewNeural`).

## Steps

1. **Resolve the project dir.** Use `$CLAUDE_PROJECT_DIR` (fall back to the repo root
   from `git rev-parse --show-toplevel`). The target file is `<projectDir>/.claude/settings.json`.

2. **Get the persona name.** If not supplied in the arguments, ask the user for one.

3. **Get the voice.** If a voice id was not supplied, list the available edge-tts
   voices so the user can choose (and audition if they like):
   - List: `bun scripts/preview-voices.ts --list`
   - Audition one: `bun scripts/preview-voices.ts --voices <voice-id>`
   Confirm the chosen voice id (must be a real edge-tts voice, e.g. `en-GB-RyanNeural`).

4. **Merge - never clobber.** Read the existing `<projectDir>/.claude/settings.json`
   (create `{}` if it does not exist). Deep-merge the block below into it, preserving
   every other key already present. Only set the persona keys:
   ```json
   {
     "daidentity": {
       "name": "<persona name>",
       "voices": { "main": { "voiceId": "<edge-tts voice id>" } }
     }
   }
   ```
   - Following `docs/voices.md`, add `"sayName": true` only when the user wants the
     startup greeting to announce the name. For project-specific startup lines, add
     `"startupCatchphrases": ["...", "..."]`; the array replaces the inherited or
     default pool, and `{name}` remains governed by `sayName`.
   - Write the merged JSON back with 2-space indentation.

5. **Decide shared vs per-machine.** Default to the checked-in `.claude/settings.json`
   (shared with anyone who clones the repo). If the user says the voice is
   machine-specific, write to `.claude/settings.local.json` instead (gitignored
   overlay; it wins over `.claude/settings.json` per key).

6. **Confirm.** Show the final `daidentity` block and tell the user it takes effect
   on the **next** Claude Code session started in this repo. Summarize any startup
   options written and note that `~/.claude/settings.json` is untouched - the global
   persona is unchanged everywhere else.

Keep it surgical: touch only the `daidentity` persona keys, leave all other settings intact.
