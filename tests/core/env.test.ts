import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoundedInt, primeEchoFileEnv, resolveEchoEnv } from "../../core/env";
import {
  CANONICAL_DECIMAL,
  ECHO_CONFIG_KEYS,
  MAX_CONFIG_PORT,
  MIN_CONFIG_PORT,
  echoConfigPath,
  loadEchoConfiguration,
  loadEchoConfigurationWithStatus,
  validateEchoConfig,
} from "../../shared/echo-env";

// parseBoundedInt is the single guard behind every numeric env override in the
// voice system (issue #25). A degenerate value (NaN / negative / below floor)
// must fall back to the documented DEFAULT, never to a value that masks a real
// outage (0ms timeout, 0 retries, threshold that opens on the first failure).
describe("parseBoundedInt - degenerate env values fall back to default", () => {
  test("valid in-range values are parsed", () => {
    expect(parseBoundedInt("30000", 15000, 1)).toBe(30000);
    expect(parseBoundedInt("3", 1, 0)).toBe(3);
  });

  test("non-numeric / undefined / empty fall back", () => {
    expect(parseBoundedInt("abc", 15000, 1)).toBe(15000);
    expect(parseBoundedInt(undefined, 15000, 1)).toBe(15000);
    expect(parseBoundedInt("", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("   ", 15000, 1)).toBe(15000);
  });

  test("values below the floor fall back (negative always rejected)", () => {
    expect(parseBoundedInt("-5", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("-1", 2, 1)).toBe(2);
  });

  // PORT's ceiling: an out-of-range value would throw inside Bun.serve and leave
  // launchd crash-looping the daemon. Floor 0 is deliberate for the LIVE process
  // value - PORT=0 is the tests' ephemeral-bind mode and must never fall back to
  // the real :3246. A configured 0 never reaches here; config.json validation
  // rejects it (see the PORT range test below).
  test("values above the max fall back; no max means unbounded", () => {
    expect(parseBoundedInt("99999", 3246, 0, 65535)).toBe(3246);
    expect(parseBoundedInt("65535", 3246, 0, 65535)).toBe(65535);
    expect(parseBoundedInt("0", 3246, 0, 65535)).toBe(0);
    expect(parseBoundedInt("-1", 3246, 0, 65535)).toBe(3246);
    expect(parseBoundedInt("99999", 15000, 1)).toBe(99999);
  });

  describe("call-site floors", () => {
    // timeout floor 1: 0ms would make setTimeout fire instantly → every synth
    // "times out" → false outage.
    test("EDGETTS_TIMEOUT_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 15000, 1)).toBe(15000);
      expect(parseBoundedInt("1", 15000, 1)).toBe(1);
    });

    // retries floor 0: 0 retries is a LEGITIMATE config (single attempt), so it
    // must be honored - only NaN/negative fall back.
    test("EDGETTS_SYNTH_RETRIES floor allows 0 but rejects NaN/negative", () => {
      expect(parseBoundedInt("0", 1, 0)).toBe(0);
      expect(parseBoundedInt("abc", 1, 0)).toBe(1);
      expect(parseBoundedInt("-2", 1, 0)).toBe(1);
    });

    // backoff floor 1.
    test("EDGETTS_SYNTH_BACKOFF_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 250, 1)).toBe(250);
      expect(parseBoundedInt("500", 250, 1)).toBe(500);
    });

    // threshold floor 1: 0/negative would open the breaker on (or before) the
    // first failure → masks nothing but defeats the tuning; falls back to 2.
    test("CIRCUIT_BREAKER_THRESHOLD floor rejects 0 and negative", () => {
      expect(parseBoundedInt("0", 2, 1)).toBe(2);
      expect(parseBoundedInt("-1", 2, 1)).toBe(2);
      expect(parseBoundedInt("3", 2, 1)).toBe(3);
    });
  });
});

// resolveEchoEnv is the import-pure replacement for the daemon's old
// hydrate-process.env-at-import loop (the pi-adapter "Atlas" pollution):
// config.json wins, old process values are a deprecated fallback, legacy
// dotenv values come last, and resolving NEVER writes to process.env.
describe("resolveEchoEnv - import-pure config resolution", () => {
  afterEach(() => {
    primeEchoFileEnv(undefined); // restore lazy real-file loading
    delete process.env.ECHO_ENV_TEST_KEY;
  });

  test("the resolved config layer wins over a live process value", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "from-file" });
    process.env.ECHO_ENV_TEST_KEY = "from-process";
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-file");
  });

  test("falls back to a live process value when resolved config is absent", () => {
    primeEchoFileEnv({});
    process.env.ECHO_ENV_TEST_KEY = "from-process";
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-process");
  });

  test("an empty resolved value still wins over the live process layer", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "" });
    process.env.ECHO_ENV_TEST_KEY = "from-process";
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("");
  });

  test("resolving never mutates process.env (import-purity contract)", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "from-file" });
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-file");
    expect(process.env.ECHO_ENV_TEST_KEY).toBeUndefined();
  });

  test("reads a real env file via ECHO_ENV_PATHS (quotes stripped, first wins)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "echo-env-"));
    try {
      writeFileSync(join(tmp, "a.env"), 'ECHO_ENV_TEST_KEY="first"\n');
      writeFileSync(join(tmp, "b.env"), "ECHO_ENV_TEST_KEY=second\n");
      const saved = process.env.ECHO_ENV_PATHS;
      process.env.ECHO_ENV_PATHS = `${join(tmp, "a.env")}:${join(tmp, "b.env")}`;
      primeEchoFileEnv(undefined); // force a fresh lazy load with these paths
      try {
        expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("first");
        expect(process.env.ECHO_ENV_TEST_KEY).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.ECHO_ENV_PATHS;
        else process.env.ECHO_ENV_PATHS = saved;
        primeEchoFileEnv(undefined);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reads config.json before the legacy .env migration layer", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-json-config-"));
    try {
      const configDir = join(home, ".config", "echo");
      const configPath = echoConfigPath(home);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        PORT: 3246,
        ECHO_VOICE_PERSONA_NAME: "Configured Echo",
        ECHO_TTS_CACHE_MAX_BYTES: 123456,
      }));
      writeFileSync(join(configDir, ".env"), "PORT=7777\nECHO_VOICE_PERSONA_NAME=Legacy\n");

      const resolved = loadEchoConfiguration({}, home);
      expect(resolved.PORT).toBe("3246");
      expect(resolved.ECHO_VOICE_PERSONA_NAME).toBe("Configured Echo");
      expect(resolved.ECHO_TTS_CACHE_MAX_BYTES).toBe("123456");
      expect(process.env.ECHO_VOICE_PERSONA_NAME).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ignores retired legacy aliases while migrating canonical values", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-retired-alias-"));
    try {
      const configDir = join(home, ".config", "echo");
      mkdirSync(configDir, { recursive: true });
      const retiredKey = ["VOICE", "SYSTEM_", "DEFAULT_TITLE"].join("");
      writeFileSync(join(configDir, ".env"), `${retiredKey}=Old\nECHO_DEFAULT_TITLE=New\n`);
      const resolved = loadEchoConfiguration({}, home);
      expect(resolved.ECHO_DEFAULT_TITLE).toBe("New");
      expect(resolved[retiredKey]).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config.json overrides deprecated live values without mutating process.env", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-json-precedence-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(echoConfigPath(home), JSON.stringify({ PORT: 3246, ECHO_VOICE_PERSONA_NAME: "File" }));
      const { env, config } = loadEchoConfigurationWithStatus(
        { PORT: "9999", ECHO_VOICE_PERSONA_NAME: "Live", ELEVENLABS_API_KEY: "secret" },
        home,
      );
      expect(env.PORT).toBe("3246");
      expect(env.ECHO_VOICE_PERSONA_NAME).toBe("File");
      expect(env.ELEVENLABS_API_KEY).toBe("secret");
      expect(config.deprecatedEnvironment).toEqual(["ECHO_VOICE_PERSONA_NAME", "PORT"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECHO_VOICE_PERSONA_NAME, PORT"));
      expect(process.env.PORT).not.toBe("9999");
      expect(process.env.ECHO_VOICE_PERSONA_NAME).toBeUndefined();
    } finally {
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("deprecated environment and dotenv fallbacks warn while third-party secrets do not", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-deprecated-env-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(
        join(home, ".config", "echo", ".env"),
        "ECHO_DEFAULT_TITLE=Legacy file\nELEVENLABS_API_KEY=file-secret\n",
      );
      const { env, config } = loadEchoConfigurationWithStatus(
        { ATLAS_VOICE_ID: "legacy-alias", ECHO_VOICE_TITLE: "Live", ELEVENLABS_API_KEY: "live-secret" },
        home,
      );

      expect(env.ECHO_DEFAULT_TITLE).toBe("Legacy file");
      expect(env.ECHO_VOICE_TITLE).toBe("Live");
      expect(env.ATLAS_VOICE_ID).toBe("legacy-alias");
      expect(env.ELEVENLABS_API_KEY).toBe("live-secret");
      expect(config.deprecatedEnvironment).toEqual([
        "ATLAS_VOICE_ID",
        "ECHO_DEFAULT_TITLE",
        "ECHO_VOICE_TITLE",
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ATLAS_VOICE_ID, ECHO_DEFAULT_TITLE, ECHO_VOICE_TITLE"),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("ELEVENLABS_API_KEY"));
    } finally {
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // PORT is the one key the dotenv layer must not carry: the bash surfaces read
  // only config.json + a live PORT, so a dotenv PORT would move the daemon
  // somewhere every CLI and health probe reports as down.
  test("PORT is not migrated from the legacy dotenv layer", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-dotenv-port-"));
    try {
      const configDir = join(home, ".config", "echo");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, ".env"), "PORT=8888\nECHO_DEFAULT_TITLE=From dotenv\n");
      const resolved = loadEchoConfiguration({}, home);
      expect(resolved.PORT).toBeUndefined();
      expect(resolved.ECHO_DEFAULT_TITLE).toBe("From dotenv");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A typo or a key written by a newer Echo must cost the user that one key,
  // never every other setting in the file.
  test("an invalid key is dropped while the rest of config.json still applies", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-partial-config-"));
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(echoConfigPath(home), JSON.stringify({
        ECHO_DEFAULT_TITLE: "Kept",
        ECHO_VOICE_PERSONA_NAME: "Kept too",
        NOT_AN_ECHO_KEY: "dropped",
        ELEVENLABS_API_KEY: "secret",
      }));

      const { env, config } = loadEchoConfigurationWithStatus({}, home);
      expect(env.ECHO_DEFAULT_TITLE).toBe("Kept");
      expect(env.ECHO_VOICE_PERSONA_NAME).toBe("Kept too");
      expect(env.NOT_AN_ECHO_KEY).toBeUndefined();
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
      expect(config.present).toBe(true);
      expect(config.ignored.sort()).toEqual(["ELEVENLABS_API_KEY", "NOT_AN_ECHO_KEY"]);
      expect(config.errors).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ECHO_CONFIG_FILE retargets the same file the writer resolves", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-config-file-"));
    try {
      const custom = join(home, "elsewhere.json");
      writeFileSync(custom, JSON.stringify({ ECHO_DEFAULT_TITLE: "From override" }));
      expect(echoConfigPath(home, { ECHO_CONFIG_FILE: custom })).toBe(custom);
      expect(loadEchoConfiguration({ ECHO_CONFIG_FILE: custom }, home).ECHO_DEFAULT_TITLE).toBe("From override");
      // Default resolution stays deterministic - an ambient override in the
      // operator's environment must not reach a caller that did not pass it.
      expect(echoConfigPath(home)).toBe(join(home, ".config", "echo", "config.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("schema rejects secrets, retired aliases, unknown keys, and compound values", () => {
    expect(validateEchoConfig({ ELEVENLABS_API_KEY: "secret" })).toHaveLength(1);
    expect(validateEchoConfig({ RETIRED_ECHO_DEFAULT_TITLE: "old" })).toHaveLength(1);
    expect(validateEchoConfig({ notEcho: true })).toHaveLength(1);
    expect(validateEchoConfig({ ECHO_VOICE_ID: ["voice"] })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: 3246, ECHO_VOICE_ENABLED: false })).toEqual([]);
  });

  // A configured port the bash surfaces cannot target is a permanent split-brain:
  // the daemon binds it, every CLI and health probe stays on 3246. 0 is the
  // sharpest case - an ephemeral bind has no address to hand a CLI at all.
  test("a configured PORT outside 1-65535 is rejected, including 0", () => {
    expect(validateEchoConfig({ PORT: 0 })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: "0" })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: 65536 })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: -1 })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: true })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: "not-a-port" })).toHaveLength(1);
    expect(validateEchoConfig({ PORT: 1 })).toEqual([]);
    expect(validateEchoConfig({ PORT: "8888" })).toEqual([]);
    expect(validateEchoConfig({ PORT: 65535 })).toEqual([]);
  });

  // Every spelling below is in range for at least one reader and a different
  // port (or 0) for another: Number() reads the radix prefixes that base-10
  // parsing stops at, and bash reads a leading-zero operand as octal. Only
  // canonical decimal resolves identically in all three.
  test("a configured PORT must be canonical decimal, not another numeric spelling", () => {
    for (const port of ["0x0C9E", "0b1100100", "0o6246", "1e4", "03246", "+3246", "3246.5", " ", ""]) {
      expect(validateEchoConfig({ PORT: port })).toHaveLength(1);
    }
    // Padding is rejected in both positions. The shell reader captures the value
    // whole and cannot trim, so tolerating it on this side is what put the daemon
    // on a port every CLI surface reported as down.
    for (const port of [" 3246 ", "3246 ", " 3246", "\t3246"]) {
      expect(validateEchoConfig({ PORT: port })).toHaveLength(1);
    }
    expect(validateEchoConfig({ PORT: "3246" })).toEqual([]);
    expect(validateEchoConfig({ PORT: 3246 })).toEqual([]);
  });

  test("a PORT spelled in a radix the daemon cannot parse is dropped, not silently bound", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-hex-port-"));
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(echoConfigPath(home), JSON.stringify({ PORT: "0x0C9E", ECHO_DEFAULT_TITLE: "Kept" }));

      const { env, config } = loadEchoConfigurationWithStatus({}, home);
      expect(env.PORT).toBeUndefined();
      expect(env.ECHO_DEFAULT_TITLE).toBe("Kept");
      expect(config.ignored).toEqual(["PORT"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a configured PORT of 0 is dropped and reported, leaving the daemon on 3246", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-zero-port-"));
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(echoConfigPath(home), JSON.stringify({ PORT: 0, ECHO_DEFAULT_TITLE: "Kept" }));

      const { env, config } = loadEchoConfigurationWithStatus({}, home);
      expect(env.PORT).toBeUndefined();
      expect(env.ECHO_DEFAULT_TITLE).toBe("Kept");
      expect(config.ignored).toEqual(["PORT"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Lockstep in BOTH directions. A schema key missing from ECHO_CONFIG_KEYS is
  // the worse half: the daemon would call the user's own documented setting "not
  // an Echo configuration key" and drop it at runtime.
  test("the checked-in schema and ECHO_CONFIG_KEYS describe exactly the same keys", () => {
    const schema = JSON.parse(readFileSync("shared/config-schema.json", "utf8"));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.PORT.default).toBe(3246);
    // The declared grammar is what config.json validation enforces and what
    // scripts/echo-port.sh accepts - all three must agree or the daemon and the
    // CLI end up on different ports. `minimum`/`maximum` are numeric keywords
    // and say nothing about the string form, so that branch carries the pattern.
    // Compared against the live regex, not a copy of it: the schema is what a
    // user validating their config with a standard tool sees, so widening the
    // grammar without widening the schema has to fail here.
    const [numeric, text] = schema.properties.PORT.anyOf;
    expect(numeric).toEqual({ type: "integer", minimum: MIN_CONFIG_PORT, maximum: MAX_CONFIG_PORT });
    expect(text).toEqual({ type: "string", pattern: CANONICAL_DECIMAL.source });
    expect(schema.properties.ELEVENLABS_API_KEY).toBeUndefined();
    for (const key of ECHO_CONFIG_KEYS) expect(schema.properties[key]).toBeDefined();
    for (const key of Object.keys(schema.properties)) expect(ECHO_CONFIG_KEYS.has(key)).toBe(true);
  });

  // The third home for the same bounds. The shell helper cannot import them, so
  // pin its literals here: a range only two of the three readers agree on is the
  // daemon and the CLI landing on different ports.
  test("scripts/echo-port.sh enforces the same port range", () => {
    const helper = readFileSync("scripts/echo-port.sh", "utf8");
    expect(helper).toContain(`[ "$port" -ge ${MIN_CONFIG_PORT} ]`);
    expect(helper).toContain(`[ "$port" -le ${MAX_CONFIG_PORT} ]`);
  });
});
