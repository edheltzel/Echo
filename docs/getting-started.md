# Get Started with Echo

In this tutorial, we'll install the Echo voice server on your Mac and hear it speak its
first notification. By the end, you'll have a background service that speaks any message
sent to it — from a script, a coding agent, or a plain `curl`.

This takes about 5 minutes.

## What you'll build

A voice daemon running as a macOS LaunchAgent that:

- Speaks any JSON message POSTed to `localhost:8888/notify`
- Starts automatically when you log in
- Speaks in different persona voices when you ask for them

## Prerequisites

Before starting, make sure you have:

- A Mac (Echo installs as a macOS LaunchAgent)
- [Bun](https://bun.sh/) — install it with `curl -fsSL https://bun.sh/install | bash`
- `git`

Verify Bun is available:

```bash
bun --version
```

You should see a version number, for example `1.2.4`.

## Step 1: Get the code

Clone the repository and move into it:

```bash
git clone https://github.com/edheltzel/Echo.git
cd Echo
```

You should see the clone complete without errors, and `ls` shows `core/`, `scripts/`,
and `adapters/` directories.

## Step 2: Install the core

Run the installer. It registers Echo as the LaunchAgent `com.echo` and starts it:

```bash
bash scripts/install.sh --adapter none
```

The output ends with:

```
OK echo is healthy on :8888
```

If you instead see `Voice server did not respond. Check logs: ~/Library/Logs/echo.log`,
open that log — the last few lines say what failed. Fix and rerun the installer; it is
safe to run repeatedly.

## Step 3: Verify it's healthy

Ask the daemon how it's doing:

```bash
curl -fsS http://localhost:8888/health
```

You should see a JSON response starting with:

```json
{"status":"healthy","port":8888,...}
```

## Step 4: Send your first spoken notification

Turn your volume up, then run:

```bash
curl -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from Echo"}'
```

If edge-tts is installed for `/opt/homebrew/bin/python3`, you should hear the default
"Ava" voice say *"Hello from Echo"* and see:

```json
{"status":"success","message":"Notification sent","request_id":"..."}
```

That's it — Echo is working. Anything on your machine can now speak by POSTing to
`localhost:8888/notify`.

## Step 5: Try a persona voice

Echo ships with named persona voices. Ask for one with `voice_id`:

```bash
curl -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Themis here. Ready to coordinate.","voice_id":"themis"}'
```

You should hear a different female voice (Michelle) speak the line. When you omit
`voice_id`, Echo uses the default Atlas identity voice you heard in Step 4.

## If you hear nothing — or the wrong voice

Work through these checks in order:

1. **Confirm the daemon is running:**

   ```bash
   bash scripts/status.sh
   ```

   You should see `Service: com.echo` with a loaded entry and `Health: OK`. If it shows
   `not loaded` or `Health: FAIL`, rerun `bash scripts/install.sh --adapter none`.

2. **Check the daemon log for errors:**

   ```bash
   tail -20 ~/Library/Logs/echo.log
   ```

3. **Ask Echo why it chose the voice it did.** Every spoken notification appends one
   line to the voice-resolution log:

   ```bash
   tail -3 ~/Library/Logs/echo/voice-resolution.jsonl
   ```

   You should see JSON lines with a `provider` field (who spoke) and `attempts` (which
   providers were tried and why they were skipped).

**Wrong voice — a British male voice ("Daniel") instead of Ava?** The default voice
engine, edge-tts, isn't installed, so Echo fell back to the built-in macOS `say` voice.
Echo looks for edge-tts via the Homebrew Python at `/opt/homebrew/bin/python3`. Install
it and restart:

```bash
/opt/homebrew/bin/python3 -m pip install edge-tts
bash scripts/restart.sh
```

If `/opt/homebrew/bin/python3` doesn't exist, install Python first with
`brew install python`, then rerun the two commands above.

Repeat Step 4 — you should now hear Ava.

**No sound at all, but the curl returned `"status":"success"`?** Check your output
device and volume, then check the resolution log (check 3 above): if the last line has
`"success":false`, the `attempts` array tells you which provider failed and how.

## What you've learned

In this tutorial, you:

- Installed Echo as a self-starting macOS service
- Verified its health over HTTP
- Made it speak with a plain `curl` — no fields required beyond your message
- Selected a persona voice with `voice_id`
- Learned where the logs are when something sounds wrong

## Next steps

- **Wire up a host adapter** — have Claude Code or Pi speak automatically:
  [install-human.md](install-human.md)
- **Change or add voices** — pick different persona voices by ear:
  [voices.md](voices.md)
- **Look up the full HTTP API** — every `/notify` field:
  [http-api.md](http-api.md)
