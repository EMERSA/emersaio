/**
 * Public contracts of the being runtime. Everything the site (or a demo) needs to drive a being goes through
 * these types. The only three.js reference is the type-only DepthSource import, erased at runtime, so the shell
 * can import them for free.
 */
import type { DepthSource } from './data/depth/DepthSource.ts';

export type Theme = 'dark' | 'light';

/**
 * How the figure is drawn: 'wire' is all wire triangles, 'kinect' is all point cloud (the head wire hidden),
 * 'hybrid' keeps the head as wire and draws the body as the cloud with its wire hidden, and 'face' hides the body
 * and frames the head alone, large, as wire over a dense Kinect-style depth cloud of the head. 'kinect-demo' is
 * three's webgl_video_kinect done in tiny triangles: head and shoulders, no wire, a dense lattice of glowing shards
 * from a fixed sensor, seen by a view camera that orbits with the pointer. The lattice is sized from the frame on
 * screen (a shard about two pixels across), and the shards ride a simulated liquid skin that her voice, the pointer
 * and the odd drop set rippling. They are drawn like three's Kinect video seen in depth: bright scan bands of tiny
 * triangles that the liquid bends, coloured white nearest through cyan and azure to navy, the silhouette dissolving
 * into dust.
 */
export type Look = 'wire' | 'kinect' | 'hybrid' | 'face' | 'kinect-demo' | 'sculpture';
/** What the shell may ask for: the looks, plus the shared contract's name for the face, 'kinect-face'. */
export type LookRequest = Look | 'kinect-face';

/**
 * How the kinect cloud draws its depth grid: points (the default), wire triangles, a solid metallic surface, or
 * shards: a staggered, jittered lattice whose cells cut into two near-equilateral triangles, each shrunk toward its
 * centroid, glowing facets with a crisp edge (the kinect-demo look's default).
 */
export type KinectMode = 'points' | 'wire' | 'mesh' | 'shards';

/**
 * How the kinect-demo look frames Emily: 'bust' is the hero's head and shoulders, 'portrait' her head and neck as
 * large as the stage allows, for a phone's conversation, where nothing covers the stage.
 */
export type FramingMode = 'bust' | 'portrait';

/** A node of the data fan in canvas-normalised coordinates: -1..1, x right, y up. */
export interface FanTarget {
  x: number;
  y: number;
}

/** Rendering tiers. The quality ladder steps down this list when the frame rate drops. */
export type Quality = 'full' | 'balanced' | 'lite' | 'poster';

/** Colours the 3D scene reads from the page's custom properties, so the being recolours with the theme. */
export interface ThemeColors {
  wire: string;
  glow: string;
  dot: string;
  echo: string;
  bg3d: string;
  /** Optional: the ribbon's colour and the rim light's; empty means the glow is used. */
  ribbon: string;
  rim: string;
  /** Optional: the data fan's colour; empty means the wire colour is used. */
  fan: string;
}

/** A single lip-sync cue: milliseconds from clip start, a canonical viseme id (0-21, Microsoft set), optional weight. */
export type VisemeCue = [offsetMs: number, viseme: number, weight?: number];

/** A pre-rendered line: same-origin audio plus its viseme timeline. Absent in captions-only mode. */
export interface VoiceClip {
  src: string;
  durationMs: number;
  visemes: VisemeCue[];
}

export type TourAction =
  | { type: 'goto'; target: string }
  | { type: 'highlight'; target: string }
  | { type: 'point'; side: 'left' | 'right' }
  | { type: 'emote'; name: 'smile' | 'nod' | 'think' | 'neutral' }
  | { type: 'open'; what: 'talk' };

/** One stop of the scripted tour (src/content/tour/*.yaml on the site, served as /tour/script.json). */
export interface TourStop {
  id: string;
  /** CSS selector the page scrolls to before the line is spoken. */
  anchor: string;
  /** The spoken and captioned text, at most 40 words. */
  text: string;
  /** CSS selector to highlight while the line plays. */
  highlight?: string;
  /** Pause after the line, before Next becomes automatic. */
  dwellMs?: number;
  actions?: TourAction[];
  voice?: VoiceClip;
}

export interface TourScript {
  version: 1;
  persona: string;
  stops: TourStop[];
}

export interface Persona {
  name: string;
  shortName: string;
  pronouns: 'she/her' | 'he/him' | 'they/them';
  role: string;
  greeting: string;
  voice: { lang: string; azureVoice?: string; kokoroVoice?: string };
}

export interface SpeakRequest {
  text: string;
  clip?: VoiceClip;
  /** Called as caption characters are revealed; the shell renders captions, the being only times them. */
  onCaption?: (shown: string, done: boolean) => void;
  signal?: AbortSignal;
}

/** What createBeing() returns. Every method is safe to call before `ready` resolves; calls queue until it does. */
export interface BeingHandle {
  readonly ready: Promise<void>;
  speak(request: SpeakRequest): Promise<void>;
  stopSpeaking(): void;
  setTheme(theme: Theme): void;
  setQuality(quality: Quality): void;
  getQuality(): Quality;
  /** External audio energy 0-1 (the microphone while listening). */
  setAudioLevel(level: number): void;
  /** Feed the token meter: n tokens (or characters) just arrived. */
  tokens(n: number): void;
  pose(action: TourAction): void;
  /** Pointer position in -1..1 (x right, y up); the head follows it gently. */
  lookAt(x: number, y: number): void;
  /**
   * The pointer moving over the stage, in -1..1 (x right, y up): in the kinect-demo look it stirs the shards' liquid
   * skin where it crosses the face, in proportion to its speed. Nothing happens in other looks or under reduced motion.
   */
  stir(x: number, y: number): void;
  setListening(on: boolean): void;
  /** Switch between the wire, the kinect cloud, the hybrid of the two and the face; the small docked stage always draws wire. */
  setLook(look: LookRequest): void;
  getLook(): Look;
  /**
   * Frame the kinect-demo bust as the hero's head and shoulders ('bust', the default) or as the phone conversation's
   * portrait of her head and neck ('portrait'). The camera eases over 500 ms, or lands at once under reduced motion.
   */
  setFraming(mode: FramingMode): void;
  /** True while a line plays (clip or captions-only): the shell shows its 'AI-generated voice' line from this. */
  isSpeaking(): boolean;
  /**
   * Pieces: 0 draws the head assembled, 1 fully scattered, every wire triangle flying as one rigid piece and the
   * head's depth cloud with it. The automatic pulse while tokens stream resumes 2 s after the last call.
   */
  setShatter(value: number): void;
  /**
   * The data fan: hairlines from points on the face to four small nodes the runtime fixes down the right edge of
   * the canvas, drawn in the face look on fine-pointer desktops (not in the lite tier), with packets travelling
   * along them only while the being speaks.
   */
  readonly fan: {
    /** Where the nodes are, in canvas-normalised coordinates, for a page that must move them; the runtime's own are the brief's. */
    setTargets(targets: FanTarget[]): void;
    /** Flow strength 0..1; the runtime also raises it itself while speaking or streaming tokens. */
    setActivity(value: number): void;
    setEnabled(on: boolean): void;
  };
  /**
   * Feed the cloud from a sensor or a video instead of the being's own depth; null returns to the being. The
   * caller owns the source and disposes it.
   */
  setDepthSource(source: DepthSource | null): void;
  /**
   * The cloud's knobs. Clipping and the z offset apply to sensor and video sources; the being uses its camera.
   * The rest follow Three-Kinectron: points, wire or mesh; displacement 1; brightness 0; contrast 1; opacity 1;
   * line width 1.2 px.
   */
  readonly kinect: {
    setClipping(nearM: number, farM: number): void;
    setPointSize(px: number): void;
    setZOffset(m: number): void;
    setMode(mode: KinectMode): void;
    /** The kinect-demo look's wire head over its shards; off by default. */
    setHeadWire(on: boolean): void;
    /** Depth relief about the figure's distance; 1 is true to the depth. */
    setDisplacement(value: number): void;
    setBrightness(value: number): void;
    setContrast(value: number): void;
    setOpacity(value: number): void;
    /** Stroke width of the wire mode in CSS pixels. */
    setLineWidth(px: number): void;
    /**
     * Amplitude of the shards' slow swell, in metres along the sensor ray (0 to 0.02; 2 mm by default, 0 under
     * reduced motion). 0 stills it; the ripples of the liquid skin are separate.
     */
    setRipple(metres: number): void;
  };
  /**
   * Live face input. pushArkit feeds one 61-value ARKit frame (the order of ARKIT_ORDER_61, as Convai streams it)
   * to the face's stream source at priority 20; 200 ms without a frame and the face returns to its own sources.
   * On an avatar that carries the 52 ARKit morphs (the guide does) the blendshapes land on them 1:1 and the rotations
   * turn the head and the eyes; while frames arrive the loop runs at the display rate, also on touch devices.
   * The source's code loads on the first push, so a page that never talks never fetches it.
   */
  readonly face: {
    pushArkit(frame: ArrayLike<number>): void;
    /** Replace one viseme's mouth recipe (ARKit shape name -> weight 0..1), for tuning in the dev harness. */
    setMouthRecipe(viseme: number, recipe: Readonly<Record<string, number>>): void;
    /** Hold one viseme's shape (null releases it), so a recipe can be judged still; a live stream still wins. */
    holdViseme(viseme: number | null, weight?: number): void;
  };
  /**
   * Frame statistics for the HUD: points is the cloud's grid size while it draws; depth is the range its colour
   * ramp spans in metres (for the being's own depth the measured near and far of the figure from the camera, for
   * a sensor or video source the clipping); look and mode are the ones in force.
   */
  stats(): {
    fps: number;
    drawCalls: number;
    triangles: number;
    quality: Quality;
    points: number;
    depth: { near: number; far: number };
    look: Look;
    mode: KinectMode;
  };
  dispose(): void;
}

/** The detail of 'em:being-hold', which the canvas dispatches (bubbling) as a press held still on Emily starts and ends. */
export interface BeingHoldDetail {
  active: boolean;
}

export interface BeingOptions {
  /**
   * The canvas the being draws on. Its pointer gestures are the runtime's: a drag turns Emily (and tilts the view),
   * and a press held still for 250 ms dispatches a bubbling 'em:being-hold' CustomEvent<BeingHoldDetail> with
   * active true, then false on the release. A tap is left to the page.
   */
  canvas: HTMLCanvasElement;
  /** URL of guide.glb or guide-lite.glb (meshopt-compressed glTF). */
  assetUrl: string;
  theme: Theme;
  /** The tier to start at; touch devices start no higher than balanced. */
  quality?: Quality;
  /**
   * Bloom costs a full extra pass and a chunk of its own; off by default, and the chunk is never requested while
   * it is off.
   */
  bloom?: boolean;
  /** @deprecated The depth echo became the kinect cloud, which the look controls; this flag is ignored. */
  echo?: boolean;
  /** 'hybrid' by default: wire head, point-cloud body. The shell asks for 'face' (or the contract's 'kinect-face'). */
  look?: LookRequest;
  /** Draw the wire head over the shards in the kinect-demo look (off by default). */
  headWire?: boolean;
  /** The data ring round the hips (on by default; never constructed when false, as on the home page). */
  ring?: boolean;
  /** The lighting behind the figure: the one rim light ('rim-only', the default) or nothing. */
  backdrop?: 'rim-only' | 'none';
  /** Accepted for the shared contract; the HUD is the shell's own and the runtime draws none. */
  hud?: boolean;
  /** The head assembles from pieces when the being first shows (on by default; skipped under reduced motion). */
  intro?: boolean;
  /**
   * The glossy ribbon around the figure and the mirrored draw below the floor: product-shot extras for the dev
   * harness, on by default there (the ribbon never in the lite tier, the reflection only on desktops at full tier).
   * When ring, ribbon and reflection are all false, as the home page passes them, their code is never loaded.
   */
  ribbon?: boolean;
  reflection?: boolean;
  /** A sensor or video depth source to start with; the being's own depth otherwise. */
  depthSource?: DepthSource;
  reducedMotion?: boolean;
  /** Visible pixel ratio cap; 1.5 on touch, 2 on desktop by default. */
  maxPixelRatio?: number;
  onReady?: () => void;
  onError?: (error: unknown) => void;
  onContextLost?: () => void;
}

/** Streaming events from a brain provider, after the middleware chain. */
export type BrainEvent =
  | { type: 'token'; text: string }
  | { type: 'sentence'; text: string }
  | { type: 'action'; action: TourAction }
  | { type: 'done'; reason?: 'complete' | 'aborted' | 'limit' }
  | { type: 'error'; message: string };

export interface Turn {
  role: 'user' | 'being';
  text: string;
  at: number;
}

export interface Fact {
  key: string;
  value: string;
  confidence: number;
}

export interface BrainContext {
  text: string;
  history: Turn[];
  facts: Fact[];
  /** Build-time page context keyed by a validated docs id; never visitor-controlled text. */
  page?: { id: string; title: string; excerpt: string };
  signal?: AbortSignal;
}

export interface Brain {
  readonly name: string;
  respond(context: BrainContext): AsyncIterable<BrainEvent>;
  dispose?(): void;
}

export type BrainNext = (context: BrainContext) => AsyncIterable<BrainEvent>;
export type BrainMiddleware = (context: BrainContext, next: BrainNext) => AsyncIterable<BrainEvent>;

export interface SpeechOut {
  readonly name: string;
  speak(request: SpeakRequest): Promise<void>;
  stop(): void;
  /** An analyser on the output, when the provider can expose one (clips, Convai); drives the data ring. */
  readonly analyser?: AnalyserNode;
}

export interface SpeechIn {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  onTranscript(listener: (text: string, final: boolean) => void): () => void;
  onLevel(listener: (level: number) => void): () => void;
}
