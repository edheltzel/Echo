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
// Every in-process /notify fires the legacy macOS banner; point it at a no-op so
// a test run never puts a notification on the operator's screen. Banner
// assertions compare against this value, which core captures at first import.
process.env.ECHO_OSASCRIPT_BIN = "/usr/bin/true";
// Every host config a reconciler or persona reader can touch (~/.claude, ~/.pi,
// ~/.omp, ~/.codex, ~/.grok, ~/.jcode, ~/.config/opencode) resolves from HOME or
// XDG_CONFIG_HOME unless one of the overrides below is set. A spawned reconciler
// inherits process.env, so a test that pins only one of its paths would otherwise
// write the rest into the operator's real home (#203's mode test rewrote the live
// OpenCode plugin link and pruned opencode.json this way). Overrides exported in
// the operator's shell would point straight back at real config, so drop them;
// a test that needs one sets it on the child it spawns.
process.env.HOME = join(scratch, "home");
process.env.XDG_CONFIG_HOME = join(scratch, "home", ".config");
for (const name of [
  "CODEX_HOME", "GROK_HOME", "JCODE_HOME", "JCODE_CONFIG_PATH", "PI_CODING_AGENT_DIR", "PI_SETTINGS_PATH",
  "PAI_SETTINGS_PATH", "OMP_EXTENSIONS_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR",
  "ECHO_CLAUDE_COMMANDS_DIR", "ECHO_CODEX_HOOKS_FILE", "ECHO_CODEX_SKILLS_DIR", "ECHO_GROK_HOOKS_DIR",
  "ECHO_GROK_SKILLS_DIR", "ECHO_MCP_CONFIG_PATH", "ECHO_OPENCODE_COMMANDS_DIR", "ECHO_OPENCODE_CONFIG",
  "ECHO_OPENCODE_PLUGINS_DIR",
  // Inside a Herdr pane these point adapters' native visual delivery at the live
  // Herdr server, so any test calling sendNotification would pop a real Herdr
  // notification. Tests that exercise the Herdr route inject their own context.
  "HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_CONFIG_PATH",
]) {
  delete process.env[name];
}
