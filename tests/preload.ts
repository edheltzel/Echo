// bun test preload (wired in bunfig.toml): every test process resolves Echo
// configuration from a scratch path, never the operator's real
// ~/.config/echo/config.json. config.json is authoritative over live process
// values, so a real operator setting (PORT, state paths, persona) would
// otherwise override the isolation env the singleton-server tests set before
// importing core - a #47-class hazard against the live daemon. Tests that
// model config.json write their own file and point ECHO_CONFIG_FILE at it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ECHO_CONFIG_FILE = join(
  mkdtempSync(join(tmpdir(), "echo-test-config-")),
  "config.json",
);
// Disable the playback-state publisher unless a test opts in. PlayQueue writes
// this file on every transition; without the pin, unit tests would rewrite the
// operator's ~/.local/state/echo/playback-state.json.
process.env.ECHO_PLAYBACK_STATE_PATH ??= "";
