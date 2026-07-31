import { describe, expect, test } from "bun:test";
import { SessionConsent } from "../../converse/session-consent.ts";

describe("session-scoped microphone consent", () => {
  test("refuses without a matching live host session", async () => {
    const consent = new SessionConsent();
    let prompts = 0;

    const decision = await consent.ensure("session-a", async () => {
      prompts++;
      return true;
    });

    expect(decision).toBe("unavailable");
    expect(prompts).toBe(0);
  });

  test("prompts once, then reuses a grant within that session", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    const prompt = async () => {
      prompts++;
      return true;
    };

    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(prompts).toBe(1);
  });

  test("a denial is sticky so later calls do not become per-call prompts", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    const prompt = async () => {
      prompts++;
      return false;
    };

    expect(await consent.ensure("session-a", prompt)).toBe("denied");
    expect(await consent.ensure("session-a", prompt)).toBe("denied");
    expect(prompts).toBe(1);
  });

  test("ending the session expires its grant and the next session asks once", async () => {
    const consent = new SessionConsent();
    let prompts = 0;
    const prompt = async () => {
      prompts++;
      return true;
    };

    consent.begin("session-a");
    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    consent.end();
    expect(await consent.ensure("session-a", prompt)).toBe("unavailable");

    consent.begin("session-b");
    expect(await consent.ensure("session-b", prompt)).toBe("granted");
    expect(prompts).toBe(2);
  });

  test("concurrent asks share one pending consent prompt", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    let answer!: (allowed: boolean) => void;
    const answered = new Promise<boolean>((resolve) => { answer = resolve; });
    const prompt = async () => {
      prompts++;
      return answered;
    };

    const first = consent.ensure("session-a", prompt);
    const second = consent.ensure("session-a", prompt);
    answer(true);

    expect(await Promise.all([first, second])).toEqual(["granted", "granted"]);
    expect(prompts).toBe(1);
  });

  test("a late answer cannot grant a session that already ended", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let answer!: (allowed: boolean) => void;
    const pending = consent.ensure("session-a", () => new Promise<boolean>((resolve) => { answer = resolve; }));

    consent.end();
    answer(true);

    expect(await pending).toBe("unavailable");
    expect(consent.status("session-a")).toBe("unavailable");
  });
});
