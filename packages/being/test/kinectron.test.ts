/// <reference types="node" />
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { KINECTRON_CLIPPING, SENSOR_TANGENTS } from '../src/data/depth/depthMath.ts';
import {
  AUTO_INIT_AFTER_MS,
  formatKinectronError,
  INIT_TIMEOUT_MS,
  type KinectronClient,
  KinectronDepthSource,
  type KinectronRawDepthPayload,
} from '../src/data/depth/KinectronDepthSource.ts';

/** Count console warnings while fn runs; the source must say things once, not at frame rate. */
const countWarnings = (fn: () => void): number => {
  const original = console.warn;
  let count = 0;
  console.warn = () => {
    count += 1;
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return count;
};

/** The metres the source's float texture holds. */
const metresOf = (source: KinectronDepthSource): Float32Array => {
  const image = source.texture.image as { data: Float32Array };
  return image.data;
};

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

test('without a client the source fails soft: no throw, never ready, sizes per sensor and feed', () => {
  const sources: KinectronDepthSource[] = [];
  const warnings = countWarnings(() => {
    sources.push(new KinectronDepthSource({ host: '127.0.0.1' }));
    sources.push(new KinectronDepthSource({ host: '10.0.0.2', port: 9001, feed: 'rawDepth', kinectType: 'windows' }));
    sources.push(new KinectronDepthSource({ host: '10.0.0.2', feed: 'rawDepth' }));
  });
  const [first, second, third] = sources;
  assert.ok(first && second && third);
  assert.ok(warnings <= 1, 'the missing client is reported once per page at most');
  assert.equal(first.ready, false);
  assert.equal(first.kind, 'kinectron');
  assert.equal(first.encoding, 'metres');
  assert.equal(first.fovTangents, SENSOR_TANGENTS.azure);
  assert.deepEqual([first.width, first.height], [640, 576], 'Azure depth: NFOV unbinned');
  assert.deepEqual([third.width, third.height], [320, 288], 'Azure raw depth: NFOV 2x2 binned');
  assert.equal(second.fovTangents, SENSOR_TANGENTS.windows);
  assert.deepEqual([second.width, second.height], [512, 424]);
  assert.doesNotThrow(() => {
    first.update();
    first.setClipping(1, 3);
    first.dispose();
    second.dispose();
    third.dispose();
  });
  assert.equal(first.ready, false);
});

test('a 1.x client is never told to connect: ready is listened for, the feed is asked for on ready', () => {
  const calls: string[] = [];
  const handlers: Record<string, (detail?: unknown) => void> = {};
  const peer = {
    connect() {
      calls.push('connect');
    },
  };
  const client: KinectronClient & { peer: typeof peer } = {
    on(event, callback) {
      handlers[event] = callback;
      calls.push(`on:${event}`);
    },
    isConnected: () => false,
    peer,
    setKinectType(type) {
      calls.push(`type:${type}`);
    },
    startDepth() {
      calls.push('depth');
    },
    stopAll() {
      calls.push('stop');
    },
    close() {
      calls.push('close');
    },
  };
  const source = new KinectronDepthSource({ host: '127.0.0.1', client, autoInit: false });
  assert.deepEqual(calls, ['on:ready', 'on:error'], 'nothing is connected or asked for before ready fires');
  handlers.ready?.();
  assert.deepEqual(calls, ['on:ready', 'on:error', 'depth'], 'no setKinectType on 1.x either: the server ignores it');
  source.dispose();
  assert.deepEqual(
    calls,
    ['on:ready', 'on:error', 'depth', 'stop'],
    'stopAll for a feed it requested; no close on a client it was given',
  );
  assert.ok(!calls.includes('connect'));
});

test('ready is idempotent: every reconnect re-requests the feed and nothing else happens twice', () => {
  const calls: string[] = [];
  const handlers: Record<string, (detail?: unknown) => void> = {};
  const client: KinectronClient = {
    on(event, callback) {
      handlers[event] = callback;
    },
    isConnected: () => false,
    initKinect() {
      calls.push('init');
      return Promise.resolve();
    },
    startDepth() {
      calls.push('depth');
    },
  };
  new KinectronDepthSource({ host: 'h', client, autoInit: false });
  handlers.ready?.();
  handlers.ready?.();
  handlers.ready?.();
  assert.deepEqual(calls, ['depth', 'depth', 'depth']);
});

test('a client already connected is started at once; a bare client with no events is started too', () => {
  const calls: string[] = [];
  const connected: KinectronClient = {
    on() {},
    isConnected: () => true,
    startDepth() {
      calls.push('depth');
    },
  };
  new KinectronDepthSource({ host: 'h', client: connected, autoInit: false });
  const bare: KinectronClient = {
    startDepth() {
      calls.push('bare');
    },
  };
  new KinectronDepthSource({ host: 'h', client: bare, autoInit: false });
  assert.deepEqual(calls, ['depth', 'bare']);
});

test('the feed comes first; initKinect runs only after 2 s without a frame, raced against 5 s, then the feed again', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls: string[] = [];
    const slot: { raw: ((frame: KinectronRawDepthPayload) => void) | null } = { raw: null };
    const client: KinectronClient = {
      initKinect() {
        calls.push('init');
        // Hangs for ever, as it does while the server blocks API calls.
        return new Promise(() => {});
      },
      startDepth() {
        calls.push('depth');
      },
      startRawDepth(callback) {
        calls.push('raw');
        slot.raw = callback;
      },
    };
    const source = new KinectronDepthSource({ host: 'h', feed: 'rawDepth', client });
    assert.deepEqual(calls, ['raw'], 'the feed is requested at once, before any initKinect');
    mock.timers.tick(AUTO_INIT_AFTER_MS - 1);
    assert.deepEqual(calls, ['raw']);
    mock.timers.tick(1);
    assert.deepEqual(calls, ['raw', 'init'], 'no frame in 2 s: initKinect');
    const warnings = countWarnings(() => mock.timers.tick(INIT_TIMEOUT_MS));
    assert.deepEqual(calls, ['raw', 'init', 'raw'], 'a hung initKinect still ends in another feed request');
    assert.ok(warnings <= 1);
    mock.timers.tick(AUTO_INIT_AFTER_MS + INIT_TIMEOUT_MS);
    assert.deepEqual(calls, ['raw', 'init', 'raw'], 'initKinect is tried once only');
    assert.ok(slot.raw);
    slot.raw?.({ depthValues: new Uint16Array([1000]), width: 1, height: 1 });
    assert.equal(source.ready, true);
    source.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('a frame within 2 s means no initKinect at all', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls: string[] = [];
    const slot: { raw: ((frame: KinectronRawDepthPayload) => void) | null } = { raw: null };
    const client: KinectronClient = {
      initKinect() {
        calls.push('init');
        return Promise.resolve();
      },
      startDepth() {},
      startRawDepth(callback) {
        slot.raw = callback;
      },
    };
    new KinectronDepthSource({ host: 'h', feed: 'rawDepth', client });
    mock.timers.tick(500);
    slot.raw?.({ depthValues: new Uint16Array([1000]), width: 1, height: 1 });
    mock.timers.tick(AUTO_INIT_AFTER_MS + INIT_TIMEOUT_MS);
    assert.deepEqual(calls, []);
  } finally {
    mock.timers.reset();
  }
});

test('errors are formatted from detail.error, then detail.message, then the value', () => {
  assert.equal(formatKinectronError({ error: 'peer unavailable' }), 'peer unavailable');
  assert.equal(formatKinectronError({ message: 'lost' }), 'lost');
  assert.equal(formatKinectronError({ error: 'first', message: 'second' }), 'first');
  assert.equal(formatKinectronError(new Error('boom')), 'boom');
  assert.equal(formatKinectronError('plain'), 'plain');
  assert.equal(formatKinectronError(42), '42');
  const handlers: Record<string, (detail?: unknown) => void> = {};
  const client: KinectronClient = {
    on(event, callback) {
      handlers[event] = callback;
    },
    isConnected: () => false,
    startDepth() {},
  };
  new KinectronDepthSource({ host: 'h', client, autoInit: false });
  const warnings = countWarnings(() => {
    handlers.error?.({ error: 'x' });
    handlers.error?.({ error: 'y' });
  });
  assert.ok(warnings <= 1, 'connection errors are said once');
});

test('a 0.x client: setKinectType, makeConnection, then the feed; raw frames may be a bare array', () => {
  const calls: string[] = [];
  const slot: { raw: ((frame: KinectronRawDepthPayload) => void) | null } = { raw: null };
  const client: KinectronClient = {
    makeConnection() {
      calls.push('connect');
    },
    setKinectType(type) {
      calls.push(`type:${type}`);
    },
    startDepth() {
      calls.push('depth');
    },
    startRawDepth(callback) {
      calls.push('raw');
      slot.raw = callback;
    },
  };
  const source = new KinectronDepthSource({
    host: 'h',
    kinectType: 'windows',
    feed: 'rawDepth',
    client,
    autoInit: false,
  });
  assert.deepEqual(calls, ['type:windows', 'connect', 'raw']);
  assert.deepEqual([source.width, source.height], [512, 424]);
  // A 0.x frame: a bare array of millimetres, the size taken from the sensor.
  const frame = new Array<number>(512 * 424).fill(0);
  frame[0] = 1234;
  frame[1] = 0;
  frame[2] = 4500;
  slot.raw?.(frame);
  assert.equal(source.ready, true);
  const metres = metresOf(source);
  assert.equal(metres.length, 512 * 424);
  close(metres[0] ?? 0, 1.234);
  assert.equal(metres[1], 0);
  close(metres[2] ?? 0, 4.5);
  source.dispose();
});

test('a 1.x raw frame goes into the float texture as metres; an error frame is skipped with one warning', () => {
  const slot: { raw: ((frame: KinectronRawDepthPayload) => void) | null } = { raw: null };
  const client: KinectronClient = {
    startDepth() {},
    startRawDepth(callback) {
      slot.raw = callback;
    },
  };
  const source = new KinectronDepthSource({ host: 'h', feed: 'rawDepth', client, autoInit: false });
  assert.deepEqual([source.width, source.height], [320, 288]);
  const warnings = countWarnings(() => {
    slot.raw?.({ error: 'no raw depth' } as unknown as KinectronRawDepthPayload);
    slot.raw?.({ error: 'no raw depth' } as unknown as KinectronRawDepthPayload);
  });
  assert.ok(warnings <= 1);
  assert.equal(source.ready, false);
  slot.raw?.({ depthValues: new Uint16Array([500, 0, 4000, 1750]), width: 2, height: 2 });
  assert.equal(source.ready, true);
  assert.deepEqual([source.width, source.height], [2, 2]);
  const metres = metresOf(source);
  close(metres[0] ?? 0, 0.5);
  assert.equal(metres[1], 0);
  close(metres[2] ?? 0, 4);
  close(metres[3] ?? 0, 1.75);
  source.dispose();
});

test('calibration: the Azure depth feed spans 0.5 to 4.0 m, the Kinect v2 0.5 to 4.5 m, unless the options say otherwise', () => {
  const azure = new KinectronDepthSource({ host: 'h', client: { startDepth() {} }, autoInit: false });
  assert.deepEqual(azure.range(), KINECTRON_CLIPPING.azure);
  assert.deepEqual(azure.range(), { near: 0.5, far: 4 });
  const v2 = new KinectronDepthSource({
    host: 'h',
    kinectType: 'windows',
    client: { startDepth() {} },
    autoInit: false,
  });
  assert.deepEqual(v2.range(), { near: 0.5, far: 4.5 });
  const custom = new KinectronDepthSource({
    host: 'h',
    client: { startDepth() {} },
    near: 0.85,
    far: 4,
    autoInit: false,
  });
  assert.deepEqual(custom.range(), { near: 0.85, far: 4 });
  custom.setClipping(1, 2);
  assert.deepEqual(custom.range(), { near: 1, far: 2 });
  custom.setClipping(3, 2);
  assert.deepEqual(custom.range(), { near: 1, far: 2 }, 'an impossible range is ignored');
});

test('a self-built client is closed on dispose; one the page handed in is not', () => {
  const calls: string[] = [];
  const g = globalThis as { Kinectron?: unknown };
  g.Kinectron = class {
    readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
      calls.push(`new:${typeof config === 'string' ? config : JSON.stringify(config)}`);
    }
    startDepth(): void {
      calls.push('depth');
    }
    stopAll(): void {
      calls.push('stop');
    }
    close(): void {
      calls.push('close');
    }
  };
  try {
    const own = new KinectronDepthSource({ host: 'kinect.ngrok-free.app', autoInit: false });
    assert.deepEqual(calls, ['new:kinect.ngrok-free.app', 'depth'], 'a bare host goes through as a string');
    own.dispose();
    assert.deepEqual(calls, ['new:kinect.ngrok-free.app', 'depth', 'stop', 'close']);
    calls.length = 0;
    new KinectronDepthSource({ host: '10.0.0.5', port: 9001, autoInit: false });
    assert.equal(calls[0], 'new:{"host":"10.0.0.5","port":9001}');
  } finally {
    delete g.Kinectron;
  }
  calls.length = 0;
  const given: KinectronClient = {
    startDepth() {
      calls.push('depth');
    },
    stopAll() {
      calls.push('stop');
    },
    close() {
      calls.push('close');
    },
  };
  const source = new KinectronDepthSource({ host: 'h', client: given, autoInit: false });
  source.dispose();
  source.dispose();
  assert.deepEqual(calls, ['depth', 'stop'], 'stopAll once, never close');
  // A source that never managed to request a feed has nothing to stop either.
  calls.length = 0;
  const throwing: KinectronClient = {
    startDepth() {
      throw new Error('no sensor');
    },
    stopAll() {
      calls.push('stop');
    },
  };
  const made: { source: KinectronDepthSource | null } = { source: null };
  const warnings = countWarnings(() => {
    made.source = new KinectronDepthSource({ host: 'h', client: throwing, autoInit: false });
  });
  assert.ok(warnings <= 1);
  made.source?.dispose();
  assert.deepEqual(calls, []);
});

test('a raw frame delivered after dispose is ignored', () => {
  const slot: { raw: ((frame: KinectronRawDepthPayload) => void) | null } = { raw: null };
  const client: KinectronClient = {
    startDepth() {},
    startRawDepth(callback) {
      slot.raw = callback;
    },
  };
  const source = new KinectronDepthSource({ host: 'h', feed: 'rawDepth', client, autoInit: false });
  source.dispose();
  assert.doesNotThrow(() => slot.raw?.({ depthValues: new Uint16Array([1000, 0, 2000]), width: 3, height: 1 }));
  assert.equal(source.ready, false);
});
