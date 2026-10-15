export interface GeminiSessionTriple {
  conversationId: string;
  responseId: string;
  choiceId: string;
}

export class ContextTracker {
  // Maps Antigravity session key / thread hash to Gemini Web session triple
  private static sessions = new Map<string, GeminiSessionTriple>();

  /**
   * Generates a stable session key from request content identifiers or model context.
   */
  public static getSessionKey(firstUserMessage: string): string {
    // Hash first 200 chars of the initial user turn to maintain thread continuity
    const snippet = firstUserMessage.slice(0, 200).trim();
    let hash = 0;
    for (let i = 0; i < snippet.length; i++) {
      hash = ((hash << 5) - hash) + snippet.charCodeAt(i);
      hash |= 0;
    }
    return `thread_${Math.abs(hash)}`;
  }

  public static getSession(sessionKey: string): GeminiSessionTriple | undefined {
    return this.sessions.get(sessionKey);
  }

  public static updateSession(sessionKey: string, triple: GeminiSessionTriple): void {
    this.sessions.set(sessionKey, triple);
  }

  public static clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  public static clearAll(): void {
    this.sessions.clear();
  }
}
