/** In-memory sliding window per key. One instance per serverless instance; R3 accepts that. */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(private limit = 20, private windowMs = 60_000) {}

  /** true = allowed (and counted), false = over the limit. */
  hit(key: string, nowMs: number): boolean {
    for (const [k, times] of this.hits) {
      const fresh = times.filter((t) => t > nowMs - this.windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else if (fresh.length !== times.length) this.hits.set(k, fresh);
    }
    const times = this.hits.get(key) ?? [];
    if (times.length >= this.limit) return false;
    times.push(nowMs);
    this.hits.set(key, times);
    return true;
  }
}
