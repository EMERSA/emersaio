/**
 * Pointer gestures on the being's canvas, kept free of three.js and the DOM so node --test can check them. A press
 * held for HOLD_MS with less than HOLD_SLOP_PX of movement is a hold, kept until the release however the pointer
 * moves afterwards (Talk turns it into the microphone); a press that travels HOLD_SLOP_PX first is a drag (it turns
 * Emily); a short, still press is a tap. A second pointer cancels whatever the first one was doing, and nothing new
 * starts until every pointer is up. Positions are CSS pixels in the canvas, times milliseconds on one clock
 * (performance.now, which pointer events' timeStamp shares); velocities are CSS pixels a second.
 */

/** A still press turns into a hold after this long. */
export const HOLD_MS = 250;
/** Movement under this many CSS pixels from where the press began still counts as still. */
export const HOLD_SLOP_PX = 10;
/** The release velocity is measured over this much of the drag's end. */
export const VELOCITY_WINDOW_MS = 80;

export type GestureEvent =
  /** The pointer moving with nothing pressed (a mouse or a pen hovering). */
  | { type: 'hover'; x: number; y: number }
  | { type: 'tap'; x: number; y: number }
  /** A drag began where the press did; the first drag event carries the travel since then. */
  | { type: 'drag-start'; x: number; y: number }
  | { type: 'drag'; dx: number; dy: number }
  /**
   * The drag ended: the release velocity, or zero and `cancelled` when the browser took the pointer (a page scroll
   * begun on touch) or a second pointer came down, so whatever the drag did can be undone.
   */
  | { type: 'drag-end'; vx: number; vy: number; cancelled: boolean }
  | { type: 'hold-start'; x: number; y: number }
  | { type: 'hold-end' };

type Phase = 'idle' | 'pressed' | 'dragging' | 'holding' | 'cancelled';

/** Enough samples to cover the velocity window at any pointer rate a browser delivers. */
const SAMPLES = 32;

export class GestureTracker {
  private readonly emit: (event: GestureEvent) => void;
  private phase: Phase = 'idle';
  /** The pointer the gesture follows, and every pointer that is down. */
  private pointer = -1;
  private readonly pointers = new Set<number>();
  private startX = 0;
  private startY = 0;
  private startAt = 0;
  private lastX = 0;
  private lastY = 0;
  /** The recent positions, a ring of [t, x, y], for the release velocity. */
  private readonly samples = new Float64Array(SAMPLES * 3);
  private count = 0;
  private head = 0;

  // Explicit fields rather than parameter properties: node --test runs this file with type stripping alone.
  constructor(emit: (event: GestureEvent) => void) {
    this.emit = emit;
  }

  /** A pointer went down at (x, y). */
  down(id: number, x: number, y: number, t: number): void {
    // A press whose release never arrived (the pointer left the window uncaptured) ends here first.
    if (this.pointers.has(id)) this.cancel(id);
    this.pointers.add(id);
    if (this.pointers.size > 1) {
      this.abort();
      return;
    }
    this.phase = 'pressed';
    this.pointer = id;
    this.startX = x;
    this.startY = y;
    this.startAt = t;
    this.lastX = x;
    this.lastY = y;
    this.count = 0;
    this.record(t, x, y);
  }

  move(id: number, x: number, y: number, t: number): void {
    if (this.pointers.size === 0) {
      this.emit({ type: 'hover', x, y });
      return;
    }
    if (id !== this.pointer) return;
    // A hold may have come due since the last event.
    this.tick(t);
    if (this.phase === 'pressed' && Math.hypot(x - this.startX, y - this.startY) >= HOLD_SLOP_PX) {
      this.startDrag();
    }
    if (this.phase === 'dragging' && (x !== this.lastX || y !== this.lastY)) {
      this.emit({ type: 'drag', dx: x - this.lastX, dy: y - this.lastY });
    }
    if (this.phase === 'pressed' || this.phase === 'dragging' || this.phase === 'holding') {
      this.lastX = x;
      this.lastY = y;
      this.record(t, x, y);
    }
  }

  /** A pointer came up at (x, y). */
  up(id: number, x: number, y: number, t: number): void {
    if (!this.pointers.delete(id)) return;
    if (id !== this.pointer) {
      if (this.pointers.size === 0 && this.phase === 'cancelled') this.phase = 'idle';
      return;
    }
    this.tick(t);
    // A flick whose only event after the press is its release still travelled: it is a drag, not a tap.
    if (this.phase === 'pressed' && Math.hypot(x - this.startX, y - this.startY) >= HOLD_SLOP_PX) {
      this.startDrag();
    }
    if (this.phase === 'pressed') {
      this.emit({ type: 'tap', x, y });
    } else if (this.phase === 'dragging') {
      if (x !== this.lastX || y !== this.lastY) this.emit({ type: 'drag', dx: x - this.lastX, dy: y - this.lastY });
      this.record(t, x, y);
      const [vx, vy] = this.velocity(t, x, y);
      this.emit({ type: 'drag-end', vx, vy, cancelled: false });
    } else if (this.phase === 'holding') {
      this.emit({ type: 'hold-end' });
    }
    this.pointer = -1;
    this.phase = this.pointers.size > 0 ? 'cancelled' : 'idle';
  }

  /**
   * The browser took the pointer (a pointercancel: it began a scroll or a pinch), or the capture went away. A drag
   * ends without coasting and a hold ends; with no id every pointer is forgotten.
   */
  cancel(id?: number): void {
    if (id === undefined) this.pointers.clear();
    else if (!this.pointers.delete(id)) return;
    if (id === undefined || id === this.pointer) this.abort();
    if (this.pointers.size === 0) this.phase = 'idle';
  }

  /** Time passes: a press held still long enough becomes a hold. Call it from a timer or the frame loop. */
  tick(t: number): void {
    if (this.phase !== 'pressed' || t - this.startAt < HOLD_MS) return;
    this.phase = 'holding';
    this.emit({ type: 'hold-start', x: this.startX, y: this.startY });
  }

  /** A press is in progress: pressed and not yet told apart, dragging or holding. */
  pressing(): boolean {
    return this.phase === 'pressed' || this.phase === 'dragging' || this.phase === 'holding';
  }

  dragging(): boolean {
    return this.phase === 'dragging';
  }

  holding(): boolean {
    return this.phase === 'holding';
  }

  /** The pointer the gesture follows, while a press is in progress. */
  pointerId(): number | null {
    return this.pressing() ? this.pointer : null;
  }

  /** The press travelled: a drag from where it began, so its first step carries the travel the slop held back. */
  private startDrag(): void {
    this.phase = 'dragging';
    this.lastX = this.startX;
    this.lastY = this.startY;
    this.emit({ type: 'drag-start', x: this.startX, y: this.startY });
  }

  /** End the gesture in progress without a release: a drag stops dead, a hold ends. */
  private abort(): void {
    if (this.phase === 'dragging') this.emit({ type: 'drag-end', vx: 0, vy: 0, cancelled: true });
    else if (this.phase === 'holding') this.emit({ type: 'hold-end' });
    this.pointer = -1;
    this.phase = 'cancelled';
  }

  private record(t: number, x: number, y: number): void {
    const at = this.head * 3;
    this.samples[at] = t;
    this.samples[at + 1] = x;
    this.samples[at + 2] = y;
    this.head = (this.head + 1) % SAMPLES;
    this.count = Math.min(SAMPLES, this.count + 1);
  }

  /**
   * The release velocity: the travel from the oldest sample inside the window to the release, over its time. A
   * pointer that rested before letting go has no sample inside the window but the release itself, and no velocity.
   */
  private velocity(t: number, x: number, y: number): [number, number] {
    let oldest = -1;
    for (let i = 0; i < this.count; i += 1) {
      const at = ((this.head - 1 - i + SAMPLES) % SAMPLES) * 3;
      const sampleT = this.samples[at] ?? Number.NEGATIVE_INFINITY;
      if (t - sampleT > VELOCITY_WINDOW_MS) break;
      oldest = at;
    }
    if (oldest < 0) return [0, 0];
    const span = (t - (this.samples[oldest] ?? t)) / 1000;
    if (!(span > 0.001)) return [0, 0];
    return [(x - (this.samples[oldest + 1] ?? x)) / span, (y - (this.samples[oldest + 2] ?? y)) / span];
  }
}
