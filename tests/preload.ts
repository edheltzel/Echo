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

const scratch = mkdtempSync(join(tmpdir(), "echo-test-config-"));
process.env.ECHO_CONFIG_FILE = join(scratch, "config.json");
// The output mode is read on every dequeue; never let the operator's real
// mode.json switch in-process daemon tests to sounds-only.
process.env.ECHO_MODE_STATE_PATH = join(scratch, "mode.json");
