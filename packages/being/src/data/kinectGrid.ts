/**
 * The triangle modes of the kinect cloud (wire and mesh), kept free of three.js so node --test can check them. The
 * depth grid is drawn as an index-free lattice of cells, six vertices each, so the barycentric wire shader can take
 * its corner from gl_VertexID the way the wire being does. The shaders in avatar/shaders/kinectGrid.*.glsl.ts are
 * these rules written in GLSL; keep the two in step.
 */
import type { CloudGrid } from './depth/depthMath.ts';

/** The lattice the triangle modes sample, whatever the point grid: (cols - 1) x (rows - 1) cells of two triangles. */
export const GRID_LATTICE: Readonly<CloudGrid> = { cols: 160, rows: 120 };
export const VERTICES_PER_CELL = 6;
/**
 * Corner distances further apart than this share of the nearest corner's distance (scaled by the displacement) make
 * a cell a depth jump, which is not drawn: a sensor sees about 4 cm of silhouette at 1 m, not a fixed 12 cm.
 */
export const DISCONTINUITY_SHARE = 0.04;
/** The six corners of a cell in draw order: two triangles, (0,0) (1,0) (0,1) and (1,0) (1,1) (0,1). */
export const CELL_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [0, 1],
];

export interface GridVertex {
  /** The cell's lower-left lattice point. */
  cell: { x: number; y: number };
  /** Which corner of the cell this vertex is. */
  corner: readonly [number, number];
  /** Which barycentric coordinate is 1 at this vertex. */
  bary: 0 | 1 | 2;
}

/** Vertices in the index-free grid of a lattice. */
export function gridVertexCount(lattice: CloudGrid): number {
  return Math.max(0, lattice.cols - 1) * Math.max(0, lattice.rows - 1) * VERTICES_PER_CELL;
}

/** Decode a vertex id the way the vertex shader does. */
export function gridVertex(id: number, lattice: CloudGrid): GridVertex {
  const cellId = Math.floor(id / VERTICES_PER_CELL);
  const c = id - cellId * VERTICES_PER_CELL;
  const cols = Math.max(1, lattice.cols - 1);
  return {
    cell: { x: cellId % cols, y: Math.floor(cellId / cols) },
    corner: CELL_CORNERS[c] ?? [0, 0],
    bary: (c % 3) as 0 | 1 | 2,
  };
}

/** Relief about a centre distance: 1 is true to the depth, 2 doubles every departure from the centre. */
export function displace(distanceM: number, centreM: number, displacement: number): number {
  return centreM + (distanceM - centreM) * displacement;
}

/**
 * The discontinuity rule: a cell is drawn only when all four corners saw a surface (positive distances, after the
 * displacement) and they lie within the relative threshold, itself scaled by the displacement.
 */
export function cellDrawn(corners: readonly [number, number, number, number], displacement = 1): boolean {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const d of corners) {
    if (!(d > 0)) return false;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return hi - lo <= DISCONTINUITY_SHARE * lo * displacement;
}

/** Three-Kinectron's brightness and contrast on one channel: (c - 0.5) * contrast + 0.5 + brightness, floored at 0. */
export function brightnessContrast(channel: number, brightness: number, contrast: number): number {
  return Math.max(0, (channel - 0.5) * contrast + 0.5 + brightness);
}
