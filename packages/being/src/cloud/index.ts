/**
 * The kinect cloud and everything it needs, in a chunk of its own ('cloud'): the depth grid that back-projects a depth
 * source (KinectCloud), the being's own depth rendered from a fixed sensor (BeingDepthSource) and the shards' liquid
 * skin (SurfaceFluid), with the parts of the being that place them: the keep zones round the eyes and the mouth, the
 * sensor for each look, the grid the being chose, the pointer's stir and the cloud's knobs. createBeing() imports
 * this file only for the looks that draw a cloud (kinect, hybrid, face and kinect-demo), so a wire being never
 * fetches it, and it takes the depth files one by one rather than through the '@emersa/being/depth' barrel, so the
 * dev-only Kinectron and video sources stay out of it. Nothing here imports a module of the core at runtime (the
 * grid comes in with apply()): the build groups this chunk with its dependencies (apps/web/astro.config.mjs), and a
 * core module among them would be pulled in here and make the core load this chunk at once.
 */
import {
  type Blending,
  Matrix4,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';
import { BeingDepthSource } from '../data/depth/BeingDepthSource.ts';
import type { DepthSource } from '../data/depth/DepthSource.ts';
import {
  type CloudGrid,
  type DepthClipping,
  EYE_LINE_SHARE,
  SENSOR_BUST,
  sensorFrameHeight,
} from '../data/depth/depthMath.ts';
import { type KeepZone, KINECT_DEFAULTS, KinectCloud } from '../data/KinectCloud.ts';
import { SurfaceFluid } from '../data/SurfaceFluid.ts';
import type { HeadBounds } from '../stage/framing.ts';
import type { KinectMode, Look } from '../types.ts';

/**
 * The eyes and the mouth as shares of the head's height above the chin and forward of its centre, with radii, for
 * the zones the cloud's dropout never touches (the study: never drop on the eyes or the mouth).
 */
const EYES_ZONE = { up: EYE_LINE_SHARE, forward: 0.3, radius: 0.34 } as const;
const MOUTH_ZONE = { up: 0.27, forward: 0.38, radius: 0.2 } as const;
/** The shards' liquid skin: metres along the sensor ray per unit of height, and how far its slope tilts the light. */
const FLUID_AMP_M = 0.005;
const FLUID_TILT = 20;
/** The pointer stirs the front of the face, this far ahead of the head's centre. */
const FACE_FRONT_M = 0.08;
/** Once the pointer stops, its stir fades over about this time. */
const STIR_EASE_S = 0.12;

export interface CloudLayerOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  shared: SharedUniforms;
  blending: Blending;
  /** The grid to start with; apply() sizes it for the look. */
  grid: CloudGrid;
  pixelRatio: number;
  reducedMotion: boolean;
}

/** What the being decided for the look in force, handed over on every layout (see apply). */
export interface CloudScene {
  /** The look in force: the one asked for, unless the docked stage or the tier reduce it to the wire. */
  look: Look;
  /** The meshes that cast the cloud from the depth layer. */
  casters: Mesh[];
  /** A sensor or video source; null for the being's own depth. */
  external: DepthSource | null;
  /** The cloud's grid for the look and the tier (the bust lattice sized from bustFrameM's share of the stage). */
  grid: CloudGrid;
  /** The head in the face and kinect-demo looks, and the head-and-shoulders crop in kinect-demo; null otherwise. */
  head: HeadBounds | null;
  bust: HeadBounds | null;
}

/**
 * The height in metres the kinect-demo sensor's frame takes in at the bust: the being sizes the bust lattice from
 * the share of the stage this covers, so a shard stays a couple of pixels across however large the hero is.
 */
export const BUST_FRAME_M = sensorFrameHeight(SENSOR_BUST);

/** The frame's inputs. */
export interface CloudFrame {
  dt: number;
  elapsed: number;
  /** The view camera and its distance to the subject, for the points' size. */
  camera: PerspectiveCamera;
  distance: number;
  /** How far the cloud is scattered (the token meter, the pieces). */
  scatter: number;
  /** Her loudness 0..1, which rings the liquid out from her lips. */
  voice: number;
}

/**
 * The cloud as one layer of the being: built when its chunk arrives, placed by apply() on every layout and stepped
 * by update() every frame, before the render.
 */
export class CloudLayer {
  readonly cloud: KinectCloud;
  /** BUST_FRAME_M, for the being that sizes the bust lattice. */
  readonly bustFrameM = BUST_FRAME_M;
  private readonly depth: BeingDepthSource;
  private readonly fluid: SurfaceFluid;
  private readonly reducedMotion: boolean;
  private external: DepthSource | null = null;
  private look: Look = 'wire';
  private bust: HeadBounds | null = null;
  /** The page picked the cloud's mode itself; the look's own default no longer applies. */
  private modeChosen = false;
  /** The head as measured in the bind pose, its bone, and the bone's bind pose inverted: the keep zones' frame. */
  private head: HeadBounds | null = null;
  private headBone: Object3D | null = null;
  private readonly headBind = new Matrix4();
  /** The head bone's movement since the bind pose, and the keep zones carried along with it each frame. */
  private readonly headDelta = new Matrix4();
  private readonly zonePoint = new Vector3();
  private readonly eyesZone: KeepZone = { x: 0, y: 0, z: 0, radius: 0 };
  private readonly mouthZone: KeepZone = { x: 0, y: 0, z: 0, radius: 0 };
  /** The pointer over the face in sensor uv, when it last moved and how fast (sensor frames a second, eased). */
  private readonly stirred = { u: 0.5, v: 0.5, at: Number.NEGATIVE_INFINITY, speed: 0 };
  private readonly stirRay = new Vector3();
  private readonly stirPoint = new Vector3();
  private readonly lips = new Vector3();

  constructor(options: CloudLayerOptions) {
    this.reducedMotion = options.reducedMotion;
    // The being's own depth: rendered from a fixed sensor camera at 30 Hz, unless a sensor or a video is given.
    this.depth = new BeingDepthSource({
      renderer: options.renderer,
      scene: options.scene,
      width: options.grid.cols,
      height: options.grid.rows,
      reducedMotion: options.reducedMotion,
    });
    this.cloud = new KinectCloud(options.shared, options.blending, {
      cols: options.grid.cols,
      rows: options.grid.rows,
      pixelRatio: options.pixelRatio,
      reducedMotion: options.reducedMotion,
    });
    // The kinect-demo shards ride a liquid skin simulated on the GPU: Emily's voice rings out from her lips, the
    // pointer stirs the surface, and a drop lands now and then. Nothing moves under reduced motion.
    this.fluid = new SurfaceFluid(options.renderer, { reducedMotion: options.reducedMotion });
    options.scene.add(this.cloud.points, this.cloud.mesh);
  }

  /** The head in the bind pose, its bone and that bone's bind pose inverted, for the keep zones. */
  setHead(head: HeadBounds, bone: Object3D | null, inverseBind: Matrix4): void {
    this.head = head;
    this.headBone = bone;
    this.headBind.copy(inverseBind);
  }

  /**
   * Place the cloud for a layout: the casters on the depth layer, the source, the mode the look wants (unless the
   * page chose one), the grid, the crop and the sensor.
   */
  apply(scene: CloudScene): void {
    const { look, grid, head, bust } = scene;
    this.look = look;
    this.bust = bust;
    this.external = scene.external;
    if (!this.modeChosen) this.cloud.setMode(look === 'kinect-demo' ? 'shards' : KINECT_DEFAULTS.mode);
    // With a sensor or a video the cloud is theirs, and the being's own depth pass has nothing to add.
    this.depth.setMeshes(scene.external ? [] : scene.casters);
    this.cloud.setSource(scene.external ?? this.depth);
    this.cloud.setGrid(grid.cols, grid.rows);
    this.depth.setSize(grid.cols, grid.rows);
    this.cloud.setEnabled(look !== 'wire');
    this.cloud.setCrop(bust ? bust.minY : null);
    // The sensor stands in front of the head in the face look and on its tripod before the figure otherwise; the
    // cloud's ramp is centred on what it looks at until the probe has measured the figure.
    const bounds = bust ?? head;
    if (bust) {
      this.depth.placeForBust(bust);
      this.cloud.setSubject(0, (bust.minY + bust.maxY) / 2, bust.centreZ);
    } else if (bounds) {
      this.depth.placeForHead(bounds);
      this.cloud.setSubject(0, bounds.minY + (bounds.maxY - bounds.minY) * EYE_LINE_SHARE, bounds.centreZ);
    } else {
      this.depth.placeForFigure();
      this.cloud.setSubject(0, 1, 0);
    }
  }

  /** One frame: the scatter, the keep zones, the depth, the liquid skin and the cloud itself. */
  update(frame: CloudFrame): void {
    const { dt, elapsed } = frame;
    this.cloud.setScatter(frame.scatter);
    // The eyes and the mouth travel with the head bone; the dropout leaves them alone.
    if ((this.look === 'face' || this.look === 'kinect-demo') && this.head) {
      if (this.headBone) this.headDelta.multiplyMatrices(this.headBone.matrixWorld, this.headBind);
      this.placeZone(this.eyesZone, EYES_ZONE);
      this.placeZone(this.mouthZone, MOUTH_ZONE);
      this.cloud.setKeepZones(this.eyesZone, this.mouthZone);
    } else {
      this.cloud.setKeepZones(null, null);
    }
    (this.external ?? this.depth).update(dt);
    // The liquid skin, for the kinect-demo shards cast from the being's own depth.
    if (this.look === 'kinect-demo' && !this.external && this.fluid.supported && this.cloud.showing()) {
      const sensor = this.depth.camera;
      this.lips.set(this.mouthZone.x, this.mouthZone.y, this.mouthZone.z).project(sensor);
      this.stirred.speed *= Math.exp(-dt / STIR_EASE_S);
      this.fluid.setDepth(this.depth.texture, 'perspective', sensor.near, sensor.far);
      this.fluid.update(dt, {
        voiceU: 0.5 * (this.lips.x + 1),
        voiceV: 0.5 * (this.lips.y + 1),
        voice: frame.voice,
        stirU: this.stirred.u,
        stirV: this.stirred.v,
        stir: this.stirred.speed,
      });
      this.cloud.setFluid(this.fluid.texture, FLUID_AMP_M, FLUID_TILT);
    } else {
      this.cloud.setFluid(null, 0, 0);
    }
    this.cloud.update(frame.camera, frame.distance, dt, elapsed);
  }

  /**
   * The pointer in -1..1 over the stage stirs the kinect-demo shards' liquid skin where its ray from the view camera
   * meets the front of the face, in proportion to its speed. Nothing under reduced motion or in other looks.
   */
  stir(x: number, y: number, camera: PerspectiveCamera): void {
    const bust = this.bust;
    if (this.reducedMotion || !this.fluid.supported || !bust || this.look !== 'kinect-demo') return;
    // The pointer's ray from the view camera meets the front of the face; the sensor sees that point at (u, v).
    this.stirRay.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
    if (Math.abs(this.stirRay.z) < 1e-4) return;
    const along = (bust.centreZ + FACE_FRONT_M - camera.position.z) / this.stirRay.z;
    if (!(along > 0)) return;
    this.stirPoint.copy(camera.position).addScaledVector(this.stirRay, along).project(this.depth.camera);
    const u = 0.5 * (this.stirPoint.x + 1);
    const v = 0.5 * (this.stirPoint.y + 1);
    const now = performance.now();
    const seconds = (now - this.stirred.at) / 1000;
    // A pause longer than a quarter second starts a new stroke rather than a leap across the face.
    if (seconds > 0 && seconds < 0.25) {
      this.stirred.speed = Math.max(this.stirred.speed, Math.hypot(u - this.stirred.u, v - this.stirred.v) / seconds);
    }
    this.stirred.u = u;
    this.stirred.v = v;
    this.stirred.at = now;
  }

  setPixelRatio(ratio: number): void {
    this.cloud.setPixelRatio(ratio);
  }

  /* The knobs (BeingHandle.kinect). */

  setClipping(nearM: number, farM: number): void {
    this.cloud.setClipping(nearM, farM);
  }

  setPointSize(px: number): void {
    this.cloud.setPointSize(px);
  }

  setZOffset(m: number): void {
    this.cloud.setZOffset(m);
  }

  setMode(mode: KinectMode): void {
    this.modeChosen = true;
    this.cloud.setMode(mode);
  }

  setDisplacement(value: number): void {
    this.cloud.setDisplacement(value);
  }

  setBrightness(value: number): void {
    this.cloud.setBrightness(value);
  }

  setContrast(value: number): void {
    this.cloud.setContrast(value);
  }

  setOpacity(value: number): void {
    this.cloud.setOpacity(value);
  }

  setLineWidth(px: number): void {
    this.cloud.setLineWidth(px);
  }

  setRipple(metres: number): void {
    this.cloud.setRipple(metres);
  }

  /* The HUD's readings (BeingHandle.stats). */

  /** The grid's points while the cloud draws, 0 otherwise. */
  points(): number {
    return this.cloud.showing() ? this.cloud.count() : 0;
  }

  clippingRange(): DepthClipping {
    return this.cloud.clippingRange();
  }

  mode(): KinectMode {
    return this.cloud.mode();
  }

  dispose(): void {
    this.cloud.dispose();
    this.fluid.dispose();
    // An external source belongs to whoever made it.
    this.depth.dispose();
    this.external = null;
  }

  /** A keep zone from the head's bind-pose bounds, moved with the head bone. */
  private placeZone(zone: KeepZone, shape: { up: number; forward: number; radius: number }): void {
    const bounds = this.head;
    if (!bounds) return;
    const h = Math.max(0.05, bounds.maxY - bounds.minY);
    this.zonePoint.set(0, bounds.minY + shape.up * h, bounds.centreZ + shape.forward * h).applyMatrix4(this.headDelta);
    zone.x = this.zonePoint.x;
    zone.y = this.zonePoint.y;
    zone.z = this.zonePoint.z;
    zone.radius = shape.radius * h;
  }
}
