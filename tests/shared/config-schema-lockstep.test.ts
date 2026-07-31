import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ECHO_CONFIG_KEYS } from "../../shared/echo-env.ts";

// shared/echo-env.ts says its key list and shared/config-schema.json must stay
// in lockstep, and until now nothing checked it. The two drift in opposite,
// equally quiet ways: a key in the schema but not the list is dropped at load
// with an "is not an Echo configuration key" warning, and a key in the list but
// not the schema is accepted at runtime while an editor validating against the
// schema marks the operator's config invalid.

const schema = JSON.parse(readFileSync("shared/config-schema.json", "utf8")) as {
  additionalProperties: boolean;
  properties: Record<string, unknown>;
};

describe("config schema lockstep", () => {
  test("every documented schema property is an accepted configuration key", () => {
    const missing = Object.keys(schema.properties).filter((key) => !ECHO_CONFIG_KEYS.has(key));

    expect(missing).toEqual([]);
  });

  test("every accepted configuration key is documented in the schema", () => {
    const undocumented = [...ECHO_CONFIG_KEYS].filter((key) => !(key in schema.properties));

    expect(undocumented).toEqual([]);
  });

  test("the schema rejects unknown keys, matching the loader's own rule", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test("the secret that config.json must never hold is absent from both", () => {
    // ELEVENLABS_API_KEY lives in a dotenv file permanently; config.json
    // rejects it by name in validateEchoConfigEntry.
    expect(ECHO_CONFIG_KEYS.has("ELEVENLABS_API_KEY")).toBe(false);
    expect("ELEVENLABS_API_KEY" in schema.properties).toBe(false);
  });
});
