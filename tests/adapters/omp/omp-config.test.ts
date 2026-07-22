import { describe, expect, test } from "bun:test";
import { loadOmpVoiceConfig } from "../../../adapters/omp/config";

describe("omp voice config — notify endpoint resolution", () => {
  test("defaults to the local daemon", () => {
    expect(loadOmpVoiceConfig({}).endpoint).toBe("http://localhost:8888/notify");
  });

  test("honors ECHO_NOTIFY_URL and its legacy aliases verbatim", () => {
    expect(loadOmpVoiceConfig({ ECHO_NOTIFY_URL: "http://echo.example/notify" }).endpoint).toBe(
      "http://echo.example/notify",
    );
    expect(
      loadOmpVoiceConfig({ ATLAS_VOICE_NOTIFY_URL: "http://legacy.example/notify" }).endpoint,
    ).toBe("http://legacy.example/notify");
    expect(
      loadOmpVoiceConfig({ VOICESYSTEM_NOTIFY_URL: "http://older.example/notify" }).endpoint,
    ).toBe("http://older.example/notify");
  });

  test("ECHO_DAEMON_URL retargets the notify endpoint, winning over ECHO_NOTIFY_URL", () => {
    expect(loadOmpVoiceConfig({ ECHO_DAEMON_URL: "http://localhost:8899" }).endpoint).toBe(
      "http://localhost:8899/notify",
    );
    expect(
      loadOmpVoiceConfig({
        ECHO_DAEMON_URL: "http://localhost:8899",
        ECHO_NOTIFY_URL: "http://echo.example/notify",
      }).endpoint,
    ).toBe("http://localhost:8899/notify");
  });
});
