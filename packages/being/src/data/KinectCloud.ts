import {
  type Blending,
  BufferAttribute,
  BufferGeometry,
  type IUniform,
  Mesh,
  NormalBlending,
  type PerspectiveCamera,
  Points,
  ShaderMaterial,
  Sphere,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { kinectFrag } from '../avatar/shaders/kinect.frag.glsl.ts';
import { kinectVert } from '../avatar/shaders/kinect.vert.glsl.ts';
import { kinectGridFrag } from '../avatar/shaders/kinectGrid.frag.glsl.ts';
import { kinectGridVert } from '../avatar/shaders/kinectGrid.vert.glsl.ts';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';
import type { KinectMode } from '../types.ts';
import { blankDepthTexture, type DepthEncoding, type DepthSource } from './depth/DepthSource.ts';
import {
  type CloudGrid,
  cameraTangents,
  DEFAULT_CLIPPING,
  type DepthClipping,
  DROPOUT_HZ,
  POINT_CSS_PX,
  sensorFrame,
} from './depth/depthMath.ts';
import { GRID_LATTICE, gridVertexCount } from './kinectGrid.ts';

export interface KinectCloudOptions extends CloudGrid {
  pixelRatio?: number;
  /** Freezes the sensor and dropout clocks: no dither and no dropout crossfade, so nothing flickers. */
  reducedMotion?: boolean;
  /** Point diameter in CSS pixels for a point at the view camera's reference distance; smaller further away. */
  pointSize?: number;
}

/**
 * The cloud's knobs and their starting values: the triangle modes and the brightness, contrast and opacity terms
 * are Three-Kinectron's, with its defaults. `displacement` is not: there it scales the alpha channel into a z
 * extrusion (its code uses 2.0), here it is the relief about the figure's distance, and 1 is true to the depth.
 */
export const KINECT_DEFAULTS: Readonly<{
  mode: KinectMode;
  displacement: number;
  brightness: number;
  contrast: number;
  opacity: number;
  /** Stroke width of the wire mode, in pixels of the drawing buffer like the wire being's own. */
  lineWidth: number;
}> = { mode: 'points', displacement: 1, brightness: 0, contrast: 1, opacity: 1, lineWidth: 1.2 };

/** A sphere the dropout leaves alone, in world space. */
export interface KeepZone {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** The uniforms both materials share; each gets its own uMirror on top. */
type CloudUniforms = {
  uDepth: IUniform<Texture>;
  uGrid: IUniform<Vector2>;
  uLattice: IUniform<Vector2>;
  uNear: IUniform<number>;
  uFar: IUniform<number>;
  uEncoding: IUniform<number>;
  uTangents: IUniform<Vector2>;
  uPointScale: IUniform<number>;
  uZOffset: IUniform<number>;
  uTime: SharedUniforms['uTime'];
  uScatter: IUniform<number>;
  uRamp: IUniform<Vector2>;
  uMode: IUniform<number>;
  uLineWidth: IUniform<number>;
  uDisplacement: IUniform<number>;
  uBrightness: IUniform<number>;
  uContrast: IUniform<number>;
  uKinectOpacity: IUniform<number>;
  uFrame: IUniform<number>;
  uDropFrame: IUniform<number>;
  uDropMix: IUniform<number>;
  uQuantise: IUniform<number>;
  uMaskA: IUniform<Vector4>;
  uMaskB: IUniform<Vector4>;
  uShrink: IUniform<number>;
  uMinY: IUniform<number>;
  uMirrorPlane: SharedUniforms['uMirrorPlane'];
  uViewport: SharedUniforms['uViewport'];
  uDot: SharedUniforms['uDot'];
  uWire: SharedUniforms['uWire'];
  uGlow: SharedUniforms['uGlow'];
  uBg: SharedUniforms['uBg'];
  uIsLight: SharedUniforms['uIsLight'];
  uOpacity: SharedUniforms['uOpacity'];
};

/** Point diameter in CSS pixels at the view camera's reference distance (the recipe's 1.6). */
export const DEFAULT_POINT_SIZE_PX = POINT_CSS_PX;
/** Half the depth the colour ramp spans around the figure, in metres, until the depth pass has measured it. */
const RAMP_HALF_M = 0.35;
/** The ramp eases toward each new measurement over this time. */
const RAMP_EASE_S = 0.5;
/** The shards' ramp about the sensor's subject, in metres toward and away from the sensor. */
const SHARD_RAMP_M = { near: 0.14, far: 0.22 } as const;
/** A stand-alone sensor is imagined on a tripod at this height, level, facing the figure. */
const SENSOR_HEIGHT_M = 1;
/** For a sensor source, a surface this far from it stands on the figure's axis unless setZOffset says otherwise. */
const SENSOR_Z_OFFSET_M = 2;
const ENCODING: Readonly<Record<DepthEncoding, number>> = { perspective: 0, grey: 1, metres: 2 };
/** A keep zone nowhere, so the mask never bites until setKeepZones() places it. */
const NO_ZONE = new Vector4(0, -1000, 0, 0);
/** A crop height nothing lies under. */
const NO_CROP = -1000;
/** How far each shard is pulled toward its centroid: the hairline gaps that part the lattice into facets. */
export const SHARD_SHRINK = 0.2;

/**
 * The kinect cloud: a dense regular grid that back-projects the current DepthSource the way three's
 * webgl_video_kinect example does, drawn as points (the default), as wire triangles or as a solid metallic mesh
 * (Three-Kinectron's modes; they sample a fixed 160 x 120 lattice), or as shards, the point grid's own lattice of
 * tiny separate facets. A perspective source (the
 * being's own depth) places the cloud with its sensor camera's lens and transform; a grey or metric source stands
 * where the figure stands, seen from a virtual sensor one metre up. Nothing here writes depth, and the cloud draws
 * under the wire.
 */
export class KinectCloud {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  /** The triangle modes' object; hidden while the mode is points. */
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly uniforms: CloudUniforms;
  private readonly reducedMotion: boolean;
  private source: DepthSource | null = null;
  private cols: number;
  private rows: number;
  private pointSize: number;
  private pixelRatio: number;
  private modeValue: KinectMode = KINECT_DEFAULTS.mode;
  /** An explicit z offset, or null for the default of the source kind. */
  private zOffset: number | null = null;
  private clipping: DepthClipping = { ...DEFAULT_CLIPPING };
  private active: DepthClipping = { near: 0, far: 0 };
  private ramp: DepthClipping | null = null;
  private enabled = true;
  /** Every cell a miss: what the cloud samples until its source has a frame. */
  private readonly blank = blankDepthTexture();
  /** What the sensor looks at: the ramp's centre until the probe has measured the figure. */
  private readonly subject = new Vector3(0, 1, 0);

  constructor(shared: SharedUniforms, blending: Blending, options: KinectCloudOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.reducedMotion = options.reducedMotion === true;
    this.pointSize = options.pointSize ?? DEFAULT_POINT_SIZE_PX;
    this.pixelRatio = options.pixelRatio ?? 1;
    this.uniforms = {
      uDepth: { value: this.blank },
      uGrid: { value: new Vector2(this.cols, this.rows) },
      uLattice: { value: new Vector2(GRID_LATTICE.cols, GRID_LATTICE.rows) },
      uNear: { value: 0.1 },
      uFar: { value: 50 },
      uEncoding: { value: 0 },
      uTangents: { value: new Vector2(1, 1) },
      uPointScale: { value: 0 },
      uZOffset: { value: 0 },
      uTime: shared.uTime,
      uScatter: { value: 0 },
      uRamp: { value: new Vector2(3, 4) },
      uMode: { value: 0 },
      uLineWidth: { value: KINECT_DEFAULTS.lineWidth },
      uDisplacement: { value: KINECT_DEFAULTS.displacement },
      uBrightness: { value: KINECT_DEFAULTS.brightness },
      uContrast: { value: KINECT_DEFAULTS.contrast },
      uKinectOpacity: { value: KINECT_DEFAULTS.opacity },
      uFrame: { value: 0 },
      uDropFrame: { value: 0 },
      uDropMix: { value: 0 },
      uQuantise: { value: 0 },
      uMaskA: { value: NO_ZONE.clone() },
      uMaskB: { value: NO_ZONE.clone() },
      uShrink: { value: SHARD_SHRINK },
      uMinY: { value: NO_CROP },
      uMirrorPlane: shared.uMirrorPlane,
      uViewport: shared.uViewport,
      uDot: shared.uDot,
      uWire: shared.uWire,
      uGlow: shared.uGlow,
      uBg: shared.uBg,
      uIsLight: shared.uIsLight,
      uOpacity: shared.uOpacity,
    };
    const common = { transparent: true, depthWrite: false, depthTest: false, blending } as const;
    const material = new ShaderMaterial({
      ...common,
      uniforms: { ...this.uniforms, uMirror: { value: 0 } },
      vertexShader: kinectVert,
      fragmentShader: kinectFrag,
    });
    material.name = 'KinectCloud';
    this.points = new Points(gridGeometry(this.cols * this.rows), material);
    const gridMaterial = new ShaderMaterial({
      ...common,
      uniforms: { ...this.uniforms, uMirror: { value: 0 } },
      vertexShader: kinectGridVert,
      fragmentShader: kinectGridFrag,
    });
    gridMaterial.name = 'KinectGrid';
    this.mesh = new Mesh(gridGeometry(gridVertexCount(GRID_LATTICE)), gridMaterial);
    this.mesh.visible = false;
    for (const object of [this.points, this.mesh]) {
      object.matrixAutoUpdate = false;
      object.frustumCulled = false;
      // Under the being: the wire writes no depth, so draw order is the only layering there is.
      object.renderOrder = -1;
    }
  }

  get material(): ShaderMaterial {
    return this.points.material;
  }

  get gridMaterial(): ShaderMaterial {
    return this.mesh.material;
  }

  setSource(source: DepthSource | null): void {
    if (source === this.source) return;
    this.source = source;
    // The next frame's measurement sets the ramp outright rather than easing from the old source's.
    this.ramp = null;
  }

  /** Clipping in metres for grey and metric sources (video, Kinectron); a being source always uses its sensor's. */
  setClipping(nearM: number, farM: number): void {
    if (!(nearM > 0) || !(farM > nearM)) return;
    this.clipping = { near: nearM, far: farM };
    this.source?.setClipping?.(nearM, farM);
  }

  /**
   * The range reported for this frame: the metres the colour ramp spans for the being's own depth (as measured by
   * its depth pass), the clipping for a sensor or video source.
   */
  clippingRange(): DepthClipping {
    return { ...this.active };
  }

  setPointSize(px: number): void {
    if (Number.isFinite(px) && px > 0) this.pointSize = px;
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }

  /** Metres added along the depth axis; for a sensor source, the distance at which a surface stands on the axis. */
  setZOffset(m: number): void {
    this.zOffset = Number.isFinite(m) ? m : null;
  }

  setScatter(value: number): void {
    this.uniforms.uScatter.value = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /** The eyes and the mouth: spheres in world space the dropout never touches; null clears one. */
  setKeepZones(eyes: KeepZone | null, mouth: KeepZone | null): void {
    const set = (u: IUniform<Vector4>, zone: KeepZone | null): void => {
      if (zone) u.value.set(zone.x, zone.y, zone.z, Math.max(0, zone.radius));
      else u.value.copy(NO_ZONE);
    };
    set(this.uniforms.uMaskA, eyes);
    set(this.uniforms.uMaskB, mouth);
  }

  setMode(mode: KinectMode): void {
    this.modeValue = mode;
    this.uniforms.uMode.value = mode === 'shards' ? 2 : mode === 'mesh' ? 1 : 0;
    this.applyLattice();
  }

  /** Nothing below this world height is drawn (the head-and-shoulders crop); null draws everything. */
  setCrop(minY: number | null): void {
    this.uniforms.uMinY.value = minY !== null && Number.isFinite(minY) ? minY : NO_CROP;
  }

  /** The lattice the triangle modes draw: the point grid itself for shards, the fixed 160 x 120 otherwise. */
  private lattice(): CloudGrid {
    return this.modeValue === 'shards' ? { cols: this.cols, rows: this.rows } : GRID_LATTICE;
  }

  private applyLattice(): void {
    const lattice = this.lattice();
    const lu = this.uniforms.uLattice.value;
    if (lu.x === lattice.cols && lu.y === lattice.rows) return;
    lu.set(lattice.cols, lattice.rows);
    this.mesh.geometry.dispose();
    this.mesh.geometry = gridGeometry(gridVertexCount(lattice));
  }

  mode(): KinectMode {
    return this.modeValue;
  }

  /** Depth relief about the figure's distance; 1 is true to the depth. */
  setDisplacement(value: number): void {
    if (Number.isFinite(value) && value > 0) this.uniforms.uDisplacement.value = Math.min(8, value);
  }

  setBrightness(value: number): void {
    if (Number.isFinite(value)) this.uniforms.uBrightness.value = Math.min(1, Math.max(-1, value));
  }

  setContrast(value: number): void {
    if (Number.isFinite(value) && value >= 0) this.uniforms.uContrast.value = Math.min(8, value);
  }

  setOpacity(value: number): void {
    if (Number.isFinite(value)) this.uniforms.uKinectOpacity.value = Math.min(1, Math.max(0, value));
  }

  /** Stroke width of the wire mode, in pixels. */
  setLineWidth(px: number): void {
    if (Number.isFinite(px) && px > 0) this.uniforms.uLineWidth.value = Math.min(12, px);
  }

  setGrid(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.uniforms.uGrid.value.set(cols, rows);
    this.points.geometry.dispose();
    this.points.geometry = gridGeometry(cols * rows);
    this.applyLattice();
  }

  grid(): CloudGrid {
    return { cols: this.cols, rows: this.rows };
  }

  /** Points in the grid being drawn: the point grid, or the triangle modes' lattice. */
  count(): number {
    const lattice = this.modeValue === 'points' ? { cols: this.cols, rows: this.rows } : this.lattice();
    return lattice.cols * lattice.rows;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.points.visible = false;
      this.mesh.visible = false;
    }
  }

  /** True while the cloud has a frame to draw. */
  showing(): boolean {
    return this.enabled && this.source?.ready === true;
  }

  /**
   * Place the cloud for this frame. `view` is the camera that draws the frame and `refDistanceM` its distance to
   * the subject (the head's centre in the face look, the figure's axis otherwise): a point there is the asked-for
   * size. Call after the source's update and before the render.
   */
  update(view: PerspectiveCamera, refDistanceM: number, dt: number, elapsedS: number): void {
    const source = this.source;
    const u = this.uniforms;
    // Disabled, the cloud is not drawn at all. Waiting for a frame, it draws its grid against the blank texture,
    // every point parked outside the clip volume: no pixels, but the program is linked before the first frame
    // rather than when the figure appears.
    const asPoints = this.modeValue === 'points';
    this.points.visible = this.enabled && asPoints;
    this.mesh.visible = this.enabled && !asPoints;
    // Wire triangles and shards blend like the points (the theme keeps that material current); a solid mesh occludes.
    this.mesh.material.blending = this.modeValue === 'mesh' ? NormalBlending : this.points.material.blending;
    if (!this.enabled) return;
    if (!source?.ready) {
      u.uDepth.value = this.blank;
      return;
    }
    u.uDepth.value = source.texture;
    u.uEncoding.value = ENCODING[source.encoding];
    // Size: max(1, 1.6 css px * dpr * refDist / dist), the division happening per point in the shader.
    u.uPointScale.value = this.pointSize * this.pixelRatio * Math.max(refDistanceM, 0.05);
    // The clocks: the sensor frame keys the dither, the dropout mask crossfades between two frames at 10 Hz.
    const frozen = this.reducedMotion;
    u.uFrame.value = source.frame?.() ?? sensorFrame(elapsedS, frozen);
    const drop = frozen ? 0 : elapsedS * DROPOUT_HZ;
    u.uDropFrame.value = Math.floor(drop);
    u.uDropMix.value = frozen ? 0 : drop - Math.floor(drop);
    const sensor = source.camera;
    if (sensor) {
      // A perspective source: the sensor's lens and transform, and the quantisation a sensor would have applied.
      u.uQuantise.value = 1;
      u.uNear.value = sensor.near;
      u.uFar.value = sensor.far;
      const t = cameraTangents(sensor.fov, sensor.aspect);
      u.uTangents.value.set(t.x, t.y);
      u.uZOffset.value = this.zOffset ?? 0;
      // The ramp spans what the depth pass measured of the figure, nearest to farthest from the sensor, easing to
      // each new reading; a fixed band around the sensor's distance to its target stands in until the first lands.
      const measured = source.range?.() ?? null;
      const reference = sensor.position.distanceTo(this.subject);
      // Shards span a fixed band about the subject instead: the face from ice-white at the nose to navy behind the
      // shoulders, whatever else the probe saw.
      const shards = this.modeValue === 'shards';
      const near = shards ? reference - SHARD_RAMP_M.near : measured ? measured.near : reference - RAMP_HALF_M;
      const far = shards ? reference + SHARD_RAMP_M.far : measured ? measured.far : reference + RAMP_HALF_M;
      if (this.ramp) {
        const k = 1 - Math.exp(-dt / RAMP_EASE_S);
        this.ramp.near += (near - this.ramp.near) * k;
        this.ramp.far += (far - this.ramp.far) * k;
      } else {
        this.ramp = { near, far };
      }
      u.uRamp.value.set(this.ramp.near, this.ramp.far);
      this.points.matrix.copy(sensor.matrixWorld);
      this.active = { near: this.ramp.near, far: this.ramp.far };
    } else {
      // A grey or metric source: real sensor data is already quantised.
      u.uQuantise.value = 0;
      const zOffset = this.zOffset ?? SENSOR_Z_OFFSET_M;
      u.uNear.value = this.clipping.near;
      u.uFar.value = this.clipping.far;
      const tangents = source.fovTangents ?? cameraTangents(view.fov, view.aspect);
      u.uTangents.value.set(tangents.x, tangents.y);
      u.uZOffset.value = zOffset;
      u.uRamp.value.set(zOffset - RAMP_HALF_M, zOffset + RAMP_HALF_M);
      this.points.matrix.makeTranslation(0, SENSOR_HEIGHT_M, 0);
      this.active = this.clipping;
    }
    this.points.matrixWorldNeedsUpdate = true;
    this.mesh.matrix.copy(this.points.matrix);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  /** Where the sensor's ramp is centred until the probe has measured the figure. */
  setSubject(x: number, y: number, z: number): void {
    this.subject.set(x, y, z);
  }

  dispose(): void {
    for (const object of [this.points, this.mesh]) {
      object.geometry.dispose();
      object.material.dispose();
      object.removeFromParent();
    }
    this.blank.dispose();
    this.source = null;
  }
}

/**
 * One byte per vertex. The shaders take the cell from gl_VertexID, so the attribute only has to exist and have the
 * right count: a single byte per point (or per grid vertex) rather than three floats.
 */
function gridGeometry(count: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Uint8Array(count), 1));
  // The renderer sorts transparent objects by their bounding sphere; the attribute cannot yield one, so the
  // figure's own bounds stand in.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0.9, 0), 1.5);
  return geometry;
}
