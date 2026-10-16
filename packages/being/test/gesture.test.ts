/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GestureEvent, GestureTracker, HOLD_MS, HOLD_SLOP_PX, VELOCITY_WINDOW_MS } from '../src/stage/gesture.ts';

const track = () => {
  const events: GestureEvent[] = [];
  const tracker = new GestureTracker((event) => events.push(event));
  const types = (): string[] => events.map((event) => event.type);
  return { tracker, events, types };
};

const near = (actual: number, expected: number, tolerance: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

test('a short still press is a tap', () => {
  const { tracker, events, types } = track();
  tracker.down(1, 100, 100, 0);
  tracker.move(1, 103, 102, 60);
  tracker.tick(120);
  tracker.up(1, 103, 102, 150);
  assert.deepEqual(types(), ['tap']);
  assert.deepEqual(events[0], { type: 'tap', x: 103, y: 102 });
  assert.equal(tracker.pressing(), false);
});

test('a press held still for 250 ms is a hold, kept until the release however it moves', () => {
  const { tracker, types } = track();
  tracker.down(7, 50, 50, 1000);
  tracker.move(7, 54, 52, 1100);
  tracker.tick(1000 + HOLD_MS - 1);
  assert.deepEqual(types(), [], 'not before 250 ms');
  tracker.tick(1000 + HOLD_MS);
  assert.deepEqual(types(), ['hold-start']);
  assert.equal(tracker.holding(), true);
  assert.equal(tracker.pointerId(), 7);
  // Once it is a hold, travel no longer makes it a drag.
  tracker.move(7, 200, 300, 1400);
  assert.deepEqual(types(), ['hold-start']);
  tracker.up(7, 200, 300, 1500);
  assert.deepEqual(types(), ['hold-start', 'hold-end']);
  assert.equal(tracker.holding(), false);
  assert.equal(tracker.pointerId(), null);
});

test('a hold that comes due between events still starts before the release ends it', () => {
  const { tracker, types } = track();
  tracker.down(1, 0, 0, 0);
  tracker.up(1, 2, 1, 400);
  assert.deepEqual(types(), ['hold-start', 'hold-end'], 'a 400 ms still press is a hold, not a tap');
});

test('10 px of travel before 250 ms makes a drag whose deltas add up to the travel', () => {
  const { tracker, events, types } = track();
  tracker.down(1, 100, 100, 0);
  tracker.move(1, 100 + HOLD_SLOP_PX - 1, 100, 20);
  assert.deepEqual(types(), [], 'under the slop it is still a press');
  tracker.move(1, 112, 104, 40);
  assert.deepEqual(types(), ['drag-start', 'drag']);
  assert.deepEqual(events[0], { type: 'drag-start', x: 100, y: 100 });
  tracker.move(1, 130, 110, 60);
  tracker.tick(1000);
  assert.equal(tracker.holding(), false, 'a drag never turns into a hold');
  tracker.up(1, 150, 116, 80);
  let dx = 0;
  let dy = 0;
  for (const event of events) {
    if (event.type === 'drag') {
      dx += event.dx;
      dy += event.dy;
    }
  }
  assert.equal(dx, 50);
  assert.equal(dy, 16);
  assert.equal(types().at(-1), 'drag-end');
});

test('the release velocity comes from the last 80 ms of the drag', () => {
  const { tracker, events } = track();
  tracker.down(1, 0, 0, 0);
  // Slow at first, then 1000 px a second across the last 80 ms.
  tracker.move(1, 20, 0, 100);
  tracker.move(1, 40, 0, 200);
  for (let t = 210; t <= 300; t += 10) tracker.move(1, 40 + (t - 200), (t - 200) * 0.5, t);
  tracker.up(1, 140, 50, 300);
  const end = events.at(-1);
  assert.ok(end?.type === 'drag-end');
  near(end.vx, 1000, 1, 'vx');
  near(end.vy, 500, 1, 'vy');
  assert.equal(end.cancelled, false);
  assert.equal(VELOCITY_WINDOW_MS, 80);
});

test('a drag that rests before letting go has no velocity', () => {
  const { tracker, events } = track();
  tracker.down(1, 0, 0, 0);
  tracker.move(1, 30, 0, 20);
  tracker.move(1, 60, 0, 40);
  tracker.up(1, 60, 0, 40 + VELOCITY_WINDOW_MS + 50);
  assert.deepEqual(events.at(-1), { type: 'drag-end', vx: 0, vy: 0, cancelled: false });
});

test('a flick whose only event is its release is a drag, not a tap', () => {
  const { tracker, types } = track();
  tracker.down(1, 0, 0, 0);
  tracker.up(1, 80, 0, 40);
  assert.deepEqual(types(), ['drag-start', 'drag', 'drag-end']);
});

test('a second pointer cancels a drag without coasting and nothing starts until every pointer is up', () => {
  const { tracker, events, types } = track();
  tracker.down(1, 0, 0, 0);
  tracker.move(1, 40, 0, 20);
  tracker.down(2, 200, 200, 30);
  assert.deepEqual(types(), ['drag-start', 'drag', 'drag-end']);
  assert.deepEqual(events.at(-1), { type: 'drag-end', vx: 0, vy: 0, cancelled: true });
  assert.equal(tracker.pressing(), false);
  // Neither finger drives anything now, and a third press does not start a gesture either.
  tracker.move(1, 90, 0, 40);
  tracker.move(2, 260, 200, 40);
  tracker.tick(1000);
  tracker.up(1, 90, 0, 50);
  tracker.down(3, 10, 10, 60);
  tracker.up(3, 10, 10, 70);
  tracker.up(2, 260, 200, 80);
  assert.deepEqual(types(), ['drag-start', 'drag', 'drag-end']);
  // With every pointer up, the next press is a gesture again.
  tracker.down(4, 0, 0, 100);
  tracker.up(4, 0, 0, 120);
  assert.equal(types().at(-1), 'tap');
});

test('a second pointer ends a hold', () => {
  const { tracker, types } = track();
  tracker.down(1, 0, 0, 0);
  tracker.tick(HOLD_MS);
  tracker.down(2, 50, 50, HOLD_MS + 10);
  assert.deepEqual(types(), ['hold-start', 'hold-end']);
});

test('a cancel from the browser ends a drag without coasting and a hold with its end', () => {
  const drag = track();
  drag.tracker.down(1, 0, 0, 0);
  drag.tracker.move(1, 0, 40, 20);
  drag.tracker.cancel(1);
  assert.deepEqual(drag.types(), ['drag-start', 'drag', 'drag-end']);
  assert.deepEqual(drag.events.at(-1), { type: 'drag-end', vx: 0, vy: 0, cancelled: true });
  // The release that follows the cancel, if any, is ignored.
  drag.tracker.up(1, 0, 80, 40);
  assert.equal(drag.types().length, 3);

  const hold = track();
  hold.tracker.down(1, 0, 0, 0);
  hold.tracker.tick(HOLD_MS + 5);
  hold.tracker.cancel();
  assert.deepEqual(hold.types(), ['hold-start', 'hold-end']);
  assert.equal(hold.tracker.pressing(), false);
});

test('a move with nothing pressed is a hover, and a press that never saw its release starts over', () => {
  const { tracker, events, types } = track();
  tracker.move(1, 5, 6, 0);
  assert.deepEqual(events[0], { type: 'hover', x: 5, y: 6 });
  tracker.down(1, 0, 0, 10);
  tracker.move(1, 30, 0, 20);
  // The same pointer goes down again: the old drag ends where it was and a new press begins.
  tracker.down(1, 100, 100, 500);
  assert.deepEqual(types(), ['hover', 'drag-start', 'drag', 'drag-end']);
  assert.equal(tracker.pressing(), true);
  tracker.up(1, 100, 100, 520);
  assert.equal(types().at(-1), 'tap');
});
