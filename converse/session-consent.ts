export type SessionConsentDecision = "granted" | "denied" | "unavailable";

export type SessionConsentPrompt = () => Promise<SessionConsentDecision>;

type ConsentState = "unasked" | "pending" | "granted" | "denied";

/**
 * In-memory consent for one live host session.
 *
 * A grant and a human denial are both sticky: one host session gets at most
 * one answered consent prompt. A prompt that could not reach the human at all
 * ("unavailable" - no consent surface, or a broken one) does not consume the
 * session's prompt and stays retryable. Ending the session invalidates an
 * in-flight answer so a late click can never grant the next session.
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
      let decision: SessionConsentDecision = "unavailable";
      try {
        decision = await prompt();
      } catch {
        // A broken consent surface produced no human signal: fail closed for
        // this call, but leave the session retryable once a surface exists.
      }

      if (this.generation !== generation || this.sessionId !== activeSession) return "unavailable";
      this.state = decision === "unavailable" ? "unasked" : decision;
      return decision;
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
