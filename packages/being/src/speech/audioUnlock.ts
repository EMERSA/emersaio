/**
 * The page's audio, unlocked once inside a tap and shared by every being: one AudioContext, one <audio> element
 * for the clips (a media element can become a source node only once, so the element lives as long as the
 * context) and one analyser the data ring reads. Nothing here imports three or the rest of the runtime, so the
 * shell can call primeAudio() from the Start button long before the being arrives.
 */
type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

/** The shared output graph: the clip element through the analyser to the speakers. */
export interface AudioOutput {
  context: AudioContext;
  audio: HTMLAudioElement;
  analyser: AnalyserNode;
}

let shared: AudioContext | undefined;
let output: AudioOutput | undefined;

const findAudioContext = (): AudioContextConstructor | undefined => {
  const scope = globalThis as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext;
};

/** The page's one AudioContext, once unlock() has created it. Undefined before the first gesture. */
export const getAudioContext = (): AudioContext | undefined => shared;

export const isAudioUnlocked = (): boolean => shared?.state === 'running';

/**
 * Create the shared AudioContext and get it running. Call it synchronously inside a user gesture: the
 * construction, the resume() call and the silent buffer all happen before the first await, which is what
 * iOS Safari needs to treat the page as allowed to make sound. Resolves with the context even when the
 * browser kept it suspended (isAudioUnlocked() says which), so callers can fall back to captions.
 */
export const unlock = (): Promise<AudioContext> => {
  const AudioContextImpl = findAudioContext();
  if (AudioContextImpl === undefined) return Promise.reject(new Error('Web Audio is not available in this browser'));
  if (shared === undefined) shared = construct(AudioContextImpl);
  const context = shared;
  playSilence(context);
  const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
  return resumed.then(
    () => context,
    () => context,
  );
};

/**
 * The shared output graph, built on the first call against the shared context. Undefined before the first
 * unlock(), without Web Audio, or when the browser refuses the element source.
 */
export const getAudioOutput = (): AudioOutput | undefined => {
  if (output !== undefined) return output;
  if (shared === undefined || typeof Audio === 'undefined') return undefined;
  try {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    const source = shared.createMediaElementSource(audio);
    const analyser = shared.createAnalyser();
    source.connect(analyser);
    analyser.connect(shared.destination);
    output = { context: shared, audio, analyser };
  } catch {
    return undefined;
  }
  return output;
};

/**
 * Everything the voice needs from a tap, with no await in between: the context is created and resumed
 * (unlock) and the clip element plays once. WebKit lifts an element's gesture requirement only inside a play()
 * made under a gesture; afterwards a clip may start from a timer (the tour's dwell) or once the being has finished
 * loading, seconds after the tap. Call it as the first statement of a click or key handler. Calling it again is
 * cheap and re-resumes a context that iOS has interrupted.
 */
export const primeAudio = (): void => {
  try {
    void unlock().catch(() => undefined);
  } catch {
    return;
  }
  const graph = getAudioOutput();
  // An element that is sounding has its permission already; a play()/pause() now would only cut the clip short.
  if (graph === undefined || !graph.audio.paused) return;
  // Before the first clip there is no source: the play() is about the gesture, not the sound, and pause() settles
  // its promise.
  const played: Promise<void> | undefined = graph.audio.play();
  if (played !== undefined) played.catch(() => undefined);
  graph.audio.pause();
};

/** Older prefixed contexts reject an options object; the plain constructor is the fallback. */
const construct = (AudioContextImpl: AudioContextConstructor): AudioContext => {
  try {
    return new AudioContextImpl({ latencyHint: 'interactive' });
  } catch {
    return new AudioContextImpl();
  }
};

/** One silent sample through the graph: some browsers only count the context as unlocked after a play. */
const playSilence = (context: AudioContext): void => {
  try {
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.connect(context.destination);
    source.start(0);
  } catch {
    // A context that cannot play yet still becomes usable after resume(); nothing to do.
  }
};

/** Forget the shared context and its graph (tests, or after close()). The next unlock() creates a new one. */
export const resetAudioContext = (): void => {
  shared = undefined;
  output = undefined;
};
