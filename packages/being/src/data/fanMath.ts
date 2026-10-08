/**
 * The data fan's maths, free of three.js for node --test: where a canvas-normalised target lands on the plane in
 * front of the head, which node each line runs to, how the line starts are picked from the head, and the nodes
 * the runtime fixes (the minimal brief, shared contract item 4).
 */
import type { FanTarget } from '../types.ts';

export const FAN_LINES = 120;
/** The most nodes the shader holds; further targets are ignored. */
export const FAN_MAX_TARGETS = 8;
/** The nodes sit on a plane this far in front of the head's centre. */
export const FAN_PLANE_M = 0.3;
/** Node sprite diameter in CSS pixels: a small ice dot, not a glow. */
export const FAN_NODE_PX = 6;
/** The lines' alpha on dark; cream gets a little more ink for the same read. */
export const FAN_LINE_ALPHA = 0.18;
/** The nodes as shares of the canvas from the left and from the top: x 94 percent, y 16, 26, 36 and 46 percent. */
export const FAN_NODE_SHARES: ReadonlyArray<readonly [number, number]> = [
  [0.94, 0.16],
  [0.94, 0.26],
  [0.94, 0.36],
  [0.94, 0.46],
];
/** The same nodes in canvas-normalised coordinates (-1..1, x right, y up): fixed by the runtime, not by the page. */
export const DEFAULT_FAN_TARGETS: readonly FanTarget[] = FAN_NODE_SHARES.map(([x, y]) => ({
  x: x * 2 - 1,
  y: 1 - y * 2,
}));

/** A level camera at (0, y, z) looking down -z, with a vertical field of view in degrees. */
export interface LevelCamera {
  fovDeg: number;
  aspect: number;
  y: number;
  z: number;
}

/** The world point a canvas-normalised target (-1..1, x right, y up) marks on the plane z = planeZ. */
export function projectToPlane(
  target: FanTarget,
  camera: LevelCamera,
  planeZ: number,
): { x: number; y: number; z: number } {
  const depth = Math.max(0.01, camera.z - planeZ);
  const half = depth * Math.tan((camera.fovDeg * Math.PI) / 360);
  return { x: target.x * half * camera.aspect, y: camera.y + target.y * half, z: planeZ };
}

/** The node a line runs to: the lines are dealt round the nodes in turn. */
export const lineTarget = (line: number, targetCount: number): number => (targetCount > 0 ? line % targetCount : 0);

/** Picks spread evenly over a list of vertices, each nudged by a hash so the starts do not line up in a pattern. */
export function sampleIndices(count: number, picks: number): number[] {
  const out: number[] = [];
  if (count <= 0) return out;
  const stride = count / Math.max(1, picks);
  for (let i = 0; i < picks; i += 1) {
    const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    out.push(Math.min(count - 1, Math.max(0, Math.floor((i + 0.5 + 0.45 * jitter) * stride))));
  }
  return out;
}
