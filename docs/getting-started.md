# Hear your first spoken notification

In this tutorial, we install Echo on your Mac and hear it speak. By the end, a background service on this machine will speak any JSON message sent to `localhost:3246`.

Turn the volume up before the last step. You should hear the words "Hello from Echo."

## What you will build

A macOS LaunchAgent named `com.echo` that:

- Speaks JSON POSTed to `localhost:3246/notify`
- Starts when you log in
- Can stay silent when you mute it

We prove it with `curl`. Wiring Claude Code, Pi, or another host comes after you have heard the smoke.

## Prerequisites

You need:

- A Mac. Echo installs as a LaunchAgent.
- [Bun](https://bun.sh/). Install it with `curl -fsSL https://bun.sh/install | bash`.
- `git`

Check Bun:

```bash
bun --version
```

You should see a version number, for example `1.2.4`.

## Step 1: Get the code

```bash
git clone https://github.com/edheltzel/Echo.git
cd Echo
```

The clone should finish without errors. `ls` should show `core/`, `scripts/`, and `adapters/`.

## Step 2: Install the core

```bash
cli/echo install --adapter none
```

This registers the LaunchAgent `com.echo` and starts it. The output should end with:

```
OK echo is healthy on :3246
```

If you see `Voice server did not respond. Check logs: ~/Library/Logs/echo.log`, open that log. The last few lines say what failed. Fix the cause and rerun the same install command. Running it again is safe.

## Step 3: Confirm it is healthy

```bash
curl -fsS http://localhost:3246/health
```

You should see JSON that starts like this:

```json
{"status":"healthy","port":3246,...}
```

## Step 4: Hear Hello from Echo

Volume up. Then:

```bash
curl -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from Echo"}'
```

Omitting `voice_id` resolves as `identity-default`. That is `voices.json` `identity`, edge `en-GB-RyanNeural`, not the provider `defaultVoice` (Ava). You should hear that identity voice say "Hello from Echo" (if edge-tts is installed for `/opt/homebrew/bin/python3`) and see:

```json
{"status":"accepted","message":"Notification queued","request_id":"..."}
```

HTTP `202` means the daemon accepted the line. Your ear is the check that it spoke. Anything on this machine can now speak by POSTing to `localhost:3246/notify`.

## Step 5: Try a named persona

```bash
curl -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Themis here. Ready to coordinate.","voice_id":"themis"}'
```

You should hear a different voice. Themis maps to edge `en-US-MichelleNeural`. When you omit `voice_id`, Echo uses the identity mapping from step 4 (`identity-default`). There is no `atlas` agent key.

## If you hear nothing, or the wrong voice

Work through these checks in order.

1. Confirm the daemon is running:

   ```bash
   bash scripts/status.sh
   ```

   You should see `Service: com.echo` with a loaded entry and `Health: OK`. If it shows `not loaded` or `Health: FAIL`, rerun `cli/echo install --adapter none`. If the installer refuses because port 3246 is occupied but not answering, run `cli/echo doctor`. It names each degraded check and the command that fixes it.

2. Check the daemon log:

   ```bash
   tail -20 ~/Library/Logs/echo.log
   ```

3. Ask Echo why it chose the voice it did. Every spoken notification appends one line to the voice-resolution log:

   ```bash
   tail -3 ~/Library/Logs/echo/voice-resolution.jsonl
   ```

   You should see JSON with a `provider` field and an `attempts` array.

**Wrong voice on the no-`voice_id` smoke?** Check 3 should show `"resolution":"identity-default"` and `"voice":"en-GB-RyanNeural"`. Ryan is a British male. That is the identity voice, not a fallback.

If `"resolution"` is `fallback` and the voice is `en-US-AvaNeural`, that is the edge provider `defaultVoice`, not identity. The smoke omitted `voice_id`, so that is the wrong path.

If you hear macOS `say` ("Daniel") instead of Ryan, Echo fell back to the built-in macOS voice. Read the latest `attempts[]`. Edge is skipped only when it is disabled or its circuit breaker is open. Otherwise a `failed` Edge attempt means real synthesis failed. A common cause is that edge-tts is not installed for Homebrew Python at `/opt/homebrew/bin/python3`:

```bash
/opt/homebrew/bin/python3 -m pip install edge-tts
bash scripts/restart.sh
```

If `/opt/homebrew/bin/python3` does not exist, install Python first with `brew install python`, then rerun the two commands above. Repeat step 4. You should now hear Ryan (`en-GB-RyanNeural`).

**No sound, but the curl returned `"status":"accepted"`?** Check the output device and the volume, then the resolution log in check 3. If the last line has `"success":false`, the `attempts` array tells you which provider failed.

## Mute it for a shared office

Echo is optional. If someone is in the room:

```bash
cli/echo mute on
```

Send the same "Hello from Echo" request again. You should still get `"status":"accepted"`, and you should hear nothing. Then:

```bash
cli/echo mute off
```

Mute is machine-wide. It does not stop Oh My Pi live chat. Layers and states: [What Echo does](what-echo-does.md).

## What you have done

You installed Echo as a self-starting macOS service, confirmed `/health`, heard "Hello from Echo", picked a persona, and proved that runtime mute turns the audio off without rejecting the request.

## Next steps

- Wire a host so Claude Code, Pi, oh-my-pi, Jcode, Grok Build, or Codex speaks on its own. [How to install Echo](install-human.md)
- After wiring Claude Code, Pi, or omp, give this project a persona with `/echo-voice [name] [voice]` inside the repo. [Voices](voices.md#per-project-persona--voice-local-override)
- Pick voices by ear in [voices.md](voices.md)
- Start, stop, restart, mute vs daemon disable, and update after a pull in [operations.md](operations.md#mute-vs-daemon-disable)
- Look up `/notify` in [http-api.md](http-api.md)

Want Echo to ask you a question out loud? That is a separate, opt-in capability. It needs `sox` (`rec`) and a local transcriber. The first ask needs macOS microphone permission, and on the measured Pi and omp path the prompt names your terminal application, not Echo. Read [converse.md](converse.md#before-you-enable-it) before you enable it. First-class speech-to-text as a standing product is [roadmap](https://github.com/edheltzel/Echo/issues/179).
