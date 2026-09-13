'use strict';

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs || 60_000);
    this.max = Number(options.max || 60);
    this.map = new Map();
  }

  hit(key) {
    const now = Date.now();
    let row = this.map.get(key);
    if (!row || row.resetAt <= now) {
      row = { count: 0, resetAt: now + this.windowMs };
      this.map.set(key, row);
    }
    row.count++;
    return {
      allowed: row.count <= this.max,
      remaining: Math.max(0, this.max - row.count),
      resetAt: row.resetAt,
      count: row.count
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [key,row] of this.map) if (row.resetAt <= now) this.map.delete(key);
  }
}

module.exports = { RateLimiter };
