import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DAEMON_BASE,
  resolveDaemonBase,
  resolveNotifyUrl,
  resolvePersonalityUrl,
  resolveVoicesUrl,
} from "../../shared/daemon-endpoints";

// One base, one answer: every endpoint an adapter talks to derives from
// resolveDaemonBase, so ECHO_DAEMON_URL can never point notify at one instance
// and the read endpoints at another.

describe("daemon endpoint resolution", () => {
  test("defaults to the local daemon when nothing is configured", () => {
    expect(resolveDaemonBase({})).toBe(DEFAULT_DAEMON_BASE);
    expect(resolveNotifyUrl({})).toBe("http://localhost:8888/notify");
    expect(resolvePersonalityUrl({})).toBe("http://localhost:8888/notify/personality");
    expect(resolveVoicesUrl({})).toBe("http://localhost:8888/voices");
  });

  test("ECHO_DAEMON_URL retargets every endpoint at once", () => {
    const env = { ECHO_DAEMON_URL: "http://localhost:8899" };
    expect(resolveNotifyUrl(env)).toBe("http://localhost:8899/notify");
    expect(resolvePersonalityUrl(env)).toBe("http://localhost:8899/notify/personality");
    expect(resolveVoicesUrl(env)).toBe("http://localhost:8899/voices");
  });

  test("a trailing slash on ECHO_DAEMON_URL does not double up", () => {
    const env = { ECHO_DAEMON_URL: "http://localhost:8899/" };
    expect(resolveNotifyUrl(env)).toBe("http://localhost:8899/notify");
    expect(resolveVoicesUrl(env)).toBe("http://localhost:8899/voices");
  });

  test("ECHO_NOTIFY_URL alone is honored verbatim, and seeds the base for the rest", () => {
    const env = { ECHO_NOTIFY_URL: "http://echo.example:9000/notify" };
    expect(resolveNotifyUrl(env)).toBe("http://echo.example:9000/notify");
    expect(resolveDaemonBase(env)).toBe("http://echo.example:9000");
    expect(resolveVoicesUrl(env)).toBe("http://echo.example:9000/voices");
  });

  test("legacy notify aliases keep working verbatim", () => {
    expect(resolveNotifyUrl({ ATLAS_VOICE_NOTIFY_URL: "http://legacy.example/notify" })).toBe(
      "http://legacy.example/notify",
    );
    expect(resolveNotifyUrl({ VOICESYSTEM_NOTIFY_URL: "http://older.example/notify" })).toBe(
      "http://older.example/notify",
    );
    // Canonical wins over the legacy names.
    expect(
      resolveNotifyUrl({
        ECHO_NOTIFY_URL: "http://echo.example/notify",
        ATLAS_VOICE_NOTIFY_URL: "http://legacy.example/notify",
      }),
    ).toBe("http://echo.example/notify");
  });

  test("with both set, ECHO_DAEMON_URL wins for notify as well as the read endpoints", () => {
    const env = {
      ECHO_DAEMON_URL: "http://localhost:8899",
      ECHO_NOTIFY_URL: "http://echo.example:9000/notify",
    };
    expect(resolveNotifyUrl(env)).toBe("http://localhost:8899/notify");
    expect(resolveVoicesUrl(env)).toBe("http://localhost:8899/voices");
    expect(new URL(resolveNotifyUrl(env)).origin).toBe(new URL(resolveVoicesUrl(env)).origin);
  });

  test("a malformed ECHO_NOTIFY_URL does not crash the read endpoints", () => {
    const env = { ECHO_NOTIFY_URL: "not-a-url" };
    expect(resolveNotifyUrl(env)).toBe("not-a-url");
    expect(resolveVoicesUrl(env)).toBe("http://localhost:8888/voices");
  });
});
