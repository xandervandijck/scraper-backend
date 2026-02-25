/**
 * In-memory cache with TTL support and domain visit tracking.
 */

export class Cache {
  constructor(defaultTtlMs = 3_600_000) {
    this.defaultTtl = defaultTtlMs;
    this.store = new Map();
    this.visitedDomains = new Set();
    this.domainEmailMap = new Map();
  }

  set(key, value, ttlMs = this.defaultTtl) {
    const expiresAt = Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.visitedDomains.clear();
    this.domainEmailMap.clear();
  }

  // Domain tracking
  markVisited(domain) {
    this.visitedDomains.add(this.normalizeDomain(domain));
  }

  isVisited(domain) {
    return this.visitedDomains.has(this.normalizeDomain(domain));
  }

  setDomainEmails(domain, emails) {
    this.domainEmailMap.set(this.normalizeDomain(domain), emails);
  }

  getDomainEmails(domain) {
    return this.domainEmailMap.get(this.normalizeDomain(domain)) ?? null;
  }

  normalizeDomain(domain) {
    return domain.toLowerCase().replace(/^www\./, '');
  }

  get size() {
    return this.store.size;
  }

  get visitedCount() {
    return this.visitedDomains.size;
  }

  // Periodic cleanup of expired entries
  startCleanup(intervalMs = 300_000) {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now > entry.expiresAt) this.store.delete(key);
      }
    }, intervalMs);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  stopCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

export default new Cache();
