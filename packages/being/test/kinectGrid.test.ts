/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brightnessContrast,
  CELL_CORNERS,
  CELL_CORNERS_ODD,
  cellDrawn,
  DISCONTINUITY_SHARE,
  displace,
  GRID_LATTICE,
  gridVertex,
  gridVertexCount,
  JITTER,
  latticePoint,
  STAGGER,
  VERTICES_PER_CELL,
} from '../src/data/kinectGrid.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

type Corners = [number, number, number, number];

test('the index-free grid has six vertices per cell and decodes like the shader', () => {
  // A 4 x 3 lattice is 3 x 2 cells.
  const lattice = { cols: 4, rows: 3 };
  assert.equal(gridVertexCount(lattice), 3 * 2 * 6);
  assert.equal(gridVertexCount(GRID_LATTICE), 159 * 119 * 6);
  const first = [0, 1, 2, 3, 4, 5].map((id) => gridVertex(id, lattice));
  assert.deepEqual(
    first.map((v) => v.corner),
    CELL_CORNERS.map((c) => [...c]),
  );
  assert.deepEqual(
    first.map((v) => v.bary),
    [0, 1, 2, 0, 1, 2],
  );
  for (const v of first) assert.deepEqual(v.cell, { x: 0, y: 0 });
  // Cell 4 of a 3-wide grid is (1, 1), on an odd row: the other diagonal, so its triangles are (0,0) (1,0) (1,1)
  // and (0,0) (1,1) (0,1), and its fifth vertex is the far corner of the second.
  const odd = [0, 1, 2, 3, 4, 5].map((id) => gridVertex(4 * VERTICES_PER_CELL + id, lattice));
  assert.deepEqual(
    odd.map((v) => [...v.corner]),
    CELL_CORNERS_ODD.map((c) => [...c]),
  );
  const v = gridVertex(4 * VERTICES_PER_CELL + 4, lattice);
  assert.deepEqual(v.cell, { x: 1, y: 1 });
  assert.deepEqual([...v.corner], [1, 1]);
  assert.equal(v.bary, 1);
  assert.deepEqual(gridVertex(gridVertexCount(lattice) - 1, lattice).cell, { x: 2, y: 1 });
});

test('the staggered lattice cuts every cell into two near-equilateral triangles', () => {
  // Odd rows stand half a cell to the right.
  assert.deepEqual(latticePoint(3, 0), { x: 3, y: 0 });
  assert.deepEqual(latticePoint(3, 1), { x: 3 + STAGGER, y: 1 });
  const side = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  for (const row of [0, 1]) {
    const corners = row === 1 ? CELL_CORNERS_ODD : CELL_CORNERS;
    for (const tri of [corners.slice(0, 3), corners.slice(3)]) {
      const p = tri.map(([cx, cy]) => latticePoint(5 + cx, row + cy));
      const [a, b, c] = p as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      const sides = [side(a, b), side(b, c), side(c, a)].sort((m, n) => m - n);
      // Base 1 and two sides of sqrt(1.25): an isosceles triangle, never the long diagonal of a square (1.414).
      close(sides[0] ?? 0, 1);
      close(sides[2] ?? 0, Math.sqrt(1.25));
    }
  }
  // The jitter stays well inside a cell, so no facet folds over its neighbour.
  assert.ok(JITTER > 0 && JITTER < 0.5);
});

test('the discontinuity rule parks cells with a miss or a relative depth jump, scaled by the displacement', () => {
  assert.equal(cellDrawn([2, 2.05, 2.1, 2.11]), false, '11 cm at 2 m is a jump of 5.5 percent');
  assert.equal(cellDrawn([2, 2.02, 2.04, 2.05]), true);
  assert.equal(cellDrawn([2, 2, 2, 2 + 2 * DISCONTINUITY_SHARE * 0.99]), true);
  assert.equal(cellDrawn([1, 1, 1, 1.05]), false, 'the same 5 cm is a jump at 1 m');
  assert.equal(cellDrawn([3, 3, 3, 3.1]), true, 'but 10 cm at 3 m is a slope');
  assert.equal(cellDrawn([2, 2, 2, 2.2]), false);
  assert.equal(cellDrawn([2, 2, -1, 2]), false, 'a corner that saw nothing');
  assert.equal(cellDrawn([2, 2, 0, 2]), false);
  // Doubling the relief doubles every gap and the threshold alike, so the verdicts do not change.
  const smooth: Corners = [2, 2.02, 2.04, 2.05];
  const jump: Corners = [2, 2, 2, 2.2];
  const relief = (corners: Corners, centre: number, amount: number): Corners =>
    corners.map((d) => displace(d, centre, amount)) as Corners;
  assert.equal(cellDrawn(relief(smooth, 2.025, 2), 2), true);
  assert.equal(cellDrawn(relief(jump, 2.1, 2), 2), false);
  assert.equal(cellDrawn(relief(smooth, 2.025, 0.5), 0.5), true);
});

test('displacement is relief about the centre: 1 is true to the depth', () => {
  close(displace(2.3, 2, 1), 2.3);
  close(displace(2.3, 2, 2), 2.6);
  close(displace(1.8, 2, 0.5), 1.9);
  close(displace(2, 2, 7), 2);
});

test('brightness and contrast follow Three-Kinectron: (c - 0.5) * contrast + 0.5 + brightness', () => {
  close(brightnessContrast(0.25, 0, 1), 0.25);
  close(brightnessContrast(0.25, 0.1, 1), 0.35);
  close(brightnessContrast(0.25, 0, 2), 0);
  close(brightnessContrast(0.75, 0, 2), 1);
  close(brightnessContrast(0.9, 0, 0), 0.5);
  assert.equal(brightnessContrast(0.1, -0.5, 1), 0, 'never below black');
});
