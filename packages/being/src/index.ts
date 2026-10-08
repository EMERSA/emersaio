/**
 * The front door of the being runtime. createBeing() wires the stage, the avatar, the face, the rig and the data
 * visualisations together and returns the BeingHandle from types.ts, including speak() with clip playback and
 * caption timing. Nothing here knows about the page: the shell owns captions, the poster and the state classes.
 */
import { Matrix4, type Mesh, type Object3D, Vector3 } from 'three';
import { type HeadMeasure, measureHead } from './avatar/headMeasure.ts';
import { type LoadedAvatar, loadAvatar } from './avatar/loadAvatar.ts';
import { Rig } from './avatar/Rig.ts';
import { INTRO_S, introShatter, SHATTER_EASE_S, shatterGoal } from './avatar/shatter.ts';
import { createSharedUniforms, WireBeingMaterial } from './avatar/WireBeingMaterial.ts';
import { isCoarsePointer } from './capabilities.ts';
import { AudioBands } from './data/AudioBands.ts';
import { DataFan } from './data/DataFan.ts';
import { BeingDepthSource } from './data/depth/BeingDepthSource.ts';
import type { DepthSource } from './data/depth/DepthSource.ts';
import { EYE_LINE_SHARE, scatterFor } from './data/depth/depthMath.ts';
import { FAN_LINES, FAN_PLANE_M } from './data/fanMath.ts';
import { type KeepZone, KINECT_DEFAULTS, KinectCloud } from './data/KinectCloud.ts';
import { TokenMeter } from './data/TokenMeter.ts';
import { FaceDriver } from './face/FaceDriver.ts';
import type { FaceSource } from './face/source.ts';
import type { ArkitStreamSource } from './face/sources/ArkitStream.ts';
import { IdleSource } from './face/sources/Idle.ts';
import { TextVisemesSource } from './face/sources/TextVisemes.ts';
import { VisemeTimelineSource } from './face/sources/VisemeTimeline.ts';
import { getAudioOutput, unlock } from './speech/audioUnlock.ts';
import { RIM_HEIGHT_M, RIM_RADIUS_SHARE, RIM_RIGHT_SHARE } from './stage/Backdrop.ts';
import { bustBounds, type HeadBounds } from './stage/framing.ts';
import { CLOUD_GRIDS, type QualityCaps, QualityMonitor, qualityProfile, startingQuality } from './stage/Quality.ts';
import { ORBIT_PITCH_DEG, ORBIT_YAW_DEG, PARALLAX_PITCH_DEG, PARALLAX_YAW_DEG, Stage } from './stage/Stage.ts';
import { ThemeUniforms } from './stage/ThemeUniforms.ts';
import type {
  BeingHandle,
  BeingOptions,
  Look,
  LookRequest,
  Quality,
  SpeakRequest,
  Theme,
  TourAction,
  VoiceClip,
} from './types.ts';

export { type Capabilities, detectCapabilities } from './capabilities.ts';
// The being's own depth and the maths; the Kinectron and video sources are dev-only inputs and live on the
// '@emersa/being/depth' subpath alone, so the home page never carries them (their types are free).
export {
  azureGreyToMm,
  BeingDepthSource,
  type BeingDepthSourceOptions,
  backProject,
  type CloudGrid,
  cameraTangents,
  DEFAULT_CLIPPING,
  DEPTH_LAYER,
  type DepthClipping,
  type DepthEncoding,
  type DepthSource,
  type DepthSourceKind,
  DISPARITY_FB,
  DISPARITY_SUBPX,
  DROPOUT_HZ,
  disparityStep,
  type FovTangents,
  hash01,
  isJump,
  JUMP_SHARE,
  KINECT_V1_TANGENTS,
  KINECTRON_CLIPPING,
  type KinectronClient,
  type KinectronClientConfig,
  type KinectronConstructor,
  type KinectronDepthSourceOptions,
  type KinectronFeed,
  type KinectronImageFrame,
  type KinectronKinectType,
  type KinectronRawDepthFrame,
  type KinectronRawDepthPayload,
  kinectV2GreyToMm,
  POINT_CSS_PX,
  pcg,
  pointAlpha,
  pointSizePx,
  quantiseDistance,
  SENSOR_FACE,
  SENSOR_HZ,
  SENSOR_TANGENTS,
  type SensorKind,
  sensorFrame,
  type VideoDepthSourceOptions,
} from './data/depth/index.ts';
export { DEFAULT_FAN_TARGETS, FAN_NODE_SHARES, FAN_PLANE_M } from './data/fanMath.ts';
export { DEFAULT_POINT_SIZE_PX, KINECT_DEFAULTS, type KinectCloudOptions } from './data/KinectCloud.ts';
export { FACE_CHIN_AIR, FACE_CROWN_AIR, FACE_PORTRAIT_SHARE, faceLayoutT } from './stage/framing.ts';
export type * from './types.ts';

type Postprocessing = typeof import('./stage/postprocessing.ts');
type Extras = typeof import('./data/extras.ts');
type DataRing = InstanceType<Extras['DataRing']>;
type Ribbon = InstanceType<Extras['Ribbon']>;
type FloorReflection = InstanceType<Extras['FloorReflection']>;

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
 * The eyes and the mouth as shares of the head's height above the chin and forward of its centre, with radii, for
 * the zones the cloud's dropout never touches (the study: never drop on the eyes or the mouth).
 */
const EYES_ZONE = { up: EYE_LINE_SHARE, forward: 0.3, radius: 0.34 } as const;
const MOUTH_ZONE = { up: 0.27, forward: 0.38, radius: 0.2 } as const;
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

  // The kinect cloud and where it reads depth from: the being's own depth pass, rendered from a fixed sensor
  // camera at 30 Hz, unless a sensor or a video is given.
  const startGrid = profile.cloud ?? CLOUD_GRIDS.reduced;
  const beingSource = new BeingDepthSource({
    renderer: stage.renderer,
    scene: stage.scene,
    width: startGrid.cols,
    height: startGrid.rows,
    reducedMotion,
  });
  let external: DepthSource | null = options.depthSource ?? null;
  const cloud = new KinectCloud(shared, theme.blending(), {
    cols: startGrid.cols,
    rows: startGrid.rows,
    pixelRatio: caps.maxPixelRatio,
    reducedMotion,
  });
  // The grid material follows the theme's blending in wire mode and blends normally as a solid mesh (KinectCloud).
  theme.register(cloud.material);
  stage.scene.add(cloud.points, cloud.mesh);
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
  const headBind = new Matrix4();
  /** The head bone's movement since the bind pose, and the keep zones carried along with it each frame. */
  const headDelta = new Matrix4();
  const zonePoint = new Vector3();
  const eyesZone: KeepZone = { x: 0, y: 0, z: 0, radius: 0 };
  const mouthZone: KeepZone = { x: 0, y: 0, z: 0, radius: 0 };
  /** The pieces: the amount drawn, the shell's last value and when it came, and when the intro began (stage time). */
  let shatter = 0;
  let shatterManual = 0;
  let shatterManualAt = Number.NEGATIVE_INFINITY;
  let introAt: number | null = null;
  /** The kinect-demo look's wire head (off unless asked for), and whether the page picked the cloud's mode itself. */
  let demoHeadWire = options.headWire === true;
  let modeChosen = false;

  /** A keep zone from the head's bind-pose bounds, moved with the head bone. */
  const placeZone = (zone: KeepZone, shape: { up: number; forward: number; radius: number }): void => {
    const bounds = head?.bounds;
    if (!bounds) return;
    const h = Math.max(0.05, bounds.maxY - bounds.minY);
    zonePoint.set(0, bounds.minY + shape.up * h, bounds.centreZ + shape.forward * h).applyMatrix4(headDelta);
    zone.x = zonePoint.x;
    zone.y = zonePoint.y;
    zone.z = zonePoint.z;
    zone.radius = shape.radius * h;
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
    if (!modeChosen) cloud.setMode(isDemo ? 'shards' : KINECT_DEFAULTS.mode);
    stage.setOrbit(
      isDemo ? ORBIT_YAW_DEG : PARALLAX_YAW_DEG,
      isDemo ? ORBIT_PITCH_DEG : PARALLAX_PITCH_DEG,
      isDemo && !reducedMotion,
    );
    // With a sensor or a video the cloud is theirs, and the being's own depth pass has nothing to add.
    beingSource.setMeshes(external ? [] : casters);
    cloud.setSource(external ?? beingSource);
    const demoGrid = touch && profile.bustCloud ? CLOUD_GRIDS.bustLite : profile.bustCloud;
    const grid = (isDemo ? demoGrid : isFace ? profile.headCloud : profile.cloud) ?? CLOUD_GRIDS.reduced;
    cloud.setGrid(grid.cols, grid.rows);
    beingSource.setSize(grid.cols, grid.rows);
    cloud.setEnabled(effective !== 'wire');
    const headBounds = headLook && head ? head.bounds : null;
    // One object per head: the stage compares bounds by identity, and its layout calls back into this function.
    const bust = isDemo && headBounds ? headBust : null;
    const bounds = bust ?? headBounds;
    cloud.setCrop(bust ? bust.minY : null);
    // The sensor stands in front of the head in the face look and on its tripod before the figure otherwise; the
    // cloud's ramp is centred on what it looks at until the probe has measured the figure.
    if (bust) {
      beingSource.placeForBust(bust);
      cloud.setSubject(0, (bust.minY + bust.maxY) / 2, bust.centreZ);
    } else if (bounds) {
      beingSource.placeForHead(bounds);
      cloud.setSubject(0, bounds.minY + (bounds.maxY - bounds.minY) * EYE_LINE_SHARE, bounds.centreZ);
    } else {
      beingSource.placeForFigure();
      cloud.setSubject(0, 1, 0);
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
    cloud.setPixelRatio(stage.getPixelRatio());
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
    if (head && (effective === 'face' || effective === 'kinect-demo')) applyScene();
  });

  stage.onFrame((dt, elapsed) => {
    const now = performance.now();
    tokenMeter.update(now);
    bands.update(dt);
    rig?.update(dt);
    face?.update(now, dt);
    shared.uTime.value = elapsed;
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
    if (introAt !== null && elapsed - introAt < INTRO_S) {
      shatter = introShatter(elapsed - introAt);
    } else {
      const goal = shatterGoal(shatterManual, now - shatterManualAt, tokenRate, tokenPulse);
      shatter += (goal - shatter) * (1 - Math.exp(-dt / SHATTER_EASE_S));
    }
    shared.uShatter.value = shatter;
    // The ring circles the hips, which a head-and-shoulders framing leaves out; drawing it there would only put a
    // bright band across the face. The face look leaves the hips out too.
    if (ring) {
      ring.points.visible = !small && effective !== 'face' && effective !== 'kinect-demo';
      ring.update(bands.bands, dt);
    }
    // The cloud scatters with the token meter, like the sparkle: data leaving the body while the being thinks; and
    // with the pieces, so the head's cloud comes apart and together with its wire.
    scatter += (scatterFor(tokenRate, tokenPulse) - scatter) * (1 - Math.exp(-dt / SCATTER_EASE_S));
    // The kinect-demo face is all cloud, millimetre shards with no wire to hold it: it scatters for the intro (and
    // a page's explicit setShatter) only, never with the token meter, so a speaking face stays a face.
    const demo = effective === 'kinect-demo';
    const inIntro = introAt !== null && elapsed - introAt < INTRO_S;
    const manual = shatterGoal(shatterManual, now - shatterManualAt, 0, 0);
    cloud.setScatter(demo ? (inIntro ? shatter : manual) : Math.max(scatter, shatter));
    // The eyes and the mouth travel with the head bone; the dropout leaves them alone.
    if ((effective === 'face' || effective === 'kinect-demo') && head) {
      if (headBone) headDelta.multiplyMatrices(headBone.matrixWorld, headBind);
      placeZone(eyesZone, EYES_ZONE);
      placeZone(mouthZone, MOUTH_ZONE);
      cloud.setKeepZones(eyesZone, mouthZone);
    } else {
      cloud.setKeepZones(null, null);
    }
    (external ?? beingSource).update(dt);
    cloud.update(stage.camera, stage.distance(), dt, elapsed);
    // Packets flow only while a line plays (or when the page asks); the fan is otherwise still.
    fan.update(stage.camera, headBone, (head?.bounds.centreZ ?? 0) + FAN_PLANE_M, speaking ? SPEAKING_FLOW : 0, dt);
    ribbon?.update(dt);
    floor?.update();
    monitor.sample(stage.fps(), dt, stage.targetFps());
  });

  const ready: Promise<void> = (async () => {
    const [result, post, extras] = await Promise.all([loadAvatar(options.assetUrl), postprocessing, extrasLoading]);
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
        floor.mirror(cloud.points, cloud.material);
        floor.mirror(cloud.mesh, cloud.gridMaterial);
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
    const driver = new FaceDriver({ mesh: result.head, bones: result.bones, morphs: result.morphs });
    driver.add(new IdleSource());
    face = driver;
    rig = new Rig({ root: result.root, clips: result.clips, bones: result.bones, face: driver, reducedMotion });
    if (pendingLook.set) rig.lookAt(pendingLook.x, pendingLook.y);
    for (const action of pendingActions.splice(0)) rig.pose(action);
    stage.scene.add(result.root);
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
    onStart: () => {
      speaking = true;
      stage.setBusy(true);
      rig?.setSpeaking(true);
    },
    onEnd: () => {
      speaking = false;
      stage.setBusy(false);
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
  // so the home page's runtime chunk never carries it. Frames that arrive while it loads keep only the newest.
  let arkit: ArkitStreamSource | null = null;
  let arkitLoading = false;
  let arkitAttached = false;
  let arkitPending: Float32Array | null = null;
  const pushArkit = (frame: ArrayLike<number>): void => {
    if (disposed) return;
    if (arkit) {
      arkit.push(frame);
      if (!arkitAttached && face) {
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
      // On touch the demo's view only drifts: a finger dragging the orbit about would fight the page's scroll.
      if (!reducedMotion && !(touch && effective === 'kinect-demo')) stage.setParallax(clampUnit(x), clampUnit(y));
    },
    setListening(on: boolean): void {
      ring?.setListening(on);
    },
    setLook(next: LookRequest): void {
      const wanted = normaliseLook(next);
      if (wanted === look) return;
      look = wanted;
      applyScene();
    },
    getLook: () => look,
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
      setClipping: (nearM, farM) => cloud.setClipping(nearM, farM),
      setPointSize: (px) => cloud.setPointSize(px),
      setZOffset: (m) => cloud.setZOffset(m),
      setMode: (mode) => {
        modeChosen = true;
        cloud.setMode(mode);
      },
      setHeadWire: (on) => {
        demoHeadWire = on;
        applyScene();
      },
      setDisplacement: (value) => cloud.setDisplacement(value),
      setBrightness: (value) => cloud.setBrightness(value),
      setContrast: (value) => cloud.setContrast(value),
      setOpacity: (value) => cloud.setOpacity(value),
      setLineWidth: (px) => cloud.setLineWidth(px),
    },
    face: { pushArkit },
    stats: () => ({
      fps: stage.fps(),
      drawCalls: stage.drawCalls(),
      triangles: stage.triangles(),
      quality: monitor.current(),
      points: cloud.showing() ? cloud.count() : 0,
      depth: cloud.clippingRange(),
      look,
      mode: cloud.mode(),
    }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopRun();
      output.dispose();
      stage.stop();
      rig?.dispose();
      face?.dispose();
      floor?.dispose();
      fan.dispose();
      if (avatar) {
        stage.scene.remove(avatar.root);
        disposeAvatar(avatar);
        avatar = null;
      }
      for (const material of materials) {
        theme.unregister(material);
        material.dispose();
      }
      materials.length = 0;
      ring?.dispose();
      ribbon?.dispose();
      cloud.dispose();
      // An external source belongs to whoever made it.
      beingSource.dispose();
      stage.dispose();
    },
  };
  return handle;
}
