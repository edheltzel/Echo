import { afterEach, describe, expect, test } from "bun:test";
import { sendNotificationPayload } from "../../shared/notify-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("shared native-before-POST notification client", () => {
  test("adds the exact native marker only after a Herdr success", async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response("accepted", { status: 202 });
    };

    const result = await sendNotificationPayload(
      { endpoint: "http://echo.test/notify", title: "Title" },
      { message: "Body", title: "Title", source: "pi" },
      undefined,
      { herdr: { show: async () => ({ shown: true }) } },
    );
    expect(result.status).toBe(202);
    expect(payload?.visual_delivery).toBe("native");
  });

  test("omits the marker when native delivery is unavailable and still POSTs", async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response("accepted", { status: 202 });
    };

    await sendNotificationPayload(
      { endpoint: "http://echo.test/notify", title: "Title" },
      { message: "Body", title: "Title", source: "raw-compatible" },
      undefined,
      { env: {} },
    );
    expect(payload).toEqual({ message: "Body", title: "Title", source: "raw-compatible" });
  });
});
