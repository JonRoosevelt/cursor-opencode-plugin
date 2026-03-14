type SessionEntry = {
  chatId: string;
  expiresAt: number;
  lastAccessedAt: number;
};

export class SessionStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(sessionKey: string): string | null {
    const now = Date.now();
    const entry = this.sessions.get(sessionKey);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= now) {
      this.sessions.delete(sessionKey);
      return null;
    }

    entry.lastAccessedAt = now;
    entry.expiresAt = now + this.ttlMs;
    return entry.chatId;
  }

  set(sessionKey: string, chatId: string): void {
    const now = Date.now();
    this.sessions.set(sessionKey, {
      chatId,
      expiresAt: now + this.ttlMs,
      lastAccessedAt: now
    });
    this.pruneIfNeeded();
  }

  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  private pruneIfNeeded(): void {
    if (this.sessions.size <= this.maxEntries) {
      return;
    }

    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.sessions.entries()) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (!oldestKey) {
      return;
    }

    this.sessions.delete(oldestKey);
  }
}
