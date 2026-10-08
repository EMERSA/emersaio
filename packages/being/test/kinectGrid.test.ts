/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brightnessContrast,
  CELL_CORNERS,
  cellDrawn,
  DISCONTINUITY_SHARE,
  displace,
  GRID_LATTICE,
  gridVertex,
  gridVertexCount,
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
  // Cell 4 of a 3-wide grid is (1, 1); its fifth vertex is the far corner of the second triangle.
  const v = gridVertex(4 * VERTICES_PER_CELL + 4, lattice);
  assert.deepEqual(v.cell, { x: 1, y: 1 });
  assert.deepEqual([...v.corner], [1, 1]);
  assert.equal(v.bary, 1);
  assert.deepEqual(gridVertex(gridVertexCount(lattice) - 1, lattice).cell, { x: 2, y: 1 });
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
