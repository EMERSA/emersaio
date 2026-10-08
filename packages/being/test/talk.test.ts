/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { ArkitStreamSource } from '../src/face/sources/ArkitStream.ts';
import { ARKIT_ORDER_61, arkit52 } from '../src/face/tables/arkit52.ts';
import { TypedIn } from '../src/speech/in/TypedIn.ts';
import { ConvaiBrain, type ConvaiClientLike, type ConvaiSdk, type TalkBeing } from '../src/talk/ConvaiBrain.ts';
import {
  isBusyError,
  parseGrant,
  TalkSession,
  type TalkSessionOptions,
  type TalkState,
  type TalkVoice,
  type TalkVoiceInit,
} from '../src/talk/TalkSession.ts';

/** @convai/web-sdk 1.8.0 dist/lipsync-helpers/arkitOrder61.js ARKIT_ORDER_61, verbatim. */
const SDK_ARKIT_ORDER_61 = [
  'EyeBlinkLeft',
  'EyeLookDownLeft',
  'EyeLookInLeft',
  'EyeLookOutLeft',
  'EyeLookUpLeft',
  'EyeSquintLeft',
  'EyeWideLeft',
  'EyeBlinkRight',
  'EyeLookDownRight',
  'EyeLookInRight',
  'EyeLookOutRight',
  'EyeLookUpRight',
  'EyeSquintRight',
  'EyeWideRight',
  'JawForward',
  'JawRight',
  'JawLeft',
  'JawOpen',
  'MouthClose',
  'MouthFunnel',
  'MouthPucker',
  'MouthRight',
  'MouthLeft',
  'MouthSmileLeft',
  'MouthSmileRight',
  'MouthFrownLeft',
  'MouthFrownRight',
  'MouthDimpleLeft',
  'MouthDimpleRight',
  'MouthStretchLeft',
  'MouthStretchRight',
  'MouthRollLower',
  'MouthRollUpper',
  'MouthShrugLower',
  'MouthShrugUpper',
  'MouthPressLeft',
  'MouthPressRight',
  'MouthLowerDownLeft',
  'MouthLowerDownRight',
  'MouthUpperUpLeft',
  'MouthUpperUpRight',
  'BrowDownLeft',
  'BrowDownRight',
  'BrowInnerUp',
  'BrowOuterUpLeft',
  'BrowOuterUpRight',
  'CheekPuff',
  'CheekSquintLeft',
  'CheekSquintRight',
  'NoseSneerLeft',
  'NoseSneerRight',
  'TongueOut',
  'HeadYaw',
  'HeadPitch',
  'HeadRoll',
  'LeftEyeYaw',
  'LeftEyePitch',
  'LeftEyeRoll',
  'RightEyeYaw',
  'RightEyePitch',
  'RightEyeRoll',
];

test('ARKIT_ORDER_61 matches the SDK slot for slot, rotations at 52-60', () => {
  assert.equal(SDK_ARKIT_ORDER_61.length, 61);
  assert.deepEqual(
    ARKIT_ORDER_61,
    SDK_ARKIT_ORDER_61.map((name) => name.charAt(0).toLowerCase() + name.slice(1)),
  );
  assert.equal(arkit52.length, 52);
  assert.equal(ARKIT_ORDER_61[52], 'headYaw');
  assert.equal(ARKIT_ORDER_61[55], 'leftEyeYaw');
  assert.equal(ARKIT_ORDER_61[60], 'rightEyeRoll');
});

test('an SDK frame drives jaw from slot 17 and head and eyes from slots 52-60', () => {
  const source = new ArkitStreamSource();
  const frame61 = new Float32Array(61);
  frame61[17] = 0.6; // JawOpen
  frame61[15] = 1; // JawRight: not a channel, must not leak into the jaw
  frame61[52] = -0.2; // HeadYaw, radians
  frame61[55] = 0.1; // LeftEyeYaw
  frame61[58] = 0.1; // RightEyeYaw
  source.push(frame61, 0);
  const frame = createFrame();
  const written = new Uint8Array(CHANNEL_COUNT);
  source.sample(10, frame, written);
  assert.ok(Math.abs((frame[CHANNEL.jawOpen] ?? 0) - 0.6) < 1e-6);
  assert.ok((frame[CHANNEL.headYaw] ?? 0) < 0, 'head turns with slot 52');
  assert.ok((frame[CHANNEL.eyesYaw] ?? 0) > 0, 'eyes follow slots 55 and 58');
});

// ---------- TalkSession ----------

const fakeBeing = () => {
  const log = { listening: [] as boolean[], levels: [] as number[], frames: 0, tokens: 0 };
  const being: TalkBeing = {
    face: {
      pushArkit: () => {
        log.frames += 1;
      },
    },
    setAudioLevel: (level) => {
      log.levels.push(level);
    },
    setListening: (on) => {
      log.listening.push(on);
    },
    tokens: (n) => {
      log.tokens += n;
    },
  };
  return { being, log };
};

const grantBody = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  provider: 'convai',
  token: 'tok-1',
  expiresAt: '2026-10-08T12:00:00Z',
  characterId: 'char-1',
  endUserId: 'eu-1',
  session: { turnsLeft: 150, maxMinutes: 20 },
  ...extra,
});

interface Call {
  url: string;
  body: unknown;
}

const fakeFetch = (answers: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = answers[url];
    return answer ? answer() : new Response(null, { status: 204 });
  }) as typeof fetch;
  return { impl, calls };
};

const json =
  (body: unknown, status = 200) =>
  (): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakeVoice implements TalkVoice {
  connected = false;
  ended = false;
  listening = false;
  sent: string[] = [];
  contexts: string[] = [];
  readonly init: TalkVoiceInit;
  private readonly fail: Error | undefined;
  private readonly micError: Error | undefined;

  constructor(init: TalkVoiceInit, fail?: Error, micError?: Error) {
    this.init = init;
    this.fail = fail;
    this.micError = micError;
  }
  async connect(): Promise<void> {
    if (this.fail) throw this.fail;
    this.connected = true;
  }
  async startListening(): Promise<void> {
    if (this.micError) throw this.micError;
    this.listening = true;
    this.init.being.setListening(true);
  }
  async stopListening(): Promise<void> {
    this.listening = false;
  }
  sendText(text: string): void {
    this.sent.push(text);
  }
  addContext(text: string): void {
    this.contexts.push(text);
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

interface Timer {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

const setup = (
  overrides: Partial<TalkSessionOptions> = {},
  answers: Record<string, () => Response> = { '/api/talk/session': json(grantBody()) },
  voiceFail?: Error,
  micError?: Error,
) => {
  const { being, log } = fakeBeing();
  const fetcher = fakeFetch(answers);
  const states: TalkState[] = [];
  const notices: string[] = [];
  const voices: FakeVoice[] = [];
  const timers: Timer[] = [];
  const session = new TalkSession({
    being,
    turnstile: 'ts-1',
    consentVersion: 1,
    fetch: fetcher.impl,
    onState: (state) => {
      states.push(state);
    },
    onNotice: (notice) => {
      notices.push(notice);
    },
    createVoice: (init) => {
      const voice = new FakeVoice(init, voices.length === 0 ? voiceFail : undefined, micError);
      voices.push(voice);
      return voice;
    },
    setTimer: (callback, ms) => {
      const timer: Timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
    ...overrides,
  });
  return { session, log, calls: fetcher.calls, states, notices, voices, timers };
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('start fetches a token with turnstile and consent, connects and arms the 20-minute cap', async () => {
  const t = setup();
  await t.session.start();
  assert.deepEqual(t.states, ['requesting', 'connecting', 'live']);
  assert.deepEqual(t.calls[0], { url: '/api/talk/session', body: { turnstile: 'ts-1', consentVersion: 1 } });
  const voice = t.voices[0];
  assert.ok(voice?.connected);
  assert.equal(voice.init.token, 'tok-1');
  assert.equal(voice.init.characterId, 'char-1');
  assert.equal(voice.init.endUserId, 'eu-1');
  assert.equal(t.timers[0]?.ms, 20 * 60_000);
});

test('the cap ends the session, ends the voice and revokes the token', async () => {
  const t = setup();
  await t.session.start();
  t.timers[0]?.callback();
  await flush();
  assert.equal(t.session.state, 'ended');
  assert.deepEqual(t.notices, ['cap']);
  assert.ok(t.voices[0]?.ended);
  assert.ok(t.calls.some((call) => call.url === '/api/talk/revoke'));
  assert.equal(t.log.listening.at(-1), false);
});

test('a busy character shows the busy notice, revokes and never goes live', async () => {
  const t = setup({}, undefined, new Error('HTTP 429: Too many concurrent sessions'));
  await t.session.start();
  assert.equal(t.session.state, 'busy');
  assert.deepEqual(t.notices, ['busy']);
  assert.ok(t.voices[0]?.ended);
  assert.ok(t.calls.some((call) => call.url === '/api/talk/revoke'));
  assert.ok(!t.states.includes('live'));
});

test('503 from the Worker is unavailable and 429 is limited, without a voice', async () => {
  const off = setup({}, { '/api/talk/session': json({ ok: false, error: 'Voice is not connected yet.' }, 503) });
  await off.session.start();
  assert.equal(off.session.state, 'unavailable');
  assert.equal(off.voices.length, 0);
  const limited = setup({}, { '/api/talk/session': json({ ok: false, error: 'Slow down.' }, 429) });
  await limited.session.start();
  assert.equal(limited.session.state, 'limited');
});

test('a dropped room reconnects once with a fresh Turnstile token and a fresh grant', async () => {
  let grants = 0;
  let refreshes = 0;
  const t = setup(
    {
      refreshTurnstile: async () => {
        refreshes += 1;
        return `ts-${refreshes + 1}`;
      },
    },
    {
      '/api/talk/session': () => {
        grants += 1;
        return json(grantBody({ token: `tok-${grants}` }))();
      },
    },
  );
  await t.session.start();
  t.voices[0]?.init.onState?.('disconnected', 'Signal connection closed');
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(t.session.state, 'live');
  assert.equal(t.voices.length, 2);
  assert.ok(t.voices[0]?.ended);
  assert.deepEqual(t.notices, ['reconnecting']);
  const sessionCalls = t.calls.filter((call) => call.url === '/api/talk/session');
  assert.equal((sessionCalls[1]?.body as { turnstile?: string } | undefined)?.turnstile, 'ts-2');
  assert.equal(t.voices[1]?.init.token, 'tok-2');
});

test('without a Turnstile refresh a dropped room ends the session', async () => {
  const t = setup();
  await t.session.start();
  t.voices[0]?.init.onState?.('disconnected');
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(t.session.state, 'ended');
  assert.deepEqual(t.notices, ['expired']);
});

test('settled lines go to /api/memory/turns, typed lines go to the voice, and end revokes', async () => {
  const t = setup();
  await t.session.start();
  const typed = new TypedIn({ clearOnSubmit: false });
  t.session.bindTyped(typed);
  typed.submit('  Hello Emily ');
  t.voices[0]?.init.onTranscript?.('being', 'Hello there', false);
  t.voices[0]?.init.onTranscript?.('being', 'Hello there.', true);
  await flush();
  assert.deepEqual(t.voices[0]?.sent, ['Hello Emily']);
  const turns = t.calls
    .filter((call) => call.url === '/api/memory/turns')
    .map((call) => {
      const { role, text } = call.body as { role: string; text: string };
      return { role, text };
    });
  assert.deepEqual(turns, [
    { role: 'user', text: 'Hello Emily' },
    { role: 'being', text: 'Hello there.' },
  ]);
  await t.session.end();
  assert.equal(t.session.state, 'ended');
  assert.ok(t.timers[0]?.cleared, 'the cap timer is cleared');
  assert.ok(t.calls.some((call) => call.url === '/api/talk/revoke'));
  assert.equal(t.session.sendText('after'), false);
});

test('a refused microphone raises mic-denied and keeps typed mode', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const t = setup({ listen: true }, undefined, undefined, denied);
  await t.session.start();
  assert.equal(t.session.state, 'live');
  assert.deepEqual(t.notices, ['mic-denied']);
  assert.ok(t.session.sendText('typed instead'));
});

test('documents become silent context, clipped', async () => {
  const t = setup();
  await t.session.start();
  t.session.addDocument('notes.md', 'x'.repeat(7000));
  const context = t.voices[0]?.contexts[0] ?? '';
  assert.ok(context.includes('notes.md'));
  assert.ok(context.length < 6200);
});

test('parseGrant rejects off-shape answers and isBusyError reads limits', () => {
  assert.equal(parseGrant({ ok: false }), undefined);
  assert.equal(parseGrant({ ...grantBody(), token: '' }), undefined);
  assert.equal(parseGrant(grantBody({ session: { turnsLeft: 3, maxMinutes: 90 } }))?.maxMinutes, 20);
  assert.ok(isBusyError(new Error('HTTP 429')));
  assert.ok(!isBusyError(new Error('HTTP 401: invalid token')));
});

// ---------- ConvaiBrain with a fake client ----------

class FakeClient implements ConvaiClientLike {
  readonly room = null;
  readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
  speaking = false;
  sent: string[] = [];
  contexts: unknown[] = [];
  connected = false;
  readonly audio = { enabled: false, muted: false };
  readonly audioControls = {
    isAudioEnabled: false,
    enableAudio: async (): Promise<void> => {
      this.audio.enabled = true;
    },
    muteAudio: async (): Promise<void> => {
      this.audio.muted = true;
    },
    unmuteAudio: async (): Promise<void> => {
      this.audio.muted = false;
    },
  };
  readonly blendshapeQueue = {
    isBotSpeaking: (): boolean => this.speaking,
    getFrameAtTime: (t: number) => ({ frame: new Float32Array(61).fill(t) }),
  };
  on(event: string, callback: (...args: never[]) => void): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
    return () => undefined;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(event) ?? []) (callback as (...a: unknown[]) => void)(...args);
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  sendUserTextMessage(text: string): void {
    this.sent.push(text);
  }
  sendInterruptMessage(): void {}
  updateContext(options: unknown): void {
    this.contexts.push(options);
  }
}

test('ConvaiBrain connects with the token, pumps ARKit frames while speaking and streams captions', async () => {
  const { being, log } = fakeBeing();
  const client = new FakeClient();
  let config: unknown;
  const sdk: ConvaiSdk = {
    createClient: (c) => {
      config = c;
      return client;
    },
    createAudioRenderer: () => ({ destroy: () => undefined }),
  };
  const frames: ((now: number) => void)[] = [];
  const captions: [string, string, boolean][] = [];
  const brain = new ConvaiBrain({
    token: 'tok',
    characterId: 'char',
    endUserId: 'eu',
    being,
    sdk,
    onTranscript: (speaker, text, final) => {
      captions.push([speaker, text, final]);
    },
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => undefined,
  });
  await brain.connect();
  assert.deepEqual(config, {
    authToken: 'tok',
    characterId: 'char',
    endUserId: 'eu',
    startWithAudioOn: false,
    enableLipsync: true,
    blendshapeConfig: { format: 'arkit' },
  });
  await brain.startListening();
  assert.ok(client.audio.enabled);
  assert.deepEqual(log.listening, [true]);

  const reply = brain.respond({ text: 'Hi', history: [], facts: [] });
  assert.deepEqual(client.sent, ['Hi']);
  frames.shift()?.(900);
  assert.equal(log.frames, 0, 'no frames while silent');
  client.speaking = true;
  client.emit('speakingChange', true);
  frames.shift()?.(1000);
  frames.shift()?.(1016);
  assert.equal(log.frames, 2);
  client.emit('messagesChange', [{ id: 'b1', type: 'bot-output', content: 'Hello' }]);
  client.emit('messagesChange', [{ id: 'b1', type: 'bot-output', content: 'Hello there.' }]);
  client.speaking = false;
  client.emit('speakingChange', false);
  const events = [];
  for await (const event of reply) events.push(event);
  assert.deepEqual(events, [
    { type: 'token', text: 'Hello' },
    { type: 'token', text: ' there.' },
    { type: 'done', reason: 'complete' },
  ]);
  assert.deepEqual(captions.at(-1), ['being', 'Hello there.', true]);
  assert.equal(log.tokens, 'Hello there.'.length);

  brain.addContext('doc');
  assert.deepEqual(client.contexts, [{ text: 'doc', mode: 'append', run_llm: 'false' }]);
  await brain.end();
  assert.equal(client.connected, false);
  assert.deepEqual(log.listening, [true, false]);
});
