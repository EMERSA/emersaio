/**
 * The maths behind the kinect cloud, kept free of three.js so node --test can check it. The shaders in
 * avatar/shaders/kinect.*.glsl.ts are these functions written in GLSL; keep the two in step.
 *
 * Back-projection follows three's webgl_video_kinect example: a grid cell gives the ray, the depth sample gives the
 * distance along it, and XtoZ / YtoZ (2 * tan(fov / 2) for each axis) turn the cell offset into metres at that
 * distance. A being source reads a perspective depth buffer; a video or Kinectron source reads grey as linear depth.
 */

/** The point grid of the kinect cloud. */
export interface CloudGrid {
  cols: number;
  rows: number;
}

/** 2 * tan(fov / 2) for the horizontal (x) and vertical (y) axes of a depth camera. */
export interface FovTangents {
  x: number;
  y: number;
}

/** Depth clipping in metres: a grey of 1 lands at near and a grey of 0 at far. */
export interface DepthClipping {
  near: number;
  far: number;
}

/** The first Kinect's depth camera, the constants of the three example: tan(1.0144686 / 2) * 2, tan(0.7898090 / 2) * 2. */
export const KINECT_V1_TANGENTS: Readonly<FovTangents> = { x: 1.11146, y: 0.83359 };

/** Depth field of view per sensor family: Kinect v1 (58.5 x 46.6 degrees), Kinect v2 (70.6 x 60), Azure NFOV (75 x 65). */
export const SENSOR_TANGENTS = {
  v1: KINECT_V1_TANGENTS,
  windows: { x: 1.41608, y: 1.1547 },
  azure: { x: 1.53465, y: 1.27414 },
} as const satisfies Record<string, FovTangents>;

export type SensorKind = keyof typeof SENSOR_TANGENTS;

/** The three example's clipping (850 mm to 4000 mm), in metres. */
export const DEFAULT_CLIPPING: Readonly<DepthClipping> = { near: 0.85, far: 4 };

/**
 * Kinectron's depth image feeds and what their grey means (docs/research/kinectron-study.md). Azure Kinect 1.x:
 * g = floor(255 * (4000 - mm) / 3500), white is 0.5 m or no data and black 4 m or more, 13.7 mm per level; 255
 * counts as a miss. Kinect v2 on the 0.x line is inverted: mm = 17 * g for 500 to 4500 mm, and g = 0 is a miss.
 */
export const AZURE_DEPTH_RANGE_MM: readonly [number, number] = [500, 4000];
export const AZURE_MM_PER_LEVEL = 3500 / 255;
export const KINECT_V2_MM_PER_LEVEL = 17;
/** The clipping a Kinectron source starts with, per sensor: the range its depth image spans. */
export const KINECTRON_CLIPPING: Readonly<Record<'azure' | 'windows', DepthClipping>> = {
  azure: { near: 0.5, far: 4 },
  windows: { near: 0.5, far: 4.5 },
};

/** Millimetres for an Azure Kinect depth-feed grey level (the centre of the level); 0 for a miss. */
export function azureGreyToMm(grey: number): number {
  if (!(grey >= 0 && grey < 255)) return 0;
  return AZURE_DEPTH_RANGE_MM[1] - (grey + 0.5) * AZURE_MM_PER_LEVEL;
}

/** Millimetres for a Kinect v2 (Kinectron 0.x) depth-feed grey level; 0 for a miss. */
export function kinectV2GreyToMm(grey: number): number {
  if (!(grey > 0 && grey <= 255)) return 0;
  return grey * KINECT_V2_MM_PER_LEVEL;
}

/**
 * The fixed sensor camera the being's own depth is rendered from (the study's recipe, step 1): about 1.05 m from
 * the face and 7 degrees below the eye line, with a lens just wide enough for the head, so the depth grid's texels
 * are spent on the face. The view camera moves with the pointer; this one never does, which is what makes the
 * quantisation and the dropout read as a sensor's rather than as the viewer's own rays.
 */
export const SENSOR_FACE = { distanceM: 1.05, belowEyeDeg: 7, fovDeg: 18 } as const;
/** The same sensor for the whole figure (the hybrid and kinect looks): on a tripod, level with the chest. */
export const SENSOR_FIGURE = { distanceM: 3.2, heightM: 1, lookAtY: 0.9, fovDeg: 36 } as const;
/** The eye line as a share of the head's height above the chin. */
export const EYE_LINE_SHARE = 0.62;
/** The depth pass re-renders when floor(t * SENSOR_HZ) changes. */
export const SENSOR_HZ = 30;
/** The dropout mask crossfades between two hashes at this rate rather than strobing; the flicker stays small-area. */
export const DROPOUT_HZ = 10;

/** Sensor frame index for an elapsed time; frozen at 0 under reduced motion. */
export function sensorFrame(elapsedS: number, reducedMotion = false): number {
  return reducedMotion ? 0 : Math.floor(elapsedS * SENSOR_HZ);
}

/**
 * Disparity quantisation (recipe step 4): a structured-light sensor measures disparity d = FB / z in pixels and
 * rounds it to 1 / subPx of a pixel, so depth steps grow with the square of the distance: 2.9 mm at 1 m and 4.5 mm
 * at 1.25 m with FB 43.19 px m and 8 sub-pixel steps. The step is capped at 10 mm, where the figure framing would
 * otherwise show staircases. `dither` in -0.5..0.5 moves a point to a neighbouring step (about 30 percent of them).
 */
export const DISPARITY_FB = 43.19;
export const DISPARITY_SUBPX = 8;
export const DISPARITY_MAX_STEP_M = 0.01;
export const DITHER_SHARE = 0.3;

/** The depth step at a distance, before the cap. */
export function disparityStep(zM: number, fb = DISPARITY_FB, subPx = DISPARITY_SUBPX): number {
  return (zM * zM) / (fb * subPx);
}

export function quantiseDistance(
  zM: number,
  dither = 0,
  fb = DISPARITY_FB,
  subPx = DISPARITY_SUBPX,
  maxStepM = DISPARITY_MAX_STEP_M,
): number {
  if (!(zM > 0)) return zM;
  if (disparityStep(zM, fb, subPx) > maxStepM) return Math.floor(zM / maxStepM + 0.5 + dither) * maxStepM;
  const q = Math.floor((fb / zM) * subPx + 0.5 + dither);
  return q > 0 ? (fb * subPx) / q : zM;
}

/** The relative discontinuity cut (recipe step 5): neighbours further apart than this share of the distance are a jump. */
export const JUMP_SHARE = 0.04;
/** Points facing the sensor less than this (0 grazing, 1 facing) are candidates for dropout. */
export const FACING_DROP = 0.45;
/** The fixed x-only jitter of a cell, in cells (recipe step 8). */
export const JITTER_CELLS = 0.3;
/**
 * Point size (recipe step 9, and the brief's 1.5 to 2 CSS px): CSS pixels for a point at the reference distance,
 * never under 1 device pixel. The top of the range, because the head grid is sparser than a 640 x 480 sensor's.
 */
export const POINT_CSS_PX = 2;
/** Point alpha: 0.16 near, falling to 0.4 of it at the far end of the ramp. */
export const POINT_ALPHA = 0.16;
export const POINT_ALPHA_FAR = 0.4;

export const isJump = (zA: number, zB: number, share = JUMP_SHARE): boolean =>
  Math.abs(zA - zB) > share * Math.min(zA, zB);

/** Device pixels of a point at distance `distM` when a point at `refDistM` is POINT_CSS_PX CSS pixels across. */
export function pointSizePx(distM: number, refDistM: number, dpr: number): number {
  return Math.max(1, POINT_CSS_PX * dpr * (refDistM / Math.max(distM, 1e-3)));
}

export function pointAlpha(depthT: number): number {
  const t = Math.min(1, Math.max(0, depthT));
  return POINT_ALPHA * (1 + (POINT_ALPHA_FAR - 1) * t);
}

/**
 * The PCG hash the shaders use (the pcg32 output permutation on a 32-bit state), so a test can check the GLSL
 * against these numbers. Keyed on (cell, frame, salt): a cell keeps its value until the sensor frame changes.
 */
export function pcg(input: number): number {
  const v = input >>> 0;
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

export function hash01(cell: number, frame: number, salt: number): number {
  return pcg(pcg(pcg(cell >>> 0) + (frame >>> 0)) + (salt >>> 0)) / 4294967295;
}

/** Grey depth images and video are read as misses outside this band: black is no data, white is at the sensor. */
export const GREY_HIT_RANGE: readonly [number, number] = [0.02, 0.98];

/** Perspective depth buffers read 1 where nothing was drawn. */
export const PERSPECTIVE_MISS = 0.9999;

/** 2 * tan(fov / 2) for a perspective camera with a vertical field of view in degrees. */
export function cameraTangents(fovDeg: number, aspect: number): FovTangents {
  const y = 2 * Math.tan((fovDeg * Math.PI) / 360);
  return { x: y * aspect, y };
}

/** Distance in front of the camera for a perspective depth sample (three's perspectiveDepthToViewZ, negated). */
export function perspectiveDepthToDistance(depth: number, near: number, far: number): number {
  return -((near * far) / ((far - near) * depth - far));
}

/** Distance for a grey sample, as the three example reads it: white at near, black at far. */
export function greyToDistance(grey: number, near: number, far: number): number {
  return (1 - grey) * (far - near) + near;
}

/** True when a sample holds a surface rather than background. */
export function isHit(sample: number, linear: boolean): boolean {
  if (linear) return sample > GREY_HIT_RANGE[0] && sample < GREY_HIT_RANGE[1];
  return sample < PERSPECTIVE_MISS;
}

/**
 * The camera-space position of one grid cell: x right, y up, z towards the viewer (so the point sits at -distance,
 * plus the z offset). The cell is sampled at its centre, so cell (0, 0) of a 2 x 2 grid is a quarter of the way in.
 */
export function backProject(
  cell: { x: number; y: number },
  grid: CloudGrid,
  distance: number,
  tangents: FovTangents,
  zOffset = 0,
): { x: number; y: number; z: number } {
  const u = (cell.x + 0.5) / grid.cols;
  const v = (cell.y + 0.5) / grid.rows;
  return { x: (u - 0.5) * distance * tangents.x, y: (v - 0.5) * distance * tangents.y, z: -distance + zOffset };
}

/** How far the cloud may drift while tokens stream, in metres. */
export const SCATTER_REACH_M = 0.35;

/** The scatter amount the token meter asks for: the normalised rate carries it, each arrival adds a flick. */
export function scatterFor(tokenRate01: number, pulse01: number): number {
  const rate = Number.isFinite(tokenRate01) ? Math.min(1, Math.max(0, tokenRate01)) : 0;
  const pulse = Number.isFinite(pulse01) ? Math.min(1, Math.max(0, pulse01)) : 0;
  return Math.min(1, rate + 0.3 * pulse);
}

/** Metres a point with hash h (0..1) has travelled at a scatter amount; every point moves at its own pace. */
export function scatterTravel(scatter01: number, h: number): number {
  return scatter01 * (0.3 + 0.7 * h) * SCATTER_REACH_M;
}

/** The alpha left to a point that has travelled this far: it fades as it leaves the figure, never fully. */
export function scatterFade(travelM: number): number {
  const t = Math.min(1, Math.max(0, travelM / SCATTER_REACH_M));
  return 1 - t * t * (3 - 2 * t) * 0.8;
}

/** Where the mirrored copy fades to nothing: this far below the floor. */
export const MIRROR_FADE_M = 0.9;
/** The reflection's alpha at the floor itself. */
export const MIRROR_FLOOR_ALPHA = 0.35;

/** The alpha multiplier of a reflected point whose source stands this high above the floor. */
export function mirrorFade(heightAboveFloorM: number): number {
  const t = Math.min(1, Math.max(0, heightAboveFloorM / MIRROR_FADE_M));
  return MIRROR_FLOOR_ALPHA * (1 - t * t * (3 - 2 * t));
}

/** Metres the depth probe's 16-bit encoding spans: the figure stands within a few metres of the camera. */
export const PROBE_RANGE_M = 8;

/**
 * Decode the being depth source's probe: RGBA pixels, each cell's nearest distance packed in the first two bytes
 * and its farthest in the last two the way three's packDepthToRG does (the high byte, then the fraction of the
 * next), as shares of the range. A cell that saw nothing packs 1 as its nearest and 0 as its farthest and is
 * skipped. Null when no cell saw a surface.
 */
export function decodeDepthProbe(pixels: Uint8Array, rangeM = PROBE_RANGE_M): DepthClipping | null {
  let near = Number.POSITIVE_INFINITY;
  let far = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const hi = ((pixels[i + 2] ?? 0) + (pixels[i + 3] ?? 0) / 255) / 256;
    if (hi <= 0) continue;
    const lo = ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) / 255) / 256;
    near = Math.min(near, lo);
    far = Math.max(far, hi);
  }
  return far > 0 && near < far ? { near: near * rangeM, far: far * rangeM } : null;
}
