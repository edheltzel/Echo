export type SessionConsentDecision = "granted" | "denied" | "unavailable";

export type SessionConsentPrompt = () => Promise<boolean>;

type ConsentState = "unasked" | "pending" | "granted" | "denied";

/**
 * In-memory consent for one live host session.
 *
 * A denial is sticky as well as a grant: one host session gets at most one
 * consent prompt. Ending the session invalidates an in-flight answer so a late
 * click can never grant the next session.
 */
export class SessionConsent {
  private sessionId: string | null = null;
  private state: ConsentState = "unasked";
  private pending: Promise<SessionConsentDecision> | null = null;
  private generation = 0;

  begin(sessionId: string | undefined): void {
    this.generation++;
    this.sessionId = sessionId?.trim() || null;
    this.state = "unasked";
    this.pending = null;
  }

  end(): void {
    this.generation++;
    this.sessionId = null;
    this.state = "unasked";
    this.pending = null;
  }

  status(sessionId: string | undefined): ConsentState | "unavailable" {
    return this.matches(sessionId) ? this.state : "unavailable";
  }

  async ensure(sessionId: string | undefined, prompt: SessionConsentPrompt): Promise<SessionConsentDecision> {
    if (!this.matches(sessionId)) return "unavailable";
    if (this.state === "granted") return "granted";
    if (this.state === "denied") return "denied";
    if (this.pending) return this.pending;

    const generation = this.generation;
    const activeSession = this.sessionId;
    this.state = "pending";
    const pending = (async (): Promise<SessionConsentDecision> => {
      let allowed = false;
      try {
        allowed = await prompt();
      } catch {
        // A broken or dismissed consent surface fails closed for this session.
      }

      if (this.generation !== generation || this.sessionId !== activeSession) return "unavailable";
      this.state = allowed ? "granted" : "denied";
      return allowed ? "granted" : "denied";
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private matches(sessionId: string | undefined): boolean {
    return this.sessionId !== null && sessionId?.trim() === this.sessionId;
  }
}
