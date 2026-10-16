/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUST_CELL_PX,
  bustGrid,
  CLOUD_GRIDS,
  POSTER_FLOOR_FPS,
  QUALITY_LADDER,
  QualityMonitor,
  qualityProfile,
  startingQuality,
} from '../src/stage/Quality.ts';
import type { Quality } from '../src/types.ts';

/** Feed the monitor a steady frame rate for a number of seconds, one sample per frame. */
const drive = <Rung extends string>(
  monitor: QualityMonitor<Rung>,
  fps: number,
  targetFps: number,
  seconds: number,
): void => {
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) monitor.sample(fps, dt, targetFps);
};

const watch = (start: Quality = 'full') => {
  const changes: Quality[] = [];
  const monitor = new QualityMonitor(start, (quality) => changes.push(quality));
  return { monitor, changes };
};

test('a steady 30 fps against a 30 fps target never steps down', () => {
  const { monitor, changes } = watch();
  drive(monitor, 30, 30, 60);
  assert.equal(monitor.current(), 'full');
  assert.deepEqual(changes, []);
});

test('a steady 30 fps against a 60 fps target stops after one step and never reaches the poster', () => {
  const { monitor, changes } = watch();
  drive(monitor, 30, 60, 4);
  assert.equal(monitor.current(), 'full', 'warmup and patience come first');
  drive(monitor, 30, 60, 120);
  assert.equal(monitor.current(), 'balanced');
  assert.deepEqual(changes, ['balanced']);
});

test('a frame rate that keeps dropping still walks the ladder down to the poster', () => {
  const { monitor, changes } = watch();
  drive(monitor, 40, 60, 8);
  assert.equal(monitor.current(), 'balanced');
  drive(monitor, 28, 60, 8);
  assert.equal(monitor.current(), 'lite');
  drive(monitor, 18, 60, 8);
  assert.equal(monitor.current(), 'poster');
  assert.deepEqual(changes, ['balanced', 'lite', 'poster']);
  drive(monitor, 10, 60, 8);
  assert.deepEqual(changes, ['balanced', 'lite', 'poster'], 'the poster is the end of the ladder');
});

test('the poster rung is never taken while the loop still holds the floor rate', () => {
  const { monitor } = watch();
  drive(monitor, 40, 60, 8);
  drive(monitor, 30, 60, 8);
  assert.equal(monitor.current(), 'lite');
  drive(monitor, POSTER_FLOOR_FPS + 1, 60, 60);
  assert.equal(monitor.current(), 'lite');
  drive(monitor, POSTER_FLOOR_FPS - 4, 60, 8);
  assert.equal(monitor.current(), 'poster');
});

test('a step that helped is followed by another when the rate is still short of the target', () => {
  const { monitor, changes } = watch();
  drive(monitor, 30, 60, 8);
  drive(monitor, 36, 60, 8);
  assert.deepEqual(changes, ['balanced', 'lite']);
});

test('an explicit tier restarts the watch', () => {
  const { monitor, changes } = watch();
  drive(monitor, 30, 60, 8);
  assert.equal(monitor.current(), 'balanced');
  monitor.set('full');
  assert.equal(monitor.current(), 'full');
  drive(monitor, 30, 60, 8);
  assert.deepEqual(changes, ['balanced', 'balanced']);
});

test('tiers only take away from what the device allows', () => {
  const caps = { bloom: true, ribbon: true, reflection: true, maxPixelRatio: 2 };
  assert.equal(qualityProfile('full', caps).bloom, true);
  assert.equal(qualityProfile('lite', caps).bloom, false);
  assert.equal(qualityProfile('lite', caps).pixelRatio, 1.25);
  assert.equal(qualityProfile('poster', caps).render, false);
  assert.equal(qualityProfile('full', { ...caps, bloom: false }).bloom, false);
  assert.equal(qualityProfile('full', { ...caps, ribbon: false }).ribbon, false);
  assert.equal(qualityProfile('full', { ...caps, reflection: false }).reflection, false);
  assert.equal(qualityProfile('balanced', { ...caps, ribbon: false }).ribbon, false);
});

test('the ladder: full draws everything, balanced the small cloud and the ribbon, lite the cloud alone', () => {
  const caps = { bloom: true, ribbon: true, reflection: true, maxPixelRatio: 2 };
  const full = qualityProfile('full', caps);
  assert.deepEqual(full.cloud, { cols: 320, rows: 240 });
  assert.equal(full.cloud, CLOUD_GRIDS.full);
  assert.deepEqual([full.ribbon, full.reflection, full.rim, full.bloom], [true, true, true, true]);
  const balanced = qualityProfile('balanced', caps);
  assert.deepEqual(balanced.cloud, { cols: 160, rows: 120 });
  assert.deepEqual([balanced.ribbon, balanced.reflection, balanced.rim, balanced.bloom], [true, false, true, true]);
  const lite = qualityProfile('lite', caps);
  assert.deepEqual(lite.cloud, { cols: 160, rows: 120 });
  assert.deepEqual([lite.ribbon, lite.reflection, lite.rim, lite.bloom], [false, false, false, false]);
  const poster = qualityProfile('poster', caps);
  assert.equal(poster.cloud, null);
  assert.deepEqual([poster.render, poster.ribbon, poster.reflection, poster.rim], [false, false, false, false]);
});

test('touch devices start at balanced, never higher; other requests pass through', () => {
  assert.equal(startingQuality('full', true), 'balanced');
  assert.equal(startingQuality('full', false), 'full');
  assert.equal(startingQuality('balanced', true), 'balanced');
  assert.equal(startingQuality('lite', true), 'lite');
  assert.equal(startingQuality('poster', false), 'poster');
});

test('the face look: full draws the 320 x 240 head cloud with the fan, balanced 200 x 150 with the fan, lite alone', () => {
  const caps = { bloom: true, ribbon: true, reflection: true, maxPixelRatio: 2 };
  const full = qualityProfile('full', caps);
  assert.deepEqual(full.headCloud, { cols: 320, rows: 240 });
  assert.equal(full.headCloud, CLOUD_GRIDS.head);
  assert.deepEqual([full.fan, full.ribbon, full.reflection], [true, true, true]);
  const balanced = qualityProfile('balanced', caps);
  assert.deepEqual(balanced.headCloud, { cols: 200, rows: 150 });
  assert.equal(balanced.fan, true);
  const lite = qualityProfile('lite', caps);
  assert.deepEqual(lite.headCloud, { cols: 120, rows: 90 });
  assert.deepEqual([lite.fan, lite.ribbon, lite.reflection], [false, false, false]);
  const poster = qualityProfile('poster', caps);
  assert.equal(poster.headCloud, null);
  assert.equal(poster.fan, false);
});

test('the kinect-demo lattice ceilings: 720 x 540 full, 400 x 300 balanced, 160 x 120 lite, none for the poster', () => {
  const caps = { bloom: false, ribbon: false, reflection: false, maxPixelRatio: 2 };
  assert.deepEqual(qualityProfile('full', caps).bustCloud, { cols: 720, rows: 540 });
  assert.deepEqual(qualityProfile('balanced', caps).bustCloud, { cols: 400, rows: 300 });
  assert.deepEqual(qualityProfile('lite', caps).bustCloud, CLOUD_GRIDS.bustLite);
  assert.deepEqual(CLOUD_GRIDS.bustLite, { cols: 160, rows: 120 });
  assert.deepEqual(CLOUD_GRIDS.bustTouch, { cols: 240, rows: 180 });
  assert.equal(qualityProfile('poster', caps).bustCloud, null);
});

test('bustGrid keeps a shard about BUST_CELL_PX across: rows follow the frame, in steps, between a floor and the ceiling', () => {
  const full = CLOUD_GRIDS.bust;
  // A 750 px frame (a 1440 x 900 window) is 375 rows, stepped to 372, and 4:3.
  assert.deepEqual(bustGrid(750, full), { cols: 496, rows: 372 });
  assert.equal(bustGrid(750, full).rows * BUST_CELL_PX >= 700, true);
  // A taller hero grows the lattice, so the shards stay the same size on screen.
  assert.ok(bustGrid(950, full).rows > bustGrid(750, full).rows);
  // Never past the ceiling, never under the floor, and a nonsense size falls back to the floor.
  assert.deepEqual(bustGrid(4000, full), full);
  assert.deepEqual(bustGrid(4000, CLOUD_GRIDS.bustReduced), CLOUD_GRIDS.bustReduced);
  assert.deepEqual(bustGrid(50, full), { cols: 128, rows: 96 });
  assert.deepEqual(bustGrid(Number.NaN, full), { cols: 128, rows: 96 });
  // A few pixels of resize land on the same step: no rebuild.
  assert.deepEqual(bustGrid(752, full), bustGrid(748, full));
});

test('a ladder of its own: the monitor walks its rungs and keeps the poster floor; the tiers are the default', () => {
  type Rung = 's0' | 's1' | 's2' | 'poster';
  const rungs: readonly Rung[] = ['s0', 's1', 's2', 'poster'];
  const changes: Rung[] = [];
  const monitor = new QualityMonitor<Rung>('s0', (rung) => changes.push(rung), rungs);
  assert.deepEqual(monitor.rungs(), rungs);
  drive(monitor, 40, 60, 8);
  assert.equal(monitor.current(), 's1');
  drive(monitor, 28, 60, 8);
  assert.equal(monitor.current(), 's2');
  drive(monitor, POSTER_FLOOR_FPS + 1, 60, 60);
  assert.equal(monitor.current(), 's2', 'never the poster while the floor rate holds');
  drive(monitor, POSTER_FLOOR_FPS - 6, 60, 8);
  assert.equal(monitor.current(), 'poster');
  assert.deepEqual(changes, ['s1', 's2', 'poster']);
  assert.deepEqual(new QualityMonitor('full', () => undefined).rungs(), QUALITY_LADDER);
});
