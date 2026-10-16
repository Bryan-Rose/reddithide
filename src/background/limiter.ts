// Per-profile concurrency and requests-per-minute limits (SPEC §6.6).

interface ProfileState {
  active: number;
  waiters: (() => void)[];
  lastStart: number;
}

export interface LimitConfig {
  maxConcurrency: number;
  requestsPerMinute: number;
}

export class Limiter {
  private states = new Map<string, ProfileState>();

  constructor(private now: () => number = Date.now) {}

  private state(id: string): ProfileState {
    let s = this.states.get(id);
    if (!s) {
      s = { active: 0, waiters: [], lastStart: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  active(id: string): number {
    return this.state(id).active;
  }

  async run<T>(id: string, cfg: LimitConfig, fn: () => Promise<T>): Promise<T> {
    const s = this.state(id);
    while (s.active >= Math.max(1, cfg.maxConcurrency)) {
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }
    s.active++;
    try {
      const spacing = cfg.requestsPerMinute > 0 ? 60000 / cfg.requestsPerMinute : 0;
      const wait = s.lastStart + spacing - this.now();
      s.lastStart = Math.max(this.now(), s.lastStart + spacing);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await fn();
    } finally {
      s.active--;
      s.waiters.shift()?.();
    }
  }
}
