/**
 * The sculpture's geometry, free of three.js so node --test can check it. The head and the bust of the body are
 * welded into one surface (their seam vertices are identical in the asset), every base triangle is cut into n x n
 * regular sub-triangles (the shards), and the vertex graph carries the water.
 */

/** Positions of a mesh's vertices in its own space, and its triangles as vertex indices. */
export interface MeshPart {
  positions: Float32Array;
  index: ArrayLike<number>;
  /** Per vertex 0..1: R ambient occlusion, G tone, B part id (raw byte / 255), A calm. Absent means plain skin. */
  sculpt?: ArrayLike<number> | null;
  /** Its tone is already the albedo (the eyeballs): the mouth's darkening does not apply. */
  plain?: boolean;
}

export interface Welded {
  /** Vertex count of the welded surface. */
  count: number;
  /** For every part, its vertex index -> welded index (-1 when the vertex is cropped away). */
  remap: Int32Array[];
  /** Triangles of the welded surface (3 indices each), with the part they came from. */
  tris: Uint32Array;
  triPart: Uint8Array;
  /** Per welded vertex: tone, calm and occlusion (for the shader) and whether it is a lip (voice source). */
  tone: Float32Array;
  /** How bright the surface is drawn: the tone, with the mouth's inside dark and the lips a touch bright. */
  albedo: Float32Array;
  calm: Float32Array;
  ao: Float32Array;
  lips: Uint32Array;
  /** Neighbour lists (CSR) for the water. */
  nbrStart: Uint32Array;
  nbr: Uint32Array;
}

/** Positions closer than this (metres) are one vertex: the asset's seam vertices coincide exactly. */
const WELD_M = 1e-4;

/**
 * Weld parts by position. A part's triangles are kept when every corner passes `keep(part, vertex)` (the bust crop).
 * The first part to claim a position owns it (Head before Body).
 */
export function weld(parts: MeshPart[], keep: (part: number, vertex: number) => boolean): Welded {
  const grid = new Map<string, number>();
  const remap: Int32Array[] = [];
  const toneL: number[] = [];
  const calmL: number[] = [];
  const aoL: number[] = [];
  const albedoL: number[] = [];
  let count = 0;
  const key = (x: number, y: number, z: number): string =>
    `${Math.round(x / WELD_M)},${Math.round(y / WELD_M)},${Math.round(z / WELD_M)}`;
  parts.forEach((part, p) => {
    const n = part.positions.length / 3;
    const map = new Int32Array(n).fill(-1);
    for (let v = 0; v < n; v += 1) {
      if (!keep(p, v)) continue;
      const k = key(part.positions[v * 3] ?? 0, part.positions[v * 3 + 1] ?? 0, part.positions[v * 3 + 2] ?? 0);
      const found = grid.get(k);
      if (found !== undefined) {
        map[v] = found;
        continue;
      }
      grid.set(k, count);
      map[v] = count;
      const s = part.sculpt;
      aoL.push(s ? (s[v * 4] ?? 1) : 1);
      const tone = s ? (s[v * 4 + 1] ?? 1) : 1;
      toneL.push(tone);
      albedoL.push(part.plain ? tone : albedoOf(tone, Math.round((s ? (s[v * 4 + 2] ?? 0) : 0) * 255)));
      calmL.push(s ? (s[v * 4 + 3] ?? 1) : 1);
      count += 1;
    }
    remap.push(map);
  });
  const trisL: number[] = [];
  const partL: number[] = [];
  parts.forEach((part, p) => {
    const map = remap[p] as Int32Array;
    for (let t = 0; t + 2 < part.index.length; t += 3) {
      const a = map[part.index[t] ?? 0] ?? -1;
      const b = map[part.index[t + 1] ?? 0] ?? -1;
      const c = map[part.index[t + 2] ?? 0] ?? -1;
      if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
      trisL.push(a, b, c);
      partL.push(p);
    }
  });
  const tone = Float32Array.from(toneL);
  const lips: number[] = [];
  // The lips carry tone 0.8 in the baked attribute (skin 1, teeth 0.92, tongue 0.55, interior 0.3).
  tone.forEach((t, v) => {
    if (Math.abs(t - 0.8) < 0.03) lips.push(v);
  });
  const { start, list } = neighbours(count, trisL);
  return {
    count,
    remap,
    tris: Uint32Array.from(trisL),
    triPart: Uint8Array.from(partL),
    tone,
    albedo: Float32Array.from(albedoL),
    calm: Float32Array.from(calmL),
    ao: Float32Array.from(aoL),
    lips: Uint32Array.from(lips),
    nbrStart: start,
    nbr: list,
  };
}

/**
 * The sculpture's brightness for a vertex of the head or body, from its baked tone and part (0 skin, 1 teeth, 2
 * tongue). Teeth and tongue sit in shadow and the mouth's inside is near black, so the lips' outline carries each
 * mouth shape; the lips themselves are drawn a little brighter than the skin.
 */
export function albedoOf(tone: number, part: number): number {
  if (part === 1) return 0.38;
  if (part === 2) return 0.26;
  if (Math.abs(tone - 0.8) < 0.03) return 1.12;
  if (tone < 0.5) return tone * 0.15;
  return tone;
}

function neighbours(count: number, tris: number[]): { start: Uint32Array; list: Uint32Array } {
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t] ?? 0;
    const b = tris[t + 1] ?? 0;
    const c = tris[t + 2] ?? 0;
    sets[a]?.add(b).add(c);
    sets[b]?.add(a).add(c);
    sets[c]?.add(a).add(b);
  }
  const start = new Uint32Array(count + 1);
  let total = 0;
  sets.forEach((s, v) => {
    start[v] = total;
    total += s.size;
  });
  start[count] = total;
  const list = new Uint32Array(total);
  let i = 0;
  for (const s of sets) for (const n of s) list[i++] = n;
  return { start, list };
}

/**
 * The shards: every triangle cut into n x n sub-triangles, n from its longest edge over the target shard size
 * (scaled by the part's importance). Per shard: the triangle's three welded corners, and (u, v, n, up) where (u, v) is
 * the shard's centre in the triangle's barycentric frame P = A(1-u-v) + Bu + Cv.
 */
export interface Shards {
  count: number;
  /** 3 floats per shard: corner vertex indices. */
  tri: Float32Array;
  /** 4 floats per shard: centre u, v, subdivision n, 1 for an upward shard. */
  shard: Float32Array;
}

/** How many shards a triangle gets for a target edge (metres): n squared. */
export function subdivisions(edgeM: number, targetM: number): number {
  if (!(edgeM > 0) || !(targetM > 0)) return 1;
  return Math.min(64, Math.max(1, Math.ceil(edgeM / targetM)));
}

export function shardCount(
  tris: Uint32Array,
  positions: Float32Array,
  scale: (t: number) => number,
  targetM: number,
): number {
  let total = 0;
  for (let t = 0; t * 3 + 2 < tris.length; t += 1) {
    const n = subdivisions(longestEdge(tris, positions, t), targetM * scale(t));
    total += n * n;
  }
  return total;
}

export function longestEdge(tris: Uint32Array, p: Float32Array, t: number): number {
  const a = (tris[t * 3] ?? 0) * 3;
  const b = (tris[t * 3 + 1] ?? 0) * 3;
  const c = (tris[t * 3 + 2] ?? 0) * 3;
  const d = (i: number, j: number): number =>
    Math.hypot((p[i] ?? 0) - (p[j] ?? 0), (p[i + 1] ?? 0) - (p[j + 1] ?? 0), (p[i + 2] ?? 0) - (p[j + 2] ?? 0));
  return Math.max(d(a, b), d(b, c), d(c, a));
}

export function buildShards(
  tris: Uint32Array,
  positions: Float32Array,
  scale: (t: number) => number,
  targetM: number,
): Shards {
  const count = shardCount(tris, positions, scale, targetM);
  const tri = new Float32Array(count * 3);
  const shard = new Float32Array(count * 4);
  let s = 0;
  for (let t = 0; t * 3 + 2 < tris.length; t += 1) {
    const n = subdivisions(longestEdge(tris, positions, t), targetM * scale(t));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n - i; j += 1) {
        // Upward shard (i, j), (i+1, j), (i, j+1); downward (i+1, j), (i, j+1), (i+1, j+1) where it fits.
        put(s++, t, (i + 1 / 3) / n, (j + 1 / 3) / n, n, 1);
        if (i + j < n - 1) put(s++, t, (i + 2 / 3) / n, (j + 2 / 3) / n, n, 0);
      }
    }
  }
  return { count, tri, shard };

  function put(k: number, t: number, u: number, v: number, n: number, up: number): void {
    tri[k * 3] = tris[t * 3] ?? 0;
    tri[k * 3 + 1] = tris[t * 3 + 1] ?? 0;
    tri[k * 3 + 2] = tris[t * 3 + 2] ?? 0;
    shard[k * 4] = u;
    shard[k * 4 + 1] = v;
    shard[k * 4 + 2] = n;
    shard[k * 4 + 3] = up;
  }
}

/**
 * One leapfrog step of the wave equation on the vertex graph: h' = (2h - hp + k (mean of neighbours - h)) damping,
 * clamped. k 0.5 keeps it stable on any graph (each step moves a ring at most one edge).
 */
export function waveStep(h: Float32Array, hp: Float32Array, w: Welded, k = 0.5, damping = 0.994, limit = 1): void {
  const n = w.count;
  for (let v = 0; v < n; v += 1) {
    const a = w.nbrStart[v] ?? 0;
    const b = w.nbrStart[v + 1] ?? 0;
    let sum = 0;
    for (let i = a; i < b; i += 1) sum += h[w.nbr[i] ?? 0] ?? 0;
    const mean = b > a ? sum / (b - a) : (h[v] ?? 0);
    const hv = h[v] ?? 0;
    const next = (2 * hv - (hp[v] ?? 0) + k * (mean - hv)) * damping;
    hp[v] = Math.min(limit, Math.max(-limit, next));
  }
}
