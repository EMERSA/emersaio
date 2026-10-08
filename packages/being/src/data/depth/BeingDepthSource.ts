import {
  DepthTexture,
  DoubleSide,
  type Material,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type { HeadBounds } from '../../stage/framing.ts';
import type { DepthSource } from './DepthSource.ts';
import {
  type DepthClipping,
  decodeDepthProbe,
  EYE_LINE_SHARE,
  PROBE_RANGE_M,
  SENSOR_BUST,
  SENSOR_FACE,
  SENSOR_FIGURE,
  sensorFrame,
} from './depthMath.ts';

/** The layer the depth camera looks at; only the meshes that cast the cloud are on it. */
export const DEPTH_LAYER = 1;

/** The probe that measures the figure's range: this many cells, each the nearest and farthest surface of its block. */
export const PROBE_CELLS = { cols: 16, rows: 12 } as const;
/** How often the probe reads the depth back; the colour ramp eases between readings. */
export const PROBE_INTERVAL_MS = 500;

export interface BeingDepthSourceOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  width: number;
  height: number;
  /** Freezes the sensor clock: the depth is rendered every frame and the hash frame stays 0, so nothing dithers. */
  reducedMotion?: boolean;
}

const probeVert = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * One output cell per block of depth texels: the nearest and farthest distance in the block, each packed into two
 * bytes as a share of uRange. A block that saw nothing packs 1 as its nearest and 0 as its farthest.
 */
const probeFrag = /* glsl */ `
#include <packing>

uniform sampler2D uDepth;
uniform vec2 uSize;
uniform vec2 uCells;
uniform float uNear;
uniform float uFar;
uniform float uRange;

void main() {
  vec2 block = ceil(uSize / uCells);
  vec2 origin = floor(gl_FragCoord.xy) * block;
  float lo = 1e9;
  float hi = 0.0;
  for (int y = 0; y < 64; y++) {
    if (float(y) >= block.y) break;
    for (int x = 0; x < 64; x++) {
      if (float(x) >= block.x) break;
      vec2 texel = origin + vec2(x, y);
      if (texel.x >= uSize.x || texel.y >= uSize.y) continue;
      float s = texture2D(uDepth, (texel + 0.5) / uSize).r;
      if (s < 0.9999) {
        float d = -perspectiveDepthToViewZ(s, uNear, uFar);
        lo = min(lo, d);
        hi = max(hi, d);
      }
    }
  }
  gl_FragColor = vec4(packDepthToRG(clamp(lo / uRange, 0.0, 1.0)), packDepthToRG(clamp(hi / uRange, 0.0, 1.0)));
}
`;

/**
 * The being's own depth as a source: the meshes handed to setMeshes() are drawn once more, through a fixed sensor
 * camera of this source's own and into a small depth target, with a material that writes depth and no colour. The
 * main render never sees the pass: the sensor camera looks at DEPTH_LAYER alone, where only those meshes live.
 *
 * The sensor is separate from the view camera on purpose (docs/research/kinectron-study.md): the view eases after
 * the pointer, the sensor stands still about 1.05 m from the face and 7 degrees below the eye line (or on a tripod
 * in front of the whole figure), and the depth is re-rendered only when floor(t * 30) changes. Every quantisation
 * step and dropout then lines up with the sensor's rays, not the viewer's, which is what a capture looks like.
 *
 * Twice a second a 16 x 12 probe reduces the depth target to the figure's nearest and farthest distance from the
 * sensor and reads it back asynchronously; range() reports the last reading for the colour ramp and the HUD.
 */
export class BeingDepthSource implements DepthSource {
  readonly kind = 'being' as const;
  readonly encoding = 'perspective' as const;
  readonly fovTangents = null;
  /** The fixed sensor camera. Its aspect follows the texture, so one texel is one cell of the cloud. */
  readonly camera = new PerspectiveCamera(SENSOR_FIGURE.fovDeg, 4 / 3, 0.1, 50);
  texture: DepthTexture;
  width: number;
  height: number;
  ready = false;
  private target: WebGLRenderTarget;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly reducedMotion: boolean;
  /**
   * Both sides: the head mesh is open at the eyes and the mouth, and with back faces culled the sensor saw nothing
   * through them (black slots in the face). Drawn double-sided it records the inner shell behind each opening, so
   * those cells draw as recessed, dimmer shards and the mouth still opens and closes with the lip sync.
   */
  private readonly depthMaterial = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });
  private meshes: Mesh[] = [];
  private readonly saved: Array<Material | Material[]> = [];
  private readonly probe = new WebGLRenderTarget(PROBE_CELLS.cols, PROBE_CELLS.rows, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  private readonly probeScene = new Scene();
  private readonly probeQuad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly pixels = new Uint8Array(PROBE_CELLS.cols * PROBE_CELLS.rows * 4);
  private readonly lookTarget = new Vector3();
  private measured: DepthClipping | null = null;
  private lastProbe = Number.NEGATIVE_INFINITY;
  private reading = false;
  private clock = 0;
  private rendered = -1;

  constructor(options: BeingDepthSourceOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.reducedMotion = options.reducedMotion === true;
    this.width = options.width;
    this.height = options.height;
    this.texture = new DepthTexture(this.width, this.height);
    this.target = createTarget(this.texture, this.width, this.height);
    this.camera.layers.set(DEPTH_LAYER);
    this.placeForFigure();
    const material = new ShaderMaterial({
      uniforms: {
        uDepth: { value: this.texture },
        uSize: { value: new Vector2(this.width, this.height) },
        uCells: { value: new Vector2(PROBE_CELLS.cols, PROBE_CELLS.rows) },
        uNear: { value: this.camera.near },
        uFar: { value: this.camera.far },
        uRange: { value: PROBE_RANGE_M },
      },
      vertexShader: probeVert,
      fragmentShader: probeFrag,
      depthTest: false,
      depthWrite: false,
    });
    material.name = 'DepthProbe';
    this.probeQuad = new Mesh(new PlaneGeometry(2, 2), material);
    this.probeQuad.frustumCulled = false;
    this.probeScene.add(this.probeQuad);
  }

  /** The meshes that cast the cloud; they join the depth layer and the previous ones leave it. */
  setMeshes(meshes: Mesh[]): void {
    for (const mesh of this.meshes) mesh.layers.disable(DEPTH_LAYER);
    this.meshes = meshes;
    for (const mesh of meshes) mesh.layers.enable(DEPTH_LAYER);
    this.rendered = -1;
    if (meshes.length === 0) {
      this.ready = false;
      this.measured = null;
    }
  }

  /** Match the cloud's grid: one texel per cell. The sensor's aspect follows. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.target.dispose();
    this.texture.dispose();
    this.width = width;
    this.height = height;
    this.texture = new DepthTexture(width, height);
    this.target = createTarget(this.texture, width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.ready = false;
    this.rendered = -1;
  }

  /**
   * Stand the sensor in front of the head: SENSOR_FACE.distanceM from the eye line along the figure's facing (+Z)
   * and SENSOR_FACE.belowEyeDeg below it, looking at the eyes, with a lens just wide enough for the head.
   */
  placeForHead(head: HeadBounds): void {
    const eyeY = head.minY + (head.maxY - head.minY) * EYE_LINE_SHARE;
    const down = (SENSOR_FACE.belowEyeDeg * Math.PI) / 180;
    this.place(
      new Vector3(
        0,
        eyeY - SENSOR_FACE.distanceM * Math.sin(down),
        head.centreZ + SENSOR_FACE.distanceM * Math.cos(down),
      ),
      new Vector3(0, eyeY, head.centreZ),
      SENSOR_FACE.fovDeg,
    );
  }

  /** Stand the sensor in front of the head and shoulders (the kinect-demo look), looking at their centre. */
  placeForBust(bust: HeadBounds): void {
    const y = (bust.minY + bust.maxY) / 2;
    const down = (SENSOR_BUST.belowDeg * Math.PI) / 180;
    this.place(
      new Vector3(0, y - SENSOR_BUST.distanceM * Math.sin(down), bust.centreZ + SENSOR_BUST.distanceM * Math.cos(down)),
      new Vector3(0, y, bust.centreZ),
      SENSOR_BUST.fovDeg,
    );
  }

  /** The tripod in front of the whole figure (the hybrid and kinect looks). */
  placeForFigure(): void {
    this.place(
      new Vector3(0, SENSOR_FIGURE.heightM, SENSOR_FIGURE.distanceM),
      new Vector3(0, SENSOR_FIGURE.lookAtY, 0),
      SENSOR_FIGURE.fovDeg,
    );
  }

  /** The figure's nearest and farthest distance from the sensor at the last probe, or null before the first. */
  range(): DepthClipping | null {
    return this.measured;
  }

  /** The sensor frame the texture holds: the hash key of the dither, 0 under reduced motion. */
  frame(): number {
    return sensorFrame(this.clock, this.reducedMotion);
  }

  update(dt: number): void {
    if (this.meshes.length === 0) return;
    this.clock += Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const frame = this.frame();
    // The sensor clock: a new depth frame only when floor(t * 30) changes. Reduced motion freezes the hash frame
    // and renders every tick instead, so a still head has no clock to show.
    if (!this.reducedMotion && frame === this.rendered && this.ready) return;
    this.rendered = frame;
    const { renderer, scene, camera } = this;
    camera.updateMatrixWorld();
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      if (!mesh) continue;
      this.saved[i] = mesh.material;
      mesh.material = this.depthMaterial;
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      const material = this.saved[i];
      if (mesh && material) mesh.material = material;
    }
    this.ready = true;
    this.measure(performance.now());
  }

  dispose(): void {
    this.setMeshes([]);
    this.target.dispose();
    this.texture.dispose();
    this.depthMaterial.dispose();
    this.probe.dispose();
    this.probeQuad.geometry.dispose();
    this.probeQuad.material.dispose();
  }

  private place(position: Vector3, lookAt: Vector3, fov: number): void {
    this.camera.position.copy(position);
    this.lookTarget.copy(lookAt);
    this.camera.lookAt(this.lookTarget);
    this.camera.fov = fov;
    this.camera.aspect = this.width / Math.max(1, this.height);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.rendered = -1;
  }

  /** Reduce the depth target to the probe and read it back, at most twice a second and never two reads at once. */
  private measure(now: number): void {
    if (this.reading || now - this.lastProbe < PROBE_INTERVAL_MS) return;
    this.lastProbe = now;
    const { renderer, camera } = this;
    const u = this.probeQuad.material.uniforms;
    if (u.uDepth) u.uDepth.value = this.texture;
    (u.uSize?.value as Vector2 | undefined)?.set(this.width, this.height);
    if (u.uNear) u.uNear.value = camera.near;
    if (u.uFar) u.uFar.value = camera.far;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.probe);
    renderer.render(this.probeScene, camera);
    renderer.setRenderTarget(previous);
    this.reading = true;
    const settle = (): void => {
      this.reading = false;
    };
    renderer.readRenderTargetPixelsAsync(this.probe, 0, 0, PROBE_CELLS.cols, PROBE_CELLS.rows, this.pixels).then(() => {
      settle();
      this.measured = decodeDepthProbe(this.pixels);
    }, settle);
  }
}

function createTarget(depthTexture: DepthTexture, width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    depthTexture,
    depthBuffer: true,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
}
