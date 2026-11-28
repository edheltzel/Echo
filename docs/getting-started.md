# Hear your first spoken notification

In this tutorial, we install Echo on your Mac and hear it speak. By the end, a background service on this machine will speak any JSON message sent to `localhost:3246`.

Turn the volume up before the last step. You should hear the words "Hello from Echo."

Three words used below: the **daemon** is the background program that speaks. A **LaunchAgent** is the macOS way to start it at login. An **adapter** is a small plugin that connects an agent app to Echo.

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
- Node.js, for `npx`. Any current version works.
- edge-tts for Homebrew Python. Without it Echo falls back to the macOS "Daniel" voice.

You do not need git or a copy of the repository.

Check Bun:

```bash
bun --version
```

You should see a version number, for example `1.2.4`.

Check edge-tts:

```bash
/opt/homebrew/bin/python3 -m pip show edge-tts
```

You should see a `Name: edge-tts` block. If you see `No such file or directory` or `WARNING: Package(s) not found`, fix it:

```bash
brew install python
/opt/homebrew/bin/python3 -m pip install edge-tts
```

## Step 1: Install Echo

```bash
npx agent-echo install --adapter none
```

This copies Echo to `~/Library/Application Support/echo/source`, registers the LaunchAgent `com.echo` and starts it. The output should end with:

```
OK echo is healthy on :3246
```

If you see `Voice server did not respond. Check logs: ~/Library/Logs/echo.log`, open that log. The last few lines say what failed. Fix the cause and rerun the same install command. Running it again is safe.

For installation from a clone, see [How to install Echo](install-human.md#install-core-only).

## Step 2: Confirm it is healthy

```bash
curl -fsS http://localhost:3246/health
```

You should see JSON that starts like this:

```json
{"status":"healthy","port":3246,...}
```

Then run the full check:

```bash
npx agent-echo doctor
```

It ends with `Result: READY`. Any failing row prints the command that fixes it.

## Step 3: Hear Hello from Echo

Volume up. Then:

```bash
curl -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from Echo"}'
```

You should hear a British male voice say "Hello from Echo" and see:

```json
{"status":"accepted","message":"Notification queued","request_id":"..."}
```

HTTP `202` means the daemon accepted the line. Your ear is the check that it spoke. Anything on this machine can now speak by POSTing to `localhost:3246/notify`. If the voice is wrong or you hear nothing, see the table below.

## Step 4: Try a named persona

First list the persona keys your daemon knows:

```bash
curl -s http://localhost:3246/voices
```

Then pass one as `voice_id`. This example uses `kai`:

```bash
curl -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Kai here. Ready to help.","voice_id":"kai"}'
```

You should hear a faster, livelier voice than in step 3.

## If you hear nothing, or the wrong voice

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No sound, but curl returned `"status":"accepted"` | Output device or volume, or every provider failed | Check the output device and volume. Run check 3 below: if the last line has `"success":false`, the `attempts` array names the provider that failed. |
| You hear the macOS "Daniel" voice | Echo fell back to the built-in `say` voice because edge-tts synthesis failed. Usually edge-tts is missing for `/opt/homebrew/bin/python3` | Run `brew install python` if that path is missing, then `/opt/homebrew/bin/python3 -m pip install edge-tts`. [Restart Echo](operations.md#restart) and repeat step 3. |
| Wrong voice on the smoke | Omitting `voice_id` uses the `identity` voice in `voices.json`, edge `en-GB-RyanNeural` (a British male). That is not a fallback. If check 3 shows `"resolution":"fallback"` and `en-US-AvaNeural`, that is the edge provider `defaultVoice`. | Check 3 should show `"resolution":"identity-default"` and `"voice":"en-GB-RyanNeural"`. To change the identity voice, see [voices.md](voices.md). |
| Daemon not running | The LaunchAgent is not loaded | Run `npx agent-echo status`. If it says `not running`, rerun `npx agent-echo install --adapter none`. |
| Installer says port 3246 is occupied | Another process holds the port without answering Echo's `/health` | Run `npx agent-echo doctor`. It names each degraded check and the fix. Echo never kills the port owner. |

Diagnostic commands, in order:

1. Confirm the daemon is running:

   ```bash
   npx agent-echo status
   ```

   You should see `running on :3246` in the `Daemon` row with a `loaded` marker. See [Status](operations.md#status) for the dashboard fields and offline behavior.

2. Check the daemon log:

   ```bash
   tail -20 ~/Library/Logs/echo.log
   ```

3. Ask Echo why it chose the voice it did. Every spoken notification appends one line to the voice-resolution log:

   ```bash
   tail -3 ~/Library/Logs/echo/voice-resolution.jsonl
   ```

   You should see JSON with a `provider` field and an `attempts` array. Edge is skipped only when it is disabled or its circuit breaker is open. Otherwise a `failed` Edge attempt means real synthesis failed.

## Mute it for a shared office

Echo is optional. If someone is in the room:

```bash
npx agent-echo mute on
```

You should see `Mute: ON` and `Targets: speaker, microphone`. Send the same "Hello from Echo"
request again. You should still get `"status":"accepted"`, and you should hear nothing. Then:

```bash
npx agent-echo mute off
```

That prints `Mute: OFF`. Mute is machine-wide. It does not stop Oh My Pi live chat. Layers and
states: [What Echo does](what-echo-does.md).

## Keep it up to date

One command fetches the newest release and reloads the service:

```bash
npx agent-echo@latest update
```

See [Update](operations.md#update) for settings preservation and recovery details.

## Uninstall

```bash
npx agent-echo uninstall
```

This removes the LaunchAgent and the staged daemon payload. It keeps your logs and config. Add `--check` to preview. Adapter registrations survive it; see [Uninstall](install-human.md#uninstall).

## What you have done

You installed Echo as a self-starting macOS service, confirmed `/health`, heard "Hello from Echo", picked a persona, and proved that runtime mute turns the audio off without rejecting the request.

## Next steps

**Recommended next: wire your agent so it speaks on its own.** For Claude Code run `npx agent-echo install --adapter claudecode`. Use `codex`, `pi` or `empryo` in place of `claudecode` for those hosts. All hosts: [How to install Echo](install-human.md).

More:

- Hear a waiting agent from across the desk. [When an agent needs you](what-echo-does.md#when-an-agent-needs-you)
- Give a project a persona with `/echo-voice [name] [voice]`. [Voices](voices.md#per-project-persona--voice-local-override)
- Pick voices by ear in [voices.md](voices.md)
- Start, stop, restart, and mute vs daemon disable in [operations.md](operations.md#mute-vs-daemon-disable)
- Look up `/notify` in [http-api.md](http-api.md)

Want an agent to ask you a question out loud and hear your answer? That is voice ask, Echo's speech-to-text feature: one spoken question, one spoken reply, transcribed on your Mac and returned to the agent. It is opt-in and needs `sox` (`rec`) and a local transcriber. The first ask needs macOS microphone permission, and on the measured Pi and omp path the prompt names your terminal application, not Echo. Set it up with [Voice ask (speech-to-text)](converse.md#before-you-enable-it).
