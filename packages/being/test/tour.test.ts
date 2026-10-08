/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageAdapter } from '../src/tour/PageAdapter.ts';
import { createTour, type TourStorage } from '../src/tour/Tour.ts';
import type { BeingHandle, SpeakRequest, TourScript } from '../src/types.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const until = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the tour');
    await tick();
  }
};

const fakeBeing = (options: { fail?: boolean } = {}) => {
  const spoken: SpeakRequest[] = [];
  let stops = 0;
  const being: BeingHandle = {
    ready: Promise.resolve(),
    speak: async (request) => {
      spoken.push(request);
      await tick();
      if (options.fail) throw new Error('no audio');
      request.onCaption?.(request.text, true);
    },
    stopSpeaking: () => {
      stops += 1;
    },
    setTheme: () => undefined,
    setQuality: () => undefined,
    getQuality: () => 'full',
    isSpeaking: () => false,
    setAudioLevel: () => undefined,
    tokens: () => undefined,
    pose: () => undefined,
    lookAt: () => undefined,
    setListening: () => undefined,
    setLook: () => undefined,
    getLook: () => 'hybrid',
    setShatter: () => undefined,
    fan: { setTargets: () => undefined, setActivity: () => undefined, setEnabled: () => undefined },
    setDepthSource: () => undefined,
    kinect: {
      setClipping: () => undefined,
      setPointSize: () => undefined,
      setZOffset: () => undefined,
      setMode: () => undefined,
      setDisplacement: () => undefined,
      setBrightness: () => undefined,
      setContrast: () => undefined,
      setOpacity: () => undefined,
      setLineWidth: () => undefined,
    },
    stats: () => ({
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      quality: 'full',
      points: 0,
      depth: { near: 0, far: 0 },
      look: 'hybrid',
      mode: 'points',
    }),
    dispose: () => undefined,
  };
  return { being, spoken, stops: () => stops };
};

const fakeAdapter = () => {
  const log: string[] = [];
  const adapter: PageAdapter = {
    scrollTo: async (selector) => {
      log.push(`scroll:${selector}`);
    },
    highlight: (selector) => {
      log.push(`highlight:${selector}`);
    },
    caption: (text, done) => {
      log.push(`caption:${done ? 'done' : 'part'}:${text}`);
    },
    dispatch: (action) => {
      log.push(`dispatch:${action.type}`);
    },
  };
  return { adapter, log };
};

const memoryStorage = (): TourStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

const makeScript = (dwellMs: number, withVoice = true): TourScript => ({
  version: 1,
  persona: 'Emily Wilson',
  stops: [
    {
      id: 'welcome',
      anchor: '#hero',
      text: 'Hello there.',
      dwellMs,
      actions: [{ type: 'emote', name: 'smile' }],
      voice: withVoice
        ? {
            src: '/a.mp3',
            durationMs: 800,
            visemes: [
              [0, 21],
              [700, 0],
            ],
          }
        : undefined,
    },
    { id: 'story', anchor: '#story', text: 'Our story.', highlight: '#story', dwellMs },
    { id: 'contact', anchor: '#contact', text: 'Write to us.', dwellMs },
  ],
});

test('start walks moving, speaking, waiting and persists the stop', async () => {
  const { being, spoken } = fakeBeing();
  const { adapter, log } = fakeAdapter();
  const storage = memoryStorage();
  const states: string[] = [];
  const script = makeScript(10_000);
  const tour = createTour({ script, being, adapter, storage, onState: (state) => states.push(state.status) });
  assert.equal(tour.state.status, 'idle');
  assert.equal(tour.state.total, 3);
  await tour.start();
  assert.deepEqual(states, ['moving', 'speaking', 'waiting']);
  assert.equal(tour.state.stop?.id, 'welcome');
  assert.equal(spoken[0]?.clip?.src, '/a.mp3');
  assert.ok(log.indexOf('scroll:#hero') < log.indexOf('dispatch:emote'));
  assert.ok(log.indexOf('dispatch:emote') < log.indexOf('caption:done:Hello there.'));
  assert.equal(JSON.parse(storage.map.get('em-tour') ?? '{}').stopId, 'welcome');
  tour.stop();
  assert.equal(tour.state.status, 'ended');
  assert.ok(storage.map.has('em-tour'), 'an early stop keeps the bookmark');
});

test('the tour advances by itself after the dwell and clears the bookmark at the end', async () => {
  const { being, spoken } = fakeBeing();
  const { adapter, log } = fakeAdapter();
  const storage = memoryStorage();
  const tour = createTour({ script: makeScript(5), being, adapter, storage });
  await tour.start();
  await until(() => tour.state.status === 'ended');
  assert.equal(spoken.length, 3);
  assert.ok(log.includes('caption:done:Write to us.'));
  assert.equal(storage.map.has('em-tour'), false);
});

test('next, back and replay move; an unknown start id means the first stop', async () => {
  const { being, spoken } = fakeBeing();
  const { adapter } = fakeAdapter();
  const tour = createTour({ script: makeScript(10_000), being, adapter, storage: memoryStorage() });
  await tour.start('nope');
  assert.equal(tour.state.index, 0);
  tour.next();
  await until(() => tour.state.index === 1 && tour.state.status === 'waiting');
  assert.equal(spoken[1]?.clip, undefined, 'the story stop has no clip');
  tour.back();
  await until(() => tour.state.index === 0 && tour.state.status === 'waiting' && spoken.length === 3);
  tour.replay();
  await until(() => spoken.length === 4 && tour.state.status === 'waiting');
  assert.equal(tour.state.index, 0);
  tour.stop();
});

test('a clip the browser refused is tried again when the visitor presses a control', async () => {
  let refuse = true;
  const spoken: SpeakRequest[] = [];
  const being: BeingHandle = {
    ...fakeBeing().being,
    speak: async (request) => {
      spoken.push(request);
      await tick();
      if (refuse && request.clip) throw new Error('NotAllowedError');
      request.onCaption?.(request.text, true);
    },
  };
  const script = makeScript(10_000);
  const tour = createTour({ script, being, adapter: fakeAdapter().adapter, storage: memoryStorage() });
  await tour.start();
  assert.equal(tour.state.captionsOnly, true, 'the refusal is reported');
  refuse = false;
  tour.replay();
  await until(() => spoken.length === 2 && tour.state.status === 'waiting');
  assert.equal(spoken[1]?.clip?.src, '/a.mp3', 'the control gives the clip another go');
  assert.equal(tour.state.captionsOnly, false);
  tour.stop();
});

test('muted and captions-only tours never pass a clip', async () => {
  const muted = fakeBeing();
  const storage = memoryStorage();
  const script = makeScript(10_000);
  const mutedTour = createTour({ script, being: muted.being, adapter: fakeAdapter().adapter, storage, muted: true });
  await mutedTour.start();
  assert.equal(muted.spoken[0]?.clip, undefined);
  assert.equal(mutedTour.state.captionsOnly, false);
  mutedTour.stop();

  const silent = fakeBeing();
  const voiceless = makeScript(10_000, false);
  const silentTour = createTour({ script: voiceless, being: silent.being, adapter: fakeAdapter().adapter, storage });
  assert.equal(silentTour.state.captionsOnly, true);
  await silentTour.start();
  assert.equal(silent.spoken[0]?.clip, undefined);
  silentTour.stop();
});

test('a being that cannot play falls back to captions only and carries on', async () => {
  const { being, spoken } = fakeBeing({ fail: true });
  const { adapter, log } = fakeAdapter();
  const tour = createTour({ script: makeScript(10_000), being, adapter, storage: memoryStorage() });
  await tour.start();
  assert.equal(tour.state.status, 'waiting');
  assert.equal(tour.state.captionsOnly, true);
  assert.ok(log.includes('caption:done:Hello there.'));
  tour.next();
  await until(() => tour.state.index === 1 && tour.state.status === 'waiting');
  assert.equal(spoken[1]?.clip, undefined);
  tour.stop();
});

test('setMuted while speaking restarts the line without the clip', async () => {
  const { being, spoken } = fakeBeing();
  const tour = createTour({
    script: makeScript(10_000),
    being,
    adapter: fakeAdapter().adapter,
    storage: memoryStorage(),
  });
  const started = tour.start();
  await until(() => tour.state.status === 'speaking');
  tour.setMuted(true);
  await started;
  await until(() => tour.state.status === 'waiting' && spoken.length === 2);
  assert.equal(spoken[1]?.clip, undefined);
  assert.equal(tour.state.muted, true);
  tour.stop();
});

test('the tour waits while the visitor is interacting', async () => {
  let interacting = true;
  const { being } = fakeBeing();
  const tour = createTour({
    script: makeScript(1),
    being,
    adapter: fakeAdapter().adapter,
    storage: memoryStorage(),
    isInteracting: () => interacting,
  });
  await tour.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(tour.state.index, 0);
  assert.equal(tour.state.status, 'waiting');
  interacting = false;
  await until(() => tour.state.index === 1);
  tour.stop();
});
