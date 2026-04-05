// src/durable-objects/AccountState.js
// One instance per Drive account. Tracks live quota, rate limits, and health.

export class AccountState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1); // remove leading /

    switch (action) {
      case 'check-and-increment':
        return this.checkAndIncrement();
      case 'record-bytes':
        return this.recordBytes(await request.json());
      case 'record-error':
        return this.recordError();
      case 'record-success':
        return this.recordSuccess();
      case 'get-stats':
        return this.getStats();
      case 'reset-daily':
        return this.resetDaily();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async checkAndIncrement() {
    const now = Date.now();
    const minuteKey = `req_${Math.floor(now / 60000)}`;
    const secondKey = `write_${Math.floor(now / 1000)}`;

    // Load current state
    const [minuteCount, secondCount, dailyBytes, cooling, errorStreak] = await Promise.all([
      this.storage.get(minuteKey) || 0,
      this.storage.get(secondKey) || 0,
      this.storage.get('daily_bytes') || 0,
      this.storage.get('cooling_until'),
      this.storage.get('error_streak') || 0,
    ]);

    // Check cooling period
    if (cooling && now < cooling) {
      return Response.json({
        allowed: false,
        reason: 'cooling',
        cooldown_remaining_ms: cooling - now,
      });
    }

    // Check per-minute rate limit (stay under 80% of 12000/min = 9600)
    if (minuteCount >= 9600) {
      return Response.json({
        allowed: false,
        reason: 'minute_limit',
        requests_this_minute: minuteCount,
      });
    }

    // Check write rate (stay under 3/sec)
    if (secondCount >= 3) {
      return Response.json({
        allowed: false,
        reason: 'write_limit',
        writes_this_second: secondCount,
      });
    }

    // Check daily upload quota (stay under 700GB of 750GB)
    const dailyLimitBytes = 700 * 1024 * 1024 * 1024;
    if (dailyBytes >= dailyLimitBytes) {
      return Response.json({
        allowed: false,
        reason: 'daily_quota',
        daily_bytes_used: dailyBytes,
      });
    }

    // All clear — increment counters
    await Promise.all([
      this.storage.put(minuteKey, (minuteCount || 0) + 1),
      this.storage.put(secondKey, (secondCount || 0) + 1),
    ]);

    // Set TTLs via alarm (clean up old minute keys)
    this.state.waitUntil(this.scheduleCleanup());

    return Response.json({
      allowed: true,
      requests_this_minute: (minuteCount || 0) + 1,
      daily_bytes_used: dailyBytes,
      error_streak: errorStreak,
    });
  }

  async recordBytes({ bytes }) {
    const current = (await this.storage.get('daily_bytes')) || 0;
    await this.storage.put('daily_bytes', current + bytes);
    return Response.json({ ok: true, daily_bytes: current + bytes });
  }

  async recordError() {
    const streak = ((await this.storage.get('error_streak')) || 0) + 1;
    await this.storage.put('error_streak', streak);

    // After 3 consecutive errors, enter cooling period (exponential backoff)
    if (streak >= 3) {
      const backoffMs = Math.min(Math.pow(2, streak - 2) * 1000, 64000);
      const coolingUntil = Date.now() + backoffMs;
      await this.storage.put('cooling_until', coolingUntil);
    }

    return Response.json({ ok: true, error_streak: streak });
  }

  async recordSuccess() {
    await Promise.all([
      this.storage.put('error_streak', 0),
      this.storage.delete('cooling_until'),
    ]);
    return Response.json({ ok: true });
  }

  async getStats() {
    const now = Date.now();
    const minuteKey = `req_${Math.floor(now / 60000)}`;

    const [minuteCount, dailyBytes, cooling, errorStreak] = await Promise.all([
      this.storage.get(minuteKey),
      this.storage.get('daily_bytes'),
      this.storage.get('cooling_until'),
      this.storage.get('error_streak'),
    ]);

    return Response.json({
      requests_this_minute: minuteCount || 0,
      daily_bytes_used: dailyBytes || 0,
      cooling: cooling ? cooling > now : false,
      cooling_until: cooling || null,
      error_streak: errorStreak || 0,
      healthy: !cooling || cooling <= now,
    });
  }

  async resetDaily() {
    await this.storage.put('daily_bytes', 0);
    return Response.json({ ok: true });
  }

  async scheduleCleanup() {
    // Clean up keys older than 2 minutes
    const now = Date.now();
    const oldMinuteKey = `req_${Math.floor(now / 60000) - 2}`;
    const oldSecondKey = `write_${Math.floor(now / 1000) - 2}`;
    await Promise.all([
      this.storage.delete(oldMinuteKey),
      this.storage.delete(oldSecondKey),
    ]);
  }
}
