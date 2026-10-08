/**
 * Counts tokens (or characters) over a sliding two-second window. The rate drives the sparkle density of the mesh
 * and the pulse gives each arrival a short flash, so a stream of LLM tokens and the caption typewriter look alike.
 */
const SLOTS = 512;
const PULSE_SECONDS = 0.18;

export class TokenMeter {
  private readonly times = new Float64Array(SLOTS);
  private readonly counts = new Float64Array(SLOTS);
  private head = 0;
  private size = 0;
  private rateValue = 0;
  private pulseValue = 0;
  private lastUpdate = 0;

  constructor(private readonly windowMs = 2000) {}

  /** Record that `n` tokens just arrived. */
  tokens(n: number, nowMs = performance.now()): void {
    if (!(n > 0)) return;
    if (this.size === SLOTS) {
      // The window is full of tiny arrivals: fold this one into the newest slot instead of dropping it.
      const newest = (this.head + SLOTS - 1) % SLOTS;
      this.counts[newest] = (this.counts[newest] ?? 0) + n;
      this.times[newest] = nowMs;
    } else {
      const slot = (this.head + this.size) % SLOTS;
      this.times[slot] = nowMs;
      this.counts[slot] = n;
      this.size += 1;
    }
    this.pulseValue = 1;
  }

  /** Evict stale arrivals, recompute the rate and let the pulse decay. Call once per frame. */
  update(nowMs = performance.now()): void {
    const dt = this.lastUpdate === 0 ? 0 : Math.max(0, (nowMs - this.lastUpdate) / 1000);
    this.lastUpdate = nowMs;
    const oldest = nowMs - this.windowMs;
    while (this.size > 0 && (this.times[this.head] ?? 0) < oldest) {
      this.head = (this.head + 1) % SLOTS;
      this.size -= 1;
    }
    let total = 0;
    for (let i = 0; i < this.size; i += 1) total += this.counts[(this.head + i) % SLOTS] ?? 0;
    this.rateValue = total / (this.windowMs / 1000);
    this.pulseValue *= Math.exp(-dt / PULSE_SECONDS);
    if (this.pulseValue < 0.001) this.pulseValue = 0;
  }

  /** Tokens per second over the window. */
  rate(): number {
    return this.rateValue;
  }

  /** 1 right after an arrival, decaying to 0 within a few hundred milliseconds. */
  pulse(): number {
    return this.pulseValue;
  }

  /** The rate as 0..1 against a reference speed; 30 per second is a brisk stream and lights the mesh fully. */
  normalized(reference = 30): number {
    return Math.min(1, this.rateValue / reference);
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.rateValue = 0;
    this.pulseValue = 0;
  }
}
