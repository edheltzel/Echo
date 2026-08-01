import { describe, expect, test } from "bun:test";
import { SessionConsent, type SessionConsentDecision } from "../../converse/session-consent.ts";

describe("session-scoped microphone consent", () => {
  test("refuses without a matching live host session", async () => {
    const consent = new SessionConsent();
    let prompts = 0;

    const decision = await consent.ensure("session-a", async () => {
      prompts++;
      return "granted";
    });

    expect(decision).toBe("unavailable");
    expect(prompts).toBe(0);
  });

  test("prompts once, then reuses a grant within that session", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    const prompt = async (): Promise<SessionConsentDecision> => {
      prompts++;
      return "granted";
    };

    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(prompts).toBe(1);
  });

  test("a denial is sticky so later calls do not become per-call prompts", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    const prompt = async (): Promise<SessionConsentDecision> => {
      prompts++;
      return "denied";
    };

    expect(await consent.ensure("session-a", prompt)).toBe("denied");
    expect(await consent.ensure("session-a", prompt)).toBe("denied");
    expect(prompts).toBe(1);
  });

  test("a prompt that never reached the human stays retryable, not a sticky denial", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    const decisions: SessionConsentDecision[] = ["unavailable", "granted"];
    let prompts = 0;
    const prompt = async (): Promise<SessionConsentDecision> => {
      prompts++;
      return decisions.shift() ?? "granted";
    };

    expect(await consent.ensure("session-a", prompt)).toBe("unavailable");
    expect(consent.status("session-a")).toBe("unasked");
    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(prompts).toBe(2);
  });

  test("a broken consent surface fails closed for the call but stays retryable", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let prompts = 0;
    const prompt = async (): Promise<SessionConsentDecision> => {
      prompts++;
      if (prompts === 1) throw new Error("no consent surface");
      return "granted";
    };

    expect(await consent.ensure("session-a", prompt)).toBe("unavailable");
    expect(await consent.ensure("session-a", prompt)).toBe("granted");
    expect(prompts).toBe(2);
  });

  test("ending the session expires its grant and the next session asks once", async () => {
    const consent = new SessionConsent();
    let prompts = 0;
    const prompt = async (): Promise<SessionConsentDecision> => {
      prompts++;
      return "granted";
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
    let answer!: (decision: SessionConsentDecision) => void;
    const answered = new Promise<SessionConsentDecision>((resolve) => { answer = resolve; });
    const prompt = async () => {
      prompts++;
      return answered;
    };

    const first = consent.ensure("session-a", prompt);
    const second = consent.ensure("session-a", prompt);
    answer("granted");

    expect(await Promise.all([first, second])).toEqual(["granted", "granted"]);
    expect(prompts).toBe(1);
  });

  test("a late answer cannot grant a session that already ended", async () => {
    const consent = new SessionConsent();
    consent.begin("session-a");
    let answer!: (decision: SessionConsentDecision) => void;
    const pending = consent.ensure(
      "session-a",
      () => new Promise<SessionConsentDecision>((resolve) => { answer = resolve; }),
    );

    consent.end();
    answer("granted");

    expect(await pending).toBe("unavailable");
    expect(consent.status("session-a")).toBe("unavailable");
  });
});
