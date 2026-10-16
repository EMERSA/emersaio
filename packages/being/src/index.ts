/**
 * The front door of the being runtime. createBeing() wires the stage, the avatar, the face, the rig and the data
 * visualisations together and returns the BeingHandle from types.ts, including speak() with clip playback and
 * caption timing. The kinect cloud is a chunk of its own (cloud/index.ts), fetched only for the looks that draw it,
 * and the pointer turns Emily and holds her (stage/gesture.ts, stage/orbit.ts). Nothing here knows about the page:
 * the shell owns captions, the poster and the state classes.
 */
import { Group, Matrix4, type Mesh, type Object3D } from 'three';
import { type HeadMeasure, measureHead } from './avatar/headMeasure.ts';
import { type LoadedAvatar, loadAvatar } from './avatar/loadAvatar.ts';
import { Rig } from './avatar/Rig.ts';
import { INTRO_S, introShatter, SHATTER_EASE_S, shatterGoal } from './avatar/shatter.ts';
import { createSharedUniforms, WireBeingMaterial } from './avatar/WireBeingMaterial.ts';
import { isCoarsePointer } from './capabilities.ts';
import { AudioBands } from './data/AudioBands.ts';
import { DataFan } from './data/DataFan.ts';
import type { DepthSource } from './data/depth/DepthSource.ts';
import { FAN_LINES, FAN_PLANE_M } from './data/fanMath.ts';
import { scatterFor } from './data/scatter.ts';
import { TokenMeter } from './data/TokenMeter.ts';
import { FaceDriver, hasArkitMorphs } from './face/FaceDriver.ts';
import type { FaceSource } from './face/source.ts';
import type { ArkitStreamSource } from './face/sources/ArkitStream.ts';
import { IdleSource } from './face/sources/Idle.ts';
import { TextVisemesSource } from './face/sources/TextVisemes.ts';
import { VisemeTimelineSource } from './face/sources/VisemeTimeline.ts';
import { getAudioOutput, unlock } from './speech/audioUnlock.ts';
import { RIM_HEIGHT_M, RIM_RADIUS_SHARE, RIM_RIGHT_SHARE } from './stage/Backdrop.ts';
import { bustBounds, type HeadBounds } from './stage/framing.ts';
import { type GestureEvent, GestureTracker, HOLD_MS } from './stage/gesture.ts';
import { Orbit, RETURN_AFTER_S, RETURN_TALKING_S } from './stage/orbit.ts';
import {
  bustGrid,
  CLOUD_GRIDS,
  type QualityCaps,
  QualityMonitor,
  qualityProfile,
  startingQuality,
} from './stage/Quality.ts';
import { ORBIT_PITCH_DEG, ORBIT_YAW_DEG, PARALLAX_PITCH_DEG, PARALLAX_YAW_DEG, Stage } from './stage/Stage.ts';
import { ThemeUniforms } from './stage/ThemeUniforms.ts';
import type {
  BeingHandle,
  BeingHoldDetail,
  BeingOptions,
  FramingMode,
  KinectMode,
  Look,
  LookRequest,
  Quality,
  SpeakRequest,
  Theme,
  TourAction,
  VoiceClip,
} from './types.ts';

export { type Capabilities, detectCapabilities } from './capabilities.ts';
// The depth sources and their maths are values of the '@emersa/being/depth' subpath and of the cloud chunk alone,
// so this core carries none of them; their types are free.
export type {
  BeingDepthSourceOptions,
  CloudGrid,
  DepthClipping,
  DepthEncoding,
  DepthSource,
  DepthSourceKind,
  FovTangents,
  KinectronClient,
  KinectronClientConfig,
  KinectronConstructor,
  KinectronDepthSourceOptions,
  KinectronFeed,
  KinectronImageFrame,
  KinectronKinectType,
  KinectronRawDepthFrame,
  KinectronRawDepthPayload,
  SensorKind,
  VideoDepthSourceOptions,
} from './data/depth/index.ts';
export { DEFAULT_FAN_TARGETS, FAN_NODE_SHARES, FAN_PLANE_M } from './data/fanMath.ts';
export type { KinectCloudOptions } from './data/KinectCloud.ts';
export { FACE_CHIN_AIR, FACE_CROWN_AIR, FACE_PORTRAIT_SHARE, faceLayoutT } from './stage/framing.ts';
export type * from './types.ts';

type Postprocessing = typeof import('./stage/postprocessing.ts');
type Extras = typeof import('./data/extras.ts');
type DataRing = InstanceType<Extras['DataRing']>;
type Ribbon = InstanceType<Extras['Ribbon']>;
type FloorReflection = InstanceType<Extras['FloorReflection']>;
type CloudModule = typeof import('./cloud/index.ts');
type CloudLayer = InstanceType<CloudModule['CloudLayer']>;
type SculptureModule = typeof import('./sculpture/index.ts');
type SculptureLayer = InstanceType<SculptureModule['SculptureLayer']>;

/** The sculpture's intro: the pieces flow onto her over this time. */
const SCULPT_INTRO_S = 2.6;
/** A sculpture shard's target edge in device pixels (touch a little coarser), and the most shards per tier. */
const SCULPT_PX = { fine: 2.0, touch: 2.4 } as const;
const SCULPT_CAP: Readonly<Record<string, number>> = { full: 350_000, balanced: 220_000, lite: 110_000 };

/** Captions-only speech reveals this many characters per second; the text-timed mouth follows the same clock. */
const TYPEWRITER_CPS = 14;
/** Time for the mouth to settle after the last caption character. */
const SPEECH_TAIL_MS = 350;
const CAPTION_TICK_MS = 33;
/** A clip that has not started (or has frozen) by then hands over to captions-only timing. */
const STALL_MS = 4000;
const FADE_IN_S = 0.6;
const IDLE_FPS_TOUCH = 30;
/** The cloud's scatter eases towards the token meter over this time, so a burst swells rather than snaps. */
const SCATTER_EASE_S = 0.25;
/** The dev harness's face plinth sits this far under the lowest head vertex, and its disc is this wide. */
const PLINTH_DROP_M = 0.06;
const PLINTH_RADIUS_M = 0.3;
/**
 * The face look's ribbon: this far from the axis, from the chin down to this far below the plinth, in this many
 * turns, with a tube this thick. The camera is four times closer than to the figure, so the swirl keeps the
 * figure ribbon's proportions to the canvas rather than its metres: wider or thicker, it reads as bands across
 * the canvas rather than as the swirl around the bottle.
 */
const FACE_RIBBON_RADIUS_M = 0.16;
const FACE_RIBBON_DROP_M = 0.25;
const FACE_RIBBON_TURNS = 1.5;
const FACE_RIBBON_TUBE_M = 0.006;
/** The figure looks' rim light: behind the chest, 0.8 m across. */
const FIGURE_RIM_Z = -0.6;
const FIGURE_RIM_DIAMETER_M = 1.6;
/**
 * A conversation counts as on while the microphone is open, while a phone frames her as a portrait, or for this long
 * after the last frame of her live face: a turned Emily then comes back to the visitor sooner (stage/orbit.ts).
 */
const TALK_RECENT_MS = 30000;
/**
 * Bloom for the face look: a head this large and bright hazes the whole canvas at the figure's radius, up to its
 * corners, which must stay the page's colour. Radius 0 keeps the tight glow and drops the wide mips to a third;
 * the strength comes down to half with it.
 */
const FACE_BLOOM_RADIUS = 0;
const FACE_BLOOM_SCALE = 0.5;
/** How far the data fan flows while a line plays, before the token meter and the shell add their own. */
const SPEAKING_FLOW = 0.6;

/** The output chain the clips play through: the page's shared <audio>, media source and analyser (audioUnlock.ts). */
class ClipOutput {
  audio: HTMLAudioElement | null = null;
  analyser: AnalyserNode | null = null;

  /**
   * Adopt the shared graph, creating it when nothing has primed it yet. Inside a gesture this is the unlock
   * itself; outside one it still resumes a context that primeAudio() unlocked earlier or that iOS interrupted.
   */
  unlock(): void {
    try {
      void unlock().catch(() => undefined);
    } catch {
      // No Web Audio: speech falls back to captions-only timing.
      return;
    }
    const graph = getAudioOutput();
    if (!graph) return;
    this.audio = graph.audio;
    this.analyser = graph.analyser;
  }

  /** Let go of the shared graph without closing it: it belongs to the page, and the next being adopts it again. */
  dispose(): void {
    this.audio?.pause();
    this.audio = null;
    this.analyser = null;
  }
}

interface WordCue {
  /** Character index just past the word. */
  end: number;
  /** Milliseconds from clip start at which the word shows. */
  at: number;
}

/** Reveal times per word, proportional to character position across the voiced span of the timeline. */
function wordCues(text: string, clip: VoiceClip): WordCue[] {
  const voiced = clip.visemes.filter((cue) => cue[1] !== 0);
  const first = voiced[0]?.[0] ?? 0;
  const lastOffset = clip.visemes[clip.visemes.length - 1]?.[0];
  let last = lastOffset === undefined ? clip.durationMs : Math.min(clip.durationMs, lastOffset + 150);
  if (last <= first) last = Math.max(first + 1, clip.durationMs);
  const total = Math.max(1, text.length);
  const cues: WordCue[] = [];
  for (const match of text.matchAll(/\S+\s*/g)) {
    const start = match.index ?? 0;
    cues.push({ end: start + match[0].length, at: first + (start / total) * (last - first) });
  }
  return cues;
}

interface SpeechDeps {
  output: ClipOutput;
  bands: AudioBands;
  tokens: TokenMeter;
  face: () => FaceDriver | null;
  onStart: () => void;
  onEnd: () => void;
}

/** The autoplay policy said no: play() was called with no gesture behind it, or iOS has interrupted the context. */
const isNotAllowed = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError';

/** One spoken line: a clip with its viseme timeline and word-synced captions, or a typewriter with a text mouth. */
class SpeechRun {
  private done = false;
  private textMode = false;
  private audioStarted = false;
  private shown = 0;
  private next = 0;
  private cues: WordCue[] = [];
  private durationMs = 0;
  private startedAt = 0;
  private lastClock = -1;
  private stalledFor = 0;
  private timer = 0;
  /** The mouth source for this line; it joins the face as soon as there is one. */
  private wanted: FaceSource | null = null;
  private attached = false;
  private audio: HTMLAudioElement | null = null;

  private readonly onAbort = (): void => this.finish(false);
  private readonly onEnded = (): void => this.finish(true);
  private readonly onAudioError = (): void => this.fallbackToText();

  private readonly tick = (): void => {
    if (this.done) return;
    this.attachSource();
    const text = this.request.text;
    if (this.textMode) {
      const elapsed = performance.now() - this.startedAt;
      this.reveal(Math.min(text.length, Math.floor((elapsed / 1000) * TYPEWRITER_CPS)));
      if (elapsed >= this.durationMs + SPEECH_TAIL_MS) this.finish(true);
      return;
    }
    const t = this.clock();
    if (!this.audioStarted || t === this.lastClock) {
      this.stalledFor += CAPTION_TICK_MS;
      if (this.stalledFor >= STALL_MS) {
        if (this.audioStarted) this.finish(true);
        else this.fallbackToText();
        return;
      }
    } else {
      this.stalledFor = 0;
    }
    this.lastClock = t;
    let end = this.shown;
    while (this.next < this.cues.length && (this.cues[this.next]?.at ?? Number.POSITIVE_INFINITY) <= t) {
      end = this.cues[this.next]?.end ?? end;
      this.next += 1;
    }
    this.reveal(end);
    if (t >= this.durationMs + SPEECH_TAIL_MS) this.finish(true);
  };

  constructor(
    private readonly deps: SpeechDeps,
    private readonly request: SpeakRequest,
    private readonly resolve: () => void,
    private readonly reject: (error: unknown) => void,
  ) {}

  start(): void {
    this.request.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.deps.onStart();
    const clip = this.request.clip;
    const audio = this.deps.output.audio;
    if (clip && audio) this.startClip(clip, audio);
    else this.startText();
    this.timer = window.setInterval(this.tick, CAPTION_TICK_MS);
  }

  stop(): void {
    this.finish(false);
  }

  private clock(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  private startClip(clip: VoiceClip, audio: HTMLAudioElement): void {
    this.audio = audio;
    this.cues = wordCues(this.request.text, clip);
    this.durationMs = clip.durationMs;
    this.wantSource(new VisemeTimelineSource(clip.visemes, () => this.clock(), clip.durationMs));
    audio.addEventListener('ended', this.onEnded, { once: true });
    audio.addEventListener('error', this.onAudioError, { once: true });
    audio.src = clip.src;
    audio.play().then(
      () => {
        if (this.done || this.textMode) return;
        this.audioStarted = true;
        this.deps.bands.attach(this.deps.output.analyser);
      },
      (error: unknown) => this.refuse(error),
    );
  }

  private startText(): void {
    this.textMode = true;
    const text = this.request.text;
    // Continue from whatever a failed clip already showed instead of jumping back to the first word.
    this.startedAt = performance.now() - (this.shown / TYPEWRITER_CPS) * 1000;
    this.durationMs = (text.length / TYPEWRITER_CPS) * 1000;
    this.wantSource(new TextVisemesSource(text, this.durationMs, this.startedAt));
  }

  private fallbackToText(): void {
    if (this.done || this.textMode) return;
    this.releaseAudio();
    this.removeSource();
    this.startText();
  }

  /**
   * play() was turned down. The autoplay policy would refuse every later clip as well, so the line fails and the
   * tour can switch to captions and say so. Anything else (a clip that will not load) is this line's problem
   * alone: the captions carry on by themselves.
   */
  private refuse(error: unknown): void {
    if (this.done || this.textMode) return;
    if (!isNotAllowed(error)) {
      this.fallbackToText();
      return;
    }
    this.teardown();
    this.deps.onEnd();
    this.reject(error);
  }

  private wantSource(source: FaceSource): void {
    this.removeSource();
    this.wanted = source;
    this.attachSource();
  }

  /** The avatar may still be loading when a line starts; the source waits for the face and then joins it. */
  private attachSource(): void {
    if (!this.wanted || this.attached) return;
    const face = this.deps.face();
    if (!face) return;
    face.add(this.wanted);
    this.attached = true;
  }

  private removeSource(): void {
    if (this.wanted && this.attached) this.deps.face()?.remove(this.wanted);
    this.wanted = null;
    this.attached = false;
  }

  private releaseAudio(): void {
    const audio = this.audio;
    if (!audio) return;
    audio.removeEventListener('ended', this.onEnded);
    audio.removeEventListener('error', this.onAudioError);
    audio.pause();
    this.deps.bands.attach(null);
    this.audio = null;
  }

  private reveal(chars: number): void {
    if (chars <= this.shown) return;
    this.deps.tokens.tokens(chars - this.shown);
    this.shown = chars;
    this.request.onCaption?.(this.request.text.slice(0, chars), false);
  }

  private teardown(): void {
    this.done = true;
    window.clearInterval(this.timer);
    this.request.signal?.removeEventListener('abort', this.onAbort);
    this.releaseAudio();
    this.removeSource();
  }

  private finish(complete: boolean): void {
    if (this.done) return;
    this.teardown();
    const text = this.request.text;
    if (complete && this.shown < text.length) {
      this.deps.tokens.tokens(text.length - this.shown);
      this.shown = text.length;
    }
    this.request.onCaption?.(text.slice(0, this.shown), true);
    this.deps.onEnd();
    this.resolve();
  }
}

function disposeAvatar(avatar: LoadedAvatar): void {
  avatar.root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.userData.sourceGeometry as Mesh['geometry'] | undefined)?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material.dispose();
  });
}

/** Whether the main camera draws a mesh. Off layer 0 a mesh can still cast the cloud from the depth layer. */
function showWire(mesh: Mesh, on: boolean): void {
  if (on) mesh.layers.enable(0);
  else mesh.layers.disable(0);
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const clampUnit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0);

/** The shared contract's 'kinect-face' is the face look. */
const normaliseLook = (look: LookRequest | undefined): Look => (look === 'kinect-face' ? 'face' : (look ?? 'hybrid'));

/** Every look but the wire draws the kinect cloud, whose code is the cloud chunk. */
const drawsCloud = (look: Look): boolean => look !== 'wire' && look !== 'sculpture';

export function createBeing(options: BeingOptions): BeingHandle {
  const canvas = options.canvas;
  const touch = isCoarsePointer();
  const reducedMotion = options.reducedMotion === true;
  const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const caps: QualityCaps = {
    bloom: options.bloom === true,
    ribbon: options.ribbon !== false,
    // Touch devices start at balanced with the reflection off; an explicit option can still ask for it.
    reflection: options.reflection ?? !touch,
    maxPixelRatio: Math.min(options.maxPixelRatio ?? (touch ? 1.5 : 2), devicePixelRatio),
  };
  const wantRing = options.ring !== false;
  const startQuality = startingQuality(options.quality ?? 'full', touch);
  let look: Look = normaliseLook(options.look);
  let profile = qualityProfile(startQuality, caps);
  const intro = options.intro !== false && !reducedMotion;

  const theme = new ThemeUniforms(options.theme);
  const shared = createSharedUniforms(theme);
  const stage = new Stage({
    canvas,
    // MSAA only pays off when the scene draws straight to the canvas; the composer's target has no samples.
    antialias: !touch && !caps.bloom,
    bloomStrength: theme.bloom,
    pixelRatio: caps.maxPixelRatio,
    idleFps: touch ? IDLE_FPS_TOUCH : 0,
    backdrop:
      options.backdrop === 'none'
        ? undefined
        : {
            uniforms: { uRim: theme.uRim, uIsLight: theme.uIsLight, uOpacity: shared.uOpacity },
            blending: theme.blending(),
          },
    reducedMotion,
    onContextLost: options.onContextLost,
  });
  stage.setLightOutput(options.theme === 'light');
  if (stage.backdrop) for (const material of stage.backdrop.materials) theme.register(material);
  // The bloom passes are a chunk of their own that is requested only when bloom is on; it travels alongside the
  // avatar. The same goes for the ring, the ribbon and the reflection (data/extras.ts): the home page asks for none
  // of them, so none of that code is loaded there.
  const postprocessing: Promise<Postprocessing | null> = caps.bloom
    ? import('./stage/postprocessing.ts').catch(() => null)
    : Promise.resolve(null);
  const extrasLoading: Promise<Extras | null> =
    wantRing || caps.ribbon || caps.reflection ? import('./data/extras.ts').catch(() => null) : Promise.resolve(null);
  const tokenMeter = new TokenMeter();
  const bands = new AudioBands();
  let ring: DataRing | null = null;
  let ribbon: Ribbon | null = null;
  let floor: FloorReflection | null = null;

  // The kinect cloud (cloud/index.ts) and where it reads depth from: the being's own depth pass, rendered from a
  // fixed sensor camera at 30 Hz, unless a sensor or a video is given. Its chunk is fetched for the looks that draw
  // it; until it arrives its knobs wait in line, the latest call of each.
  let external: DepthSource | null = options.depthSource ?? null;
  let layer: CloudLayer | null = null;
  /** The layer as it is now, for code the compiler would otherwise read as running before it can arrive. */
  const currentLayer = (): CloudLayer | null => layer;
  let layerLoading: Promise<CloudLayer | null> | null = null;
  const pendingKnobs = new Map<string, (target: CloudLayer) => void>();
  // The sculpture (sculpture/index.ts), its own chunk, fetched for the look that draws it.
  let sculpt: SculptureLayer | null = null;
  let sculptLoading: Promise<SculptureLayer | null> | null = null;
  const stirLast = { x: 0, y: 0, t: 0 };
  /** The cloud's mode as the page set it, reported until the layer can say so itself. */
  let chosenMode: KinectMode | null = null;
  const fan = new DataFan(shared, theme.blending(), { reducedMotion, pixelRatio: caps.maxPixelRatio });
  theme.register(fan.lineMaterial);
  theme.register(fan.nodeMaterial);
  stage.scene.add(fan.lines, fan.nodes);
  const output = new ClipOutput();

  let avatar: LoadedAvatar | null = null;
  let face: FaceDriver | null = null;
  let rig: Rig | null = null;
  const materials: WireBeingMaterial[] = [];
  let loaded = false;
  let disposed = false;
  let speaking = false;
  let listening = false;
  let renderAllowed = true;
  let externalLevel = 0;
  let fade = reducedMotion ? 1 : 0;
  let small = stage.isSmall();
  let scatter = 0;
  let run: SpeechRun | null = null;
  /** The extras' figure profiles, filled in when their module arrives (they are only read once it has). */
  let FIGURE_RIBBON_PROFILE: Parameters<Ribbon['setProfile']>[0] = { radius: 0.45, from: 0.5, to: 1.4, turns: 2 };
  let FLOOR_RADIUS = 0.7;
  const pendingLook = { x: 0, y: 0, set: false };
  const pendingActions: TourAction[] = [];
  /** The look in force: what was asked for, unless the docked stage or the tier reduce it to the wire. */
  let effective: Look = 'wire';
  /** The head as measured once in the bind pose: the face framing, the sensor, the keep zones and the fan's starts. */
  let head: HeadMeasure | null = null;
  /** The head-and-shoulders crop under it (the kinect-demo look). */
  let headBust: HeadBounds | null = null;
  let headBone: Object3D | null = null;
  /** The head bone's bind pose, inverted: the keep zones follow the bone's movement since then. */
  const headBind = new Matrix4();
  /** The pieces: the amount drawn, the shell's last value and when it came, and when the intro began (stage time). */
  let shatter = 0;
  let shatterManual = 0;
  let shatterManualAt = Number.NEGATIVE_INFINITY;
  let introAt: number | null = null;
  /** The kinect-demo look's wire head (off unless asked for). */
  let demoHeadWire = options.headWire === true;
  /** The framing the page asked for (setFraming): the hero's bust, or a phone conversation's portrait. */
  let framingMode: FramingMode = 'bust';
  /** When the live face last pushed a frame (performance.now), for the conversation's shorter return. */
  let arkitAt = Number.NEGATIVE_INFINITY;

  // Turning by hand: the avatar hangs from a turntable that turns about the head's vertical axis, so the kinect
  // looks' fixed sensor sees the turned mesh; the drag's tilt is the camera's elevation (Stage.setElevation).
  const turntable = new Group();
  turntable.name = 'Turntable';
  const orbit = new Orbit({ reducedMotion });

  const placeTurntable = (): void => {
    const yaw = orbit.yaw;
    const pivotZ = head?.bounds.centreZ ?? 0;
    turntable.rotation.y = yaw;
    // About (0, y, pivotZ) rather than the origin: the head turns where it stands instead of swinging round.
    turntable.position.set(-pivotZ * Math.sin(yaw), 0, pivotZ - pivotZ * Math.cos(yaw));
    stage.setElevation(orbit.pitchDeg());
  };

  /** The floor's mirrored draw of the cloud, once both are there. */
  const mirrorCloud = (target: FloorReflection, cloud: CloudLayer): void => {
    target.mirror(cloud.cloud.points, cloud.cloud.material);
    target.mirror(cloud.cloud.mesh, cloud.cloud.gridMaterial);
  };

  /** Fetch the cloud chunk once and build the layer; it joins the scene as soon as it is built. */
  const loadLayer = (): Promise<CloudLayer | null> => {
    layerLoading ??= import('./cloud/index.ts').then((module) => {
      if (disposed) return null;
      const grid = profile.cloud ?? CLOUD_GRIDS.reduced;
      const next = new module.CloudLayer({
        renderer: stage.renderer,
        scene: stage.scene,
        shared,
        blending: theme.blending(),
        grid,
        pixelRatio: stage.getPixelRatio(),
        reducedMotion,
      });
      // The grid material follows the theme's blending in wire mode and blends normally as a solid mesh (KinectCloud).
      theme.register(next.cloud.material);
      for (const apply of pendingKnobs.values()) apply(next);
      pendingKnobs.clear();
      if (head) next.setHead(head.bounds, headBone, headBind);
      if (floor) mirrorCloud(floor, next);
      layer = next;
      applyScene();
      return next;
    });
    return layerLoading;
  };

  /** Fetch the sculpture chunk once; it builds as soon as both it and the avatar are there. */
  const loadSculpture = (): Promise<SculptureLayer | null> => {
    sculptLoading ??= import('./sculpture/index.ts').then((module) => {
      if (disposed) return null;
      const next = new module.SculptureLayer({
        scene: stage.scene,
        shared,
        blending: theme.blending(),
        reducedMotion,
        register: (material) => theme.register(material),
      });
      sculpt = next;
      buildSculpture();
      applyScene();
      return next;
    });
    return sculptLoading;
  };

  /** Build the sculpture from the avatar once both have arrived. */
  const buildSculpture = (): void => {
    const target = sculpt;
    if (!target || !avatar || !head || target.built()) return;
    target.build({ head: avatar.head, body: avatar.body, eyeL: avatar.bones.eyeL, eyeR: avatar.bones.eyeR });
    target.setSubject(0, (head.bounds.minY + head.bounds.maxY) / 2, head.bounds.centreZ, headBust?.minY ?? 1.25);
  };

  /** A knob of the cloud: applied at once when the layer is there, otherwise when it arrives. */
  const knob = (name: string, apply: (target: CloudLayer) => void): void => {
    if (layer) apply(layer);
    else pendingKnobs.set(name, apply);
  };

  /**
   * Put every part of the figure where the look, the tier and the canvas want it. Layers decide what the main
   * camera draws and what only the depth pass sees: a mesh the cloud stands in for leaves layer 0 and casts the
   * cloud from the depth layer; in the face look the head does both, wire over its own cloud, and the body leaves
   * both. The docked tour panel is too small for a cloud of dots the size of the figure, so it shows the wire
   * whatever the look says and keeps the extras out of the face.
   */
  const applyScene = (): void => {
    effective = small || profile.cloud === null ? 'wire' : look;
    const isFace = effective === 'face';
    // The kinect-demo look: head and shoulders as tiny shards from a fixed sensor, no wire unless asked for.
    const isDemo = effective === 'kinect-demo';
    // The sculpture: the complete head and bust as tiny triangles on her surface, framed like the bust.
    const isSculpt = effective === 'sculpture';
    const headLook = isFace || isDemo;
    const casters: Mesh[] = [];
    if (avatar) {
      const headWire = isDemo ? demoHeadWire : effective !== 'kinect';
      const bodyWire = effective === 'wire';
      showWire(avatar.head, headWire);
      if (!headWire || isFace || isDemo) casters.push(avatar.head);
      if (avatar.body) {
        showWire(avatar.body, bodyWire);
        if (!bodyWire && !isFace) casters.push(avatar.body);
      }
    }
    const bustLook = isDemo || isSculpt;
    stage.setOrbit(
      bustLook ? ORBIT_YAW_DEG : PARALLAX_YAW_DEG,
      bustLook ? ORBIT_PITCH_DEG : PARALLAX_PITCH_DEG,
      bustLook && !reducedMotion,
    );
    const headBounds = (headLook || isSculpt) && head ? head.bounds : null;
    // One object per head: the stage compares bounds by identity, and its layout calls back into this function.
    const bust = bustLook && headBounds ? headBust : null;
    if (sculpt) {
      if (isSculpt && avatar) {
        showWire(avatar.head, true);
        if (avatar.body) showWire(avatar.body, true);
      }
      sculpt.setActive(isSculpt && avatar !== null);
      // A shard about SCULPT_PX device pixels across at the stage's scale, within the tier's cap.
      const frameM = stage.frameSize().height;
      const pxPerM = frameM > 0 ? (stage.size().height / frameM) * stage.getPixelRatio() : 1000;
      sculpt.setDensity(
        (touch ? SCULPT_PX.touch : SCULPT_PX.fine) / pxPerM,
        SCULPT_CAP[monitor?.current() ?? 'full'] ?? 450_000,
      );
    }
    const bounds = bust ?? headBounds;
    if (layer) {
      // The bust lattice follows the sensor frame's size on screen, so a shard stays a couple of pixels across
      // however large the hero is (touch devices at most bustTouch).
      const ceiling =
        touch && profile.bustCloud && profile.bustCloud.rows > CLOUD_GRIDS.bustTouch.rows
          ? CLOUD_GRIDS.bustTouch
          : profile.bustCloud;
      const frameM = stage.frameSize().height;
      const framePx = frameM > 0 ? (stage.size().height / frameM) * layer.bustFrameM : 0;
      const demoGrid = ceiling ? bustGrid(framePx, ceiling) : null;
      const grid = (isDemo ? demoGrid : isFace ? profile.headCloud : profile.cloud) ?? CLOUD_GRIDS.reduced;
      layer.apply({ look: effective, casters, external, grid, head: headBounds, bust });
    }
    // The dev harness's product-shot extras follow the head in the face look: the ribbon swirls under the chin
    // and the glossy plinth and its reflection sit just under the lowest head vertex.
    const plinth = bounds ? bounds.minY - PLINTH_DROP_M : 0;
    if (ribbon) {
      ribbon.setEnabled(profile.ribbon && !small);
      ribbon.setProfile(
        bounds
          ? {
              radius: FACE_RIBBON_RADIUS_M,
              from: plinth - FACE_RIBBON_DROP_M,
              to: bounds.minY,
              turns: FACE_RIBBON_TURNS,
              tube: FACE_RIBBON_TUBE_M,
            }
          : FIGURE_RIBBON_PROFILE,
      );
    }
    if (floor) {
      floor.setEnabled(profile.reflection && !small);
      floor.setFloor(profile.rim && !small);
      floor.setPlane(plinth, bounds ? PLINTH_RADIUS_M : FLOOR_RADIUS);
    }
    stage.setFaceBounds(bounds, bust !== null);
    // The one rim light: behind the head, 8 percent of the frame to its right, its radius 0.75 of the head's
    // height (the brief); behind the chest for the figure looks.
    stage.backdrop?.setEnabled(profile.rim);
    if (headBounds) {
      const headHeight = headBounds.maxY - headBounds.minY;
      stage.backdrop?.setFocus(
        RIM_RIGHT_SHARE * stage.frameSize().width,
        (headBounds.minY + headBounds.maxY) / 2,
        headBounds.centreZ,
        2 * RIM_RADIUS_SHARE * headHeight,
      );
    } else {
      stage.backdrop?.setFocus(0, RIM_HEIGHT_M, FIGURE_RIM_Z, FIGURE_RIM_DIAMETER_M);
    }
    stage.setBloom(profile.bloom, headLook ? FACE_BLOOM_RADIUS : profile.bloomRadius);
    stage.setBloomScale(headLook ? FACE_BLOOM_SCALE : 1);
    // The fan belongs to the face look on fine-pointer desktops: never on touch devices, never in the lite tier.
    fan.setAllowed(headLook && profile.fan && !small && !touch);
  };

  const applyQuality = (quality: Quality): void => {
    profile = qualityProfile(quality, caps);
    stage.setPixelRatio(profile.pixelRatio);
    stage.setBloom(profile.bloom, profile.bloomRadius);
    ring?.setHalf(profile.halfPoints);
    ring?.setPixelRatio(stage.getPixelRatio());
    layer?.setPixelRatio(stage.getPixelRatio());
    fan.setPixelRatio(stage.getPixelRatio());
    renderAllowed = profile.render;
    applyScene();
    if (loaded) {
      if (renderAllowed) stage.start();
      else stage.stop();
    }
    // The shell swaps in the poster on 'poster'; the HUD reads stats().quality.
    canvas.dispatchEvent(new CustomEvent<Quality>('em:quality', { detail: quality, bubbles: true }));
  };

  const monitor = new QualityMonitor(startQuality, applyQuality);
  applyQuality(monitor.current());
  // The rim light sits a share of the frame's width to the right of the head, so a resize places it again.
  stage.onLayout(() => {
    if (head && (effective === 'face' || effective === 'kinect-demo' || effective === 'sculpture')) applyScene();
  });
  const sculptAtStart: Promise<SculptureLayer | null> = look === 'sculpture' ? loadSculpture() : Promise.resolve(null);
  // The look asked for draws the cloud: its chunk is on its way now, beside the avatar's.
  const layerAtStart: Promise<CloudLayer | null> = drawsCloud(look) ? loadLayer() : Promise.resolve(null);

  /* Gestures ------------------------------------------------------------------------------------------------ */

  /** The canvas's width when the press began: a drag across all of it is one full turn. */
  let gestureWidth = 1;
  let captured: number | null = null;
  let holdTimer = 0;
  let lastPointerType = 'mouse';

  /**
   * The press is the canvas's from the moment it lands: a drag or a hold that strays over the hero's copy, or off the
   * window, still ends here (and a hold is never left open by a release the canvas did not see).
   */
  const capturePointer = (id: number): void => {
    try {
      canvas.setPointerCapture(id);
      captured = id;
    } catch {
      // The pointer is already gone; its release or cancel still ends the gesture.
    }
  };
  const releasePointer = (): void => {
    const id = captured;
    captured = null;
    if (id === null) return;
    try {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    } catch {
      // Released already.
    }
  };
  /** Talk listens on the stage: a hold on Emily opens the microphone, its end closes it. */
  const announceHold = (active: boolean): void => {
    canvas.dispatchEvent(new CustomEvent<BeingHoldDetail>('em:being-hold', { detail: { active }, bubbles: true }));
  };

  const onGesture = (event: GestureEvent): void => {
    switch (event.type) {
      case 'drag-start':
        orbit.grab();
        break;
      case 'drag':
        orbit.drag(event.dx, event.dy, gestureWidth);
        break;
      case 'drag-end':
        // A cancelled drag was the start of a page scroll on touch (or a pinch): she goes back to where it found her.
        if (event.cancelled) orbit.cancel();
        else orbit.release(event.vx, event.vy, gestureWidth);
        break;
      case 'hold-start':
        announceHold(true);
        break;
      case 'hold-end':
        announceHold(false);
        break;
      default:
        // A hover and a tap belong to the page (being-mount.ts looks and loads with them).
        break;
    }
  };
  const gestures = new GestureTracker(onGesture);

  /** The pointer in CSS pixels within the canvas, and the event's time on the performance clock. */
  const pointAt = (event: PointerEvent): { x: number; y: number; t: number; width: number } => {
    const box = canvas.getBoundingClientRect();
    const t = event.timeStamp > 0 ? event.timeStamp : performance.now();
    return { x: event.clientX - box.left, y: event.clientY - box.top, t, width: box.width };
  };
  const onPointerDown = (event: PointerEvent): void => {
    lastPointerType = event.pointerType;
    if (!loaded || disposed || !avatar) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const p = pointAt(event);
    if (!gestures.pressing()) gestureWidth = Math.max(1, p.width);
    gestures.down(event.pointerId, p.x, p.y, p.t);
    if (gestures.pointerId() === event.pointerId) capturePointer(event.pointerId);
    // A press may become a drag on its next event: the loop leaves the idle cap at once rather than a frame later.
    stage.setBusy(true);
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => gestures.tick(performance.now()), HOLD_MS + 10);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!gestures.pressing()) return;
    const p = pointAt(event);
    gestures.move(event.pointerId, p.x, p.y, p.t);
  };
  const onPointerUp = (event: PointerEvent): void => {
    const p = pointAt(event);
    gestures.up(event.pointerId, p.x, p.y, p.t);
    if (!gestures.pressing()) window.clearTimeout(holdTimer);
  };
  // The browser took the pointer over (a vertical scroll on touch, a pinch) or the capture went away: whatever the
  // press was doing ends, a drag without coasting.
  const onPointerCancel = (event: PointerEvent): void => {
    gestures.cancel(event.pointerId);
    if (!gestures.pressing()) window.clearTimeout(holdTimer);
  };
  // A long press is a hold, never the browser's menu: on touch always, and with a mouse while a hold is on.
  const onContextMenu = (event: Event): void => {
    if (gestures.holding() || lastPointerType === 'touch' || lastPointerType === 'pen') event.preventDefault();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('contextmenu', onContextMenu);

  stage.onFrame((dt, elapsed) => {
    const now = performance.now();
    tokenMeter.update(now);
    bands.update(dt);
    rig?.update(dt);
    face?.update(now, dt);
    // Under reduced motion every shader clock stands still: no shimmer, no swell, no scan drift, no dust.
    shared.uTime.value = reducedMotion ? 0 : elapsed;
    stage.renderer.getDrawingBufferSize(shared.uViewport.value);
    const tokenRate = reducedMotion ? 0 : tokenMeter.normalized();
    const tokenPulse = reducedMotion ? 0 : tokenMeter.pulse();
    shared.uTokenRate.value = tokenRate;
    shared.uTokenPulse.value = tokenPulse;
    shared.uAudioLevel.value = Math.max(bands.level(), externalLevel, face?.energy() ?? 0);
    if (fade < 1) fade = Math.min(1, fade + dt / FADE_IN_S);
    shared.uOpacity.value = fade;
    const isSmall = stage.isSmall();
    if (isSmall !== small) {
      small = isSmall;
      applyScene();
    }
    // The pieces: the intro assembles the head once the being shows; from then on the shell's value holds for two
    // seconds after it was set and the token meter pulses the rest of the time.
    if (intro && loaded && introAt === null) introAt = elapsed;
    const inIntro = introAt !== null && elapsed - introAt < INTRO_S;
    if (introAt !== null && inIntro) {
      shatter = introShatter(elapsed - introAt);
    } else {
      const goal = shatterGoal(shatterManual, now - shatterManualAt, tokenRate, tokenPulse);
      shatter += (goal - shatter) * (1 - Math.exp(-dt / SHATTER_EASE_S));
    }
    shared.uShatter.value = shatter;
    // The turn: a drag, its coast, and the way back to the visitor, sooner in a conversation and at once when she
    // speaks. It is placed before the depth pass below, so the sensor sees her as she is turned this frame.
    const voiced = speaking || (arkit?.active(now) ?? false);
    const talking = listening || framingMode === 'portrait' || now - arkitAt < TALK_RECENT_MS;
    orbit.update(dt, voiced ? 0 : talking ? RETURN_TALKING_S : RETURN_AFTER_S);
    placeTurntable();
    if (sculpt && effective === 'sculpture') {
      // The sculpture reads the bones and morphs as they stand this frame, before three renders them.
      turntable.updateMatrixWorld(true);
      sculpt.update({
        dt,
        elapsed,
        camera: stage.camera,
        voice: shared.uAudioLevel.value,
        intro: !intro ? 1 : introAt === null ? 0 : Math.min(1, (elapsed - introAt) / SCULPT_INTRO_S),
      });
    }
    // While she speaks or moves, or the camera eases to a new framing, the loop runs at the display rate: a touch
    // device's idle cap would halve the lip sync and the drag.
    stage.setBusy(voiced || gestures.pressing() || orbit.moving() || inIntro || stage.isEasing());
    // The ring circles the hips, which a head-and-shoulders framing leaves out; drawing it there would only put a
    // bright band across the face. The face look leaves the hips out too.
    if (ring) {
      ring.points.visible = !small && effective !== 'face' && effective !== 'kinect-demo';
      ring.update(bands.bands, dt);
    }
    // The cloud scatters with the token meter, like the sparkle: data leaving the body while the being thinks; and
    // with the pieces, so the head's cloud comes apart and together with its wire. The kinect-demo face is all
    // cloud, millimetre shards with no wire to hold it: it scatters for the intro (and a page's explicit setShatter)
    // only, never with the token meter, so a speaking face stays a face.
    scatter += (scatterFor(tokenRate, tokenPulse) - scatter) * (1 - Math.exp(-dt / SCATTER_EASE_S));
    const manual = shatterGoal(shatterManual, now - shatterManualAt, 0, 0);
    layer?.update({
      dt,
      elapsed,
      camera: stage.camera,
      distance: stage.distance(),
      scatter: effective === 'kinect-demo' ? (inIntro ? shatter : manual) : Math.max(scatter, shatter),
      voice: shared.uAudioLevel.value,
    });
    // Packets flow only while a line plays (or when the page asks); the fan is otherwise still.
    fan.update(stage.camera, headBone, (head?.bounds.centreZ ?? 0) + FAN_PLANE_M, speaking ? SPEAKING_FLOW : 0, dt);
    ribbon?.update(dt);
    floor?.update();
    monitor.sample(stage.fps(), dt, stage.targetFps());
  });

  const ready: Promise<void> = (async () => {
    const [result, post, extras] = await Promise.all([
      loadAvatar(options.assetUrl),
      postprocessing,
      extrasLoading,
      // The look's cloud is part of being ready: a kinect-demo being shows nothing without it.
      layerAtStart,
      sculptAtStart,
    ]);
    if (disposed) {
      disposeAvatar(result);
      return;
    }
    avatar = result;
    if (extras) {
      if (wantRing) {
        ring = new extras.DataRing(shared, theme.blending(), { pixelRatio: stage.getPixelRatio() });
        ring.setHalf(profile.halfPoints);
        theme.register(ring.material);
        stage.scene.add(ring.points);
      }
      if (caps.ribbon) {
        ribbon = new extras.Ribbon(shared, theme.blending(), { reducedMotion });
        theme.register(ribbon.material);
        stage.scene.add(...ribbon.meshes);
      }
      if (caps.reflection) {
        floor = new extras.FloorReflection(shared, theme.blending());
        theme.register(floor.floorMaterial);
        stage.scene.add(floor.group);
        const cloud = currentLayer();
        if (cloud) mirrorCloud(floor, cloud);
        if (ribbon) for (const mesh of ribbon.meshes) floor.mirror(mesh, ribbon.material);
      }
      FIGURE_RIBBON_PROFILE = extras.FIGURE_RIBBON;
      FLOOR_RADIUS = extras.FLOOR_RADIUS_M;
    }
    // The head in the bind pose, before the rig moves anything: the face framing, the sensor and the fan read it.
    result.root.updateMatrixWorld(true);
    head = measureHead(result.head, FAN_LINES);
    headBust = bustBounds(head.bounds);
    headBone = result.bones.head ?? null;
    if (headBone) headBind.copy(headBone.matrixWorld).invert();
    currentLayer()?.setHead(head.bounds, headBone, headBind);
    fan.setPoints(head.points, headBone ? headBone.matrixWorld : new Matrix4());
    const headMaterial = new WireBeingMaterial('head', shared, theme.blending());
    result.head.material = headMaterial;
    materials.push(headMaterial);
    theme.register(headMaterial);
    let bodyMaterial: WireBeingMaterial | null = null;
    if (result.body) {
      bodyMaterial = new WireBeingMaterial('body', shared, theme.blending());
      result.body.material = bodyMaterial;
      materials.push(bodyMaterial);
      theme.register(bodyMaterial);
    }
    // Head and eye turns are taken in the figure's own space, so a nod stays a nod while the turntable has her.
    const driver = new FaceDriver({
      mesh: result.head,
      bones: result.bones,
      morphs: result.morphs,
      space: result.root,
    });
    // Under reduced motion the idle face holds still and only blinks; speech still moves the mouth.
    driver.add(new IdleSource({ still: reducedMotion }));
    face = driver;
    rig = new Rig({ root: result.root, clips: result.clips, bones: result.bones, face: driver, reducedMotion });
    if (pendingLook.set) rig.lookAt(pendingLook.x, pendingLook.y);
    for (const action of pendingActions.splice(0)) rig.pose(action);
    buildSculpture();
    turntable.add(result.root);
    stage.scene.add(turntable);
    if (post) stage.attachBloom(post.createBloomChain);
    // The wire is mirrored below the floor too; a mesh the cloud stands in for has no wire to mirror, and the
    // cloud's own reflection takes its place.
    if (floor) {
      floor.mirror(result.head, headMaterial);
      if (result.body && bodyMaterial) floor.mirror(result.body, bodyMaterial);
    }
    applyScene();
    // Every program links before the first frame, off the main thread where the driver allows, rather than
    // inside one long first tick.
    await stage.compile();
    if (disposed) return;
    loaded = true;
    if (renderAllowed) stage.start();
    options.onReady?.();
  })();
  ready.catch((error: unknown) => {
    if (!disposed) options.onError?.(error);
  });

  const deps: SpeechDeps = {
    output,
    bands,
    tokens: tokenMeter,
    face: () => face,
    // The frame loop reads `speaking` for its rate and for the turn's return.
    onStart: () => {
      speaking = true;
      rig?.setSpeaking(true);
    },
    onEnd: () => {
      speaking = false;
      rig?.setSpeaking(false);
    },
  };

  const stopRun = (): void => {
    const current = run;
    run = null;
    current?.stop();
  };

  const speak = (request: SpeakRequest): Promise<void> => {
    stopRun();
    if (disposed || request.signal?.aborted) return Promise.resolve();
    // The clip plays through the page's shared audio, which the shell primes inside the tap that starts the tour
    // (primeAudio in audioUnlock.ts), so adopting it here needs no gesture of its own. Captions run from the same
    // moment; the mouth joins once the avatar has loaded, and a line still plays captions-only if it never does.
    // A play() the browser refuses rejects the promise, so the tour can switch to captions and say so.
    if (request.clip) output.unlock();
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        if (run === current) run = null;
      };
      const current: SpeechRun = new SpeechRun(
        deps,
        request,
        () => {
          settle();
          resolve();
        },
        (error) => {
          settle();
          reject(error);
        },
      );
      run = current;
      current.start();
    });
  };

  // The ARKit stream joins the face only when a talk session pushes its first frame; the module is fetched then,
  // so the home page's runtime chunk never carries it. Frames that arrive while it loads keep only the newest. An
  // avatar that carries the 52 ARKit morphs (the guide does) takes the stream 1:1 (direct mode); the visemes stay
  // for the tour's clips.
  let arkit: ArkitStreamSource | null = null;
  let arkitLoading = false;
  let arkitAttached = false;
  let arkitPending: Float32Array | null = null;
  const pushArkit = (frame: ArrayLike<number>): void => {
    if (disposed) return;
    arkitAt = performance.now();
    if (arkit) {
      arkit.push(frame);
      if (!arkitAttached && face && avatar) {
        arkit.setDirect(hasArkitMorphs(avatar.morphs));
        face.add(arkit);
        arkitAttached = true;
      }
      return;
    }
    arkitPending = Float32Array.from(frame);
    if (arkitLoading) return;
    arkitLoading = true;
    void import('./face/sources/ArkitStream.ts').then(
      ({ ArkitStreamSource: Source }) => {
        if (disposed) return;
        arkit = new Source();
        const pending = arkitPending;
        arkitPending = null;
        if (pending) pushArkit(pending);
      },
      (error: unknown) => {
        arkitLoading = false;
        options.onError?.(error);
      },
    );
  };

  const handle: BeingHandle = {
    ready,
    speak,
    stopSpeaking: stopRun,
    setTheme(next: Theme): void {
      theme.setTheme(next);
      stage.setBloomStrength(theme.bloom);
      stage.setLightOutput(next === 'light');
    },
    setQuality(quality: Quality): void {
      monitor.set(quality);
      applyQuality(quality);
    },
    getQuality: () => monitor.current(),
    setAudioLevel(level: number): void {
      externalLevel = clamp01(level);
      bands.setExternalLevel(externalLevel);
    },
    tokens(n: number): void {
      tokenMeter.tokens(n);
    },
    pose(action: TourAction): void {
      if (rig) rig.pose(action);
      else pendingActions.push(action);
    },
    lookAt(x: number, y: number): void {
      pendingLook.x = x;
      pendingLook.y = y;
      pendingLook.set = true;
      rig?.lookAt(x, y);
      // The view eases after the pointer too (a few degrees, or the kinect-demo orbit); the sensor camera stays put.
      // On touch the demo's view only drifts: a finger dragging the orbit about would fight the page's scroll. A
      // press on her is a drag or a hold, which the view leaves alone until it ends.
      if (!reducedMotion && !(touch && effective === 'kinect-demo') && !gestures.pressing()) {
        stage.setParallax(clampUnit(x), clampUnit(y));
      }
    },
    stir(x: number, y: number): void {
      if (reducedMotion) return;
      if (effective === 'sculpture') {
        const now = performance.now();
        const seconds = Math.max(0.001, (now - stirLast.t) / 1000);
        const speed = seconds < 0.25 ? Math.hypot(x - stirLast.x, y - stirLast.y) / seconds : 0;
        stirLast.x = x;
        stirLast.y = y;
        stirLast.t = now;
        if (speed > 0.05) sculpt?.stir(clampUnit(x), clampUnit(y), speed, stage.camera);
        return;
      }
      if (effective !== 'kinect-demo') return;
      layer?.stir(clampUnit(x), clampUnit(y), stage.camera);
    },
    setListening(on: boolean): void {
      listening = on;
      ring?.setListening(on);
    },
    setLook(next: LookRequest): void {
      const wanted = normaliseLook(next);
      if (wanted === look) return;
      look = wanted;
      applyScene();
      if (look === 'sculpture' && !sculptLoading) {
        loadSculpture().catch((error: unknown) => {
          sculptLoading = null;
          if (!disposed) options.onError?.(error);
        });
      }
      // A look that draws the cloud fetches its chunk now, if no earlier look did; the layer joins when it lands.
      if (drawsCloud(look) && !layerLoading) {
        loadLayer().catch((error: unknown) => {
          layerLoading = null;
          if (!disposed) options.onError?.(error);
        });
      }
    },
    getLook: () => look,
    setFraming(mode: FramingMode): void {
      if (mode !== 'bust' && mode !== 'portrait') return;
      framingMode = mode;
      stage.setFraming(mode);
    },
    isSpeaking: () => speaking,
    setShatter(value: number): void {
      shatterManual = clamp01(value);
      shatterManualAt = performance.now();
    },
    fan: {
      setTargets: (targets) => fan.setTargets(targets),
      setActivity: (value) => fan.setActivity(value),
      setEnabled: (on) => fan.setEnabled(on),
    },
    setDepthSource(source: DepthSource | null): void {
      if (source === external) return;
      external = source;
      applyScene();
    },
    kinect: {
      setClipping: (nearM, farM) => knob('clipping', (target) => target.setClipping(nearM, farM)),
      setPointSize: (px) => knob('pointSize', (target) => target.setPointSize(px)),
      setZOffset: (m) => knob('zOffset', (target) => target.setZOffset(m)),
      setMode: (mode) => {
        chosenMode = mode;
        knob('mode', (target) => target.setMode(mode));
      },
      setHeadWire: (on) => {
        demoHeadWire = on;
        applyScene();
      },
      setDisplacement: (value) => knob('displacement', (target) => target.setDisplacement(value)),
      setBrightness: (value) => knob('brightness', (target) => target.setBrightness(value)),
      setContrast: (value) => knob('contrast', (target) => target.setContrast(value)),
      setOpacity: (value) => knob('opacity', (target) => target.setOpacity(value)),
      setLineWidth: (px) => knob('lineWidth', (target) => target.setLineWidth(px)),
      setRipple: (m) => knob('ripple', (target) => target.setRipple(m)),
    },
    face: { pushArkit },
    stats: () => ({
      fps: stage.fps(),
      drawCalls: stage.drawCalls(),
      triangles: stage.triangles(),
      quality: monitor.current(),
      points: effective === 'sculpture' && sculpt ? sculpt.shards() : layer ? layer.points() : 0,
      depth: layer ? layer.clippingRange() : { near: 0, far: 0 },
      look,
      // Until the cloud has arrived, the mode it will take: the page's, or the look's own (points is KINECT_DEFAULTS'
      // mode, which lives in the cloud chunk).
      mode: layer ? layer.mode() : (chosenMode ?? (effective === 'kinect-demo' ? 'shards' : 'points')),
    }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopRun();
      output.dispose();
      stage.stop();
      window.clearTimeout(holdTimer);
      // A hold that was on when the being went away has ended (its em:being-hold says so) and a drag lets go.
      gestures.cancel();
      releasePointer();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      rig?.dispose();
      face?.dispose();
      floor?.dispose();
      fan.dispose();
      if (avatar) {
        turntable.remove(avatar.root);
        disposeAvatar(avatar);
        avatar = null;
      }
      stage.scene.remove(turntable);
      for (const material of materials) {
        theme.unregister(material);
        material.dispose();
      }
      materials.length = 0;
      ring?.dispose();
      ribbon?.dispose();
      layer?.dispose();
      layer = null;
      sculpt?.dispose();
      sculpt = null;
      stage.dispose();
    },
  };
  return handle;
}
