/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickMimeType, transcriptOf } from '../src/speech/in/PttRecorderIn.ts';
import { TypedIn } from '../src/speech/in/TypedIn.ts';
import { createSpeechOut } from '../src/speech/index.ts';
import { pickVoice } from '../src/speech/out/BrowserTts.ts';
import { ListenerSet } from '../src/speech/SpeechIn.ts';
import type { BeingHandle, SpeakRequest } from '../src/types.ts';

const fakeBeing = () => {
  const spoken: SpeakRequest[] = [];
  let stops = 0;
  const being: BeingHandle = {
    ready: Promise.resolve(),
    speak: async (request) => {
      spoken.push(request);
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

test('ListenerSet hands back an unsubscribe and copies before emitting', () => {
  const set = new ListenerSet<[number]>();
  const seen: number[] = [];
  const off = set.add((n) => {
    seen.push(n);
    off();
  });
  set.add((n) => seen.push(n * 10));
  set.emit(1);
  set.emit(2);
  assert.deepEqual(seen, [1, 10, 20]);
  assert.equal(set.size, 1);
});

test('TypedIn submits trimmed final transcripts and ignores blanks', async () => {
  const typed = new TypedIn();
  const got: [string, boolean][] = [];
  const off = typed.onTranscript((text, final) => got.push([text, final]));
  await typed.start();
  assert.equal(typed.submit('  hello '), true);
  assert.equal(typed.submit('   '), false);
  off();
  typed.submit('ignored');
  typed.stop();
  assert.deepEqual(got, [['hello', true]]);
  assert.equal(typed.name, 'typed');
});

test('pickVoice prefers a natural British voice, then any en-GB, then English, then the default', () => {
  const sonia = { name: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', lang: 'en-GB' };
  const daniel = { name: 'Daniel', lang: 'en_GB' };
  const us = { name: 'Google US English', lang: 'en-US' };
  const fr = { name: 'Amelie', lang: 'fr-FR', default: true };
  assert.equal(pickVoice([us, daniel, sonia]), sonia);
  assert.equal(pickVoice([us, daniel]), daniel);
  assert.equal(pickVoice([fr, us]), us);
  assert.equal(pickVoice([fr]), fr);
  assert.equal(pickVoice([]), undefined);
});

test('pickMimeType and transcriptOf are strict about what they accept', () => {
  assert.equal(
    pickMimeType((type) => type === 'audio/mp4'),
    'audio/mp4',
  );
  assert.equal(
    pickMimeType(() => true),
    'audio/webm;codecs=opus',
  );
  assert.equal(
    pickMimeType(() => false),
    '',
  );
  assert.equal(transcriptOf({ text: ' hi ' }), 'hi');
  assert.equal(transcriptOf({ text: 3 }), '');
  assert.equal(transcriptOf(null), '');
});

test('speech out providers delegate to the being and the factory picks by kind', async () => {
  const { being, spoken, stops } = fakeBeing();
  const clip = { src: '/a.mp3', durationMs: 10, visemes: [] };
  const clipPlayer = createSpeechOut('clip', being);
  await clipPlayer.speak({ text: 'a', clip });
  assert.equal(spoken[0]?.clip, clip);
  const silent = createSpeechOut('silent', being);
  await silent.speak({ text: 'b', clip });
  assert.equal(spoken[1]?.clip, undefined);
  silent.stop();
  assert.equal(stops(), 1);
  const browser = createSpeechOut('browser', being);
  await browser.speak({ text: 'c', clip });
  assert.equal(spoken[2]?.text, 'c');
  assert.equal(spoken[2]?.clip, undefined, 'no synthesis here means captions only');
  assert.deepEqual([clipPlayer.name, silent.name, browser.name], ['clip', 'silent', 'browser']);
});
