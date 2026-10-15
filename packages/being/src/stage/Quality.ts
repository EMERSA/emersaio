import type { CloudGrid } from '../data/depth/depthMath.ts';
import type { Quality } from '../types.ts';

/** The ladder, top to bottom. The monitor only ever walks down it within a session. */
export const QUALITY_LADDER: readonly Quality[] = ['full', 'balanced', 'lite', 'poster'];

/** What the device and the mount options allow at most; a tier can only take away. */
export interface QualityCaps {
  bloom: boolean;
  ribbon: boolean;
  reflection: boolean;
  maxPixelRatio: number;
}

/**
 * The kinect cloud's grids: desktop full, the one touch devices and the lower tiers draw, and the grids of the face
 * look, where the cloud is the head alone and the lite tier still draws it.
 */
export const CLOUD_GRIDS: Readonly<
  Record<
    'full' | 'reduced' | 'head' | 'headReduced' | 'headLite' | 'bust' | 'bustReduced' | 'bustLite' | 'bustTouch',
    CloudGrid
  >
> = {
  full: { cols: 320, rows: 240 },
  reduced: { cols: 160, rows: 120 },
  // The head alone fills the sensor's frame, so the full grid goes on it: about 2 px between points at 1440 x 900.
  head: { cols: 320, rows: 240 },
  headReduced: { cols: 200, rows: 150 },
  headLite: { cols: 120, rows: 90 },
  // The kinect-demo look's head and shoulders as tiny shards. These are ceilings: bustGrid() sizes the lattice from
  // the frame on screen, so a shard stays about BUST_CELL_PX across however large the hero is. Two shards per cell,
  // so the full ceiling is about 775k triangles.
  bust: { cols: 720, rows: 540 },
  bustReduced: { cols: 400, rows: 300 },
  bustLite: { cols: 160, rows: 120 },
  // Touch devices, whatever the tier above lite.
  bustTouch: { cols: 240, rows: 180 },
};

/** The kinect-demo shards' target size: one lattice cell this many CSS pixels across on screen. */
export const BUST_CELL_PX = 2;
/** The smallest bust lattice, in rows, whatever the frame. */
const BUST_MIN_ROWS = 96;
/** Rows come in steps of this many (and columns of four thirds of it), so a resize does not rebuild every frame. */
const BUST_ROW_STEP = 12;

/**
 * The bust lattice for a sensor frame that is `framePx` CSS pixels tall on screen: one cell per BUST_CELL_PX, in
 * steps of BUST_ROW_STEP rows, at least BUST_MIN_ROWS, at most the ceiling; 4:3 like the sensor.
 */
export function bustGrid(framePx: number, ceiling: CloudGrid): CloudGrid {
  const wanted = Number.isFinite(framePx) && framePx > 0 ? framePx / BUST_CELL_PX : BUST_MIN_ROWS;
  const stepped = Math.round(wanted / BUST_ROW_STEP) * BUST_ROW_STEP;
  const rows = Math.min(ceiling.rows, Math.max(BUST_MIN_ROWS, stepped));
  return { cols: Math.round((rows * 4) / 3), rows };
}

export interface QualityProfile {
  /** False for the poster tier: the loop stops and the shell shows the SVG poster. */
  render: boolean;
  /** The kinect cloud's grid; null draws no cloud. */
  cloud: CloudGrid | null;
  /** The head cloud's grid in the face look. */
  headCloud: CloudGrid | null;
  /** The ceiling of the kinect-demo look's head-and-shoulders lattice (bustGrid sizes it; touch takes bustTouch at most). */
  bustCloud: CloudGrid | null;
  /** The data fan of the face look. */
  fan: boolean;
  ribbon: boolean;
  /** The mirrored draw below the floor. */
  reflection: boolean;
  /** The one rim light behind the head (and the dev harness's floor disc): a static quad or two. */
  rim: boolean;
  bloom: boolean;
  bloomRadius: number;
  pixelRatio: number;
  /** Draw every second point of the ring. */
  halfPoints: boolean;
}

export function qualityProfile(quality: Quality, caps: QualityCaps): QualityProfile {
  switch (quality) {
    case 'full':
      return {
        render: true,
        cloud: CLOUD_GRIDS.full,
        headCloud: CLOUD_GRIDS.head,
        bustCloud: CLOUD_GRIDS.bust,
        fan: true,
        ribbon: caps.ribbon,
        reflection: caps.reflection,
        rim: true,
        bloom: caps.bloom,
        bloomRadius: 0.5,
        pixelRatio: caps.maxPixelRatio,
        halfPoints: false,
      };
    case 'balanced':
      return {
        render: true,
        cloud: CLOUD_GRIDS.reduced,
        headCloud: CLOUD_GRIDS.headReduced,
        bustCloud: CLOUD_GRIDS.bustReduced,
        fan: true,
        ribbon: caps.ribbon,
        reflection: false,
        rim: true,
        bloom: caps.bloom,
        bloomRadius: 0.3,
        pixelRatio: Math.min(caps.maxPixelRatio, 1.5),
        halfPoints: false,
      };
    case 'lite':
      return {
        render: true,
        cloud: CLOUD_GRIDS.reduced,
        headCloud: CLOUD_GRIDS.headLite,
        bustCloud: CLOUD_GRIDS.bustLite,
        fan: false,
        ribbon: false,
        reflection: false,
        rim: false,
        bloom: false,
        bloomRadius: 0.3,
        pixelRatio: Math.min(caps.maxPixelRatio, 1.25),
        halfPoints: true,
      };
    case 'poster':
      return {
        render: false,
        cloud: null,
        headCloud: null,
        bustCloud: null,
        fan: false,
        ribbon: false,
        reflection: false,
        rim: false,
        bloom: false,
        bloomRadius: 0,
        pixelRatio: 1,
        halfPoints: true,
      };
  }
}

/** Where a session starts: touch devices begin at balanced however much they were asked for. */
export function startingQuality(requested: Quality, touch: boolean): Quality {
  return touch && requested === 'full' ? 'balanced' : requested;
}

export function stepDown(quality: Quality): Quality | null {
  const index = QUALITY_LADDER.indexOf(quality);
  return QUALITY_LADDER[index + 1] ?? null;
}

/** Frames slower than this share of the target rate count as slow. 45 of 60 fps, or 22.5 of a 30 fps idle cap. */
const SLOW_RATIO = 0.75;
/** Seconds of sustained slowness before a step down. */
const PATIENCE_S = 3;
/** Seconds ignored after a start or a change, while shaders compile and caches warm. */
const WARMUP_S = 2;
/**
 * A step down has to move the frame rate by this share, either way, to be followed by another. One that changed
 * nothing means the rate is capped by the display or the browser (Low Power Mode, Energy Saver, a 30 Hz screen)
 * rather than by GPU load, and taking more away would gain nothing; a rate that fell further means the load is
 * still growing.
 */
const STEP_CHANGE = 0.1;
/** The poster is never swapped in while the loop still holds this many frames per second. */
export const POSTER_FLOOR_FPS = 24;

/**
 * Watches the frame rate and steps the quality down, never up: a visitor who saw the lite being does not get the
 * full one flickering back in when the fan spins up.
 */
export class QualityMonitor {
  private quality: Quality;
  private readonly onChange: (quality: Quality) => void;
  private slowFor = 0;
  private warmup = WARMUP_S;
  /** The frame rate at the last step down, to judge whether that step helped. */
  private steppedAt: number | null = null;

  // Explicit fields rather than parameter properties: node --test runs this file with type stripping alone.
  constructor(quality: Quality, onChange: (quality: Quality) => void) {
    this.quality = quality;
    this.onChange = onChange;
  }

  current(): Quality {
    return this.quality;
  }

  /** An explicit choice from the outside; it restarts the watch but does not fire onChange. */
  set(quality: Quality): void {
    this.quality = quality;
    this.steppedAt = null;
    this.reset();
  }

  /** Forget the slow streak, for example after the loop resumes from a pause. */
  reset(): void {
    this.slowFor = 0;
    this.warmup = WARMUP_S;
  }

  sample(fps: number, dtSeconds: number, targetFps: number): void {
    if (this.quality === 'poster') return;
    if (this.warmup > 0) {
      this.warmup -= dtSeconds;
      return;
    }
    if (fps >= targetFps * SLOW_RATIO) {
      // Jitter should not reset the streak outright; it just has to be outweighed by good frames.
      this.slowFor = Math.max(0, this.slowFor - dtSeconds * 0.5);
      return;
    }
    this.slowFor = Math.min(PATIENCE_S, this.slowFor + dtSeconds);
    if (this.slowFor < PATIENCE_S) return;
    const next = stepDown(this.quality);
    if (!next) return;
    if (this.steppedAt !== null && Math.abs(fps - this.steppedAt) < this.steppedAt * STEP_CHANGE) return;
    if (next === 'poster' && fps >= POSTER_FLOOR_FPS) return;
    this.steppedAt = fps;
    this.quality = next;
    this.reset();
    this.onChange(next);
  }
}
