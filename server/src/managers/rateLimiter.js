export class PairingRateLimiter {
  constructor({ windowMs = 60_000, maxFailedAttempts = 5 } = {}) {
    this.windowMs = windowMs;
    this.maxFailedAttempts = maxFailedAttempts;
    this.failuresByKey = new Map();

    // Clean up expired keys every minute to prevent memory growth
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, Math.max(windowMs, 30_000));
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  isRateLimited(...keys) {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      const history = this.failuresByKey.get(key);
      if (!history) continue;

      const active = history.filter((timestamp) => now - timestamp < this.windowMs);
      if (active.length >= this.maxFailedAttempts) {
        return true;
      }
    }
    return false;
  }

  recordFailure(...keys) {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      const history = this.failuresByKey.get(key) || [];
      const active = history.filter((timestamp) => now - timestamp < this.windowMs);
      active.push(now);
      this.failuresByKey.set(key, active);
    }
  }

  recordSuccess(...keys) {
    for (const key of keys) {
      if (!key) continue;
      this.failuresByKey.delete(key);
    }
  }

  resetKey(key) {
    if (key) {
      this.failuresByKey.delete(key);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, history] of this.failuresByKey.entries()) {
      const active = history.filter((timestamp) => now - timestamp < this.windowMs);
      if (active.length === 0) {
        this.failuresByKey.delete(key);
      } else {
        this.failuresByKey.set(key, active);
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.failuresByKey.clear();
  }
}
