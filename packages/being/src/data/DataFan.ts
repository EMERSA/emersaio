import {
  type Blending,
  BufferAttribute,
  BufferGeometry,
  type IUniform,
  LineSegments,
  Matrix4,
  type Object3D,
  type PerspectiveCamera,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { fanLineFrag, fanLineVert, fanNodeFrag, fanNodeVert } from '../avatar/shaders/fan.glsl.ts';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';
import type { FanTarget } from '../types.ts';
import {
  DEFAULT_FAN_TARGETS,
  FAN_LINE_ALPHA,
  FAN_LINES,
  FAN_MAX_TARGETS,
  FAN_NODE_PX,
  projectToPlane,
} from './fanMath.ts';

export interface DataFanOptions {
  /** Static lines and no packets. */
  reducedMotion?: boolean;
  pixelRatio?: number;
}

/** The flow eases toward its goal with this time constant. */
const ACTIVITY_EASE_S = 0.3;

/**
 * The data fan of the face look (reference 5.png): 120 hairlines from static points on the head's surface
 * (transformed by the head bone each frame) to four small ice nodes the runtime fixes down the right edge of the
 * canvas (fanMath.ts), on a plane 0.3 m in front of the head. At rest the lines stand still and faint; while the
 * being speaks small packets travel along them. Everything is drawn in the --fan colour, additive on dark and
 * normal on light like the rest of the being.
 */
export class DataFan {
  readonly lines: LineSegments<BufferGeometry, ShaderMaterial>;
  readonly nodes: Points<BufferGeometry, ShaderMaterial>;
  private readonly uHead: IUniform<Matrix4> = { value: new Matrix4() };
  private readonly uTargets: IUniform<Vector3[]> = {
    value: Array.from({ length: FAN_MAX_TARGETS }, () => new Vector3()),
  };
  private readonly uCount: IUniform<number> = { value: 0 };
  private readonly uActivity: IUniform<number> = { value: 0 };
  private readonly uPointSize: IUniform<number>;
  private readonly bindInverse = new Matrix4();
  private readonly nodePositions: BufferAttribute;
  private readonly reducedMotion: boolean;
  private targets: FanTarget[] = [...DEFAULT_FAN_TARGETS];
  private enabled = true;
  private allowed = false;
  private manual = 0;
  private activity = 0;

  constructor(shared: SharedUniforms, blending: Blending, options: DataFanOptions = {}) {
    this.reducedMotion = options.reducedMotion === true;
    this.uPointSize = { value: FAN_NODE_PX * (options.pixelRatio ?? 1) };
    const common = {
      uFan: shared.uFan,
      uTime: shared.uTime,
      uActivity: this.uActivity,
      uFlow: { value: this.reducedMotion ? 0 : 1 },
      uOpacity: shared.uOpacity,
      uIsLight: shared.uIsLight,
    };
    const lineMaterial = new ShaderMaterial({
      uniforms: {
        ...common,
        uHead: this.uHead,
        uTargets: this.uTargets,
        uCount: this.uCount,
        uLineAlpha: { value: FAN_LINE_ALPHA },
      },
      vertexShader: fanLineVert,
      fragmentShader: fanLineFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    lineMaterial.name = 'FanLines';
    const nodeMaterial = new ShaderMaterial({
      uniforms: { ...common, uPointSize: this.uPointSize, uWire: shared.uWire },
      vertexShader: fanNodeVert,
      fragmentShader: fanNodeFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    nodeMaterial.name = 'FanNodes';

    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(new Float32Array(FAN_LINES * 6), 3));
    const ends = new Float32Array(FAN_LINES * 2);
    const numbers = new Float32Array(FAN_LINES * 2);
    for (let i = 0; i < FAN_LINES; i += 1) {
      ends[i * 2 + 1] = 1;
      numbers[i * 2] = i;
      numbers[i * 2 + 1] = i;
    }
    lines.setAttribute('aEnd', new BufferAttribute(ends, 1));
    lines.setAttribute('aLine', new BufferAttribute(numbers, 1));
    this.lines = new LineSegments(lines, lineMaterial);
    const nodes = new BufferGeometry();
    this.nodePositions = new BufferAttribute(new Float32Array(FAN_MAX_TARGETS * 3), 3);
    nodes.setAttribute('position', this.nodePositions);
    this.nodes = new Points(nodes, nodeMaterial);
    for (const object of [this.lines, this.nodes]) {
      object.frustumCulled = false;
      // Over the wire and the cloud: the lines leave the surface toward the viewer.
      object.renderOrder = 2;
      object.visible = false;
    }
  }

  get lineMaterial(): ShaderMaterial {
    return this.lines.material;
  }

  get nodeMaterial(): ShaderMaterial {
    return this.nodes.material;
  }

  /** The line starts (three floats each, bind-pose world space) and the head bone's world matrix in that pose. */
  setPoints(points: Float32Array, headBind: Matrix4): void {
    const position = this.lines.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < FAN_LINES; i += 1) {
      const x = points[i * 3] ?? 0;
      const y = points[i * 3 + 1] ?? 0;
      const z = points[i * 3 + 2] ?? 0;
      position.setXYZ(i * 2, x, y, z);
      position.setXYZ(i * 2 + 1, x, y, z);
    }
    position.needsUpdate = true;
    this.bindInverse.copy(headBind).invert();
  }

  setTargets(targets: FanTarget[]): void {
    this.targets = targets
      .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y))
      .slice(0, FAN_MAX_TARGETS)
      .map((t) => ({ x: Math.min(1, Math.max(-1, t.x)), y: Math.min(1, Math.max(-1, t.y)) }));
  }

  /** Flow strength asked for from outside; the runtime's own raise (speaking, tokens) is handed to update(). */
  setActivity(value: number): void {
    this.manual = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /** The page's switch. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** The look's and the tier's say: the fan belongs to the face look and never to the lite tier. */
  setAllowed(on: boolean): void {
    this.allowed = on;
  }

  setPixelRatio(ratio: number): void {
    this.uPointSize.value = FAN_NODE_PX * ratio;
  }

  /**
   * Place the nodes for this frame's camera, move the line starts with the head and ease the flow. `raise` is the
   * runtime's own activity (speaking, streaming tokens); the larger of it and the value set from outside wins.
   */
  update(camera: PerspectiveCamera, headBone: Object3D | null, planeZ: number, raise: number, dt: number): void {
    const visible = this.enabled && this.allowed && this.targets.length > 0;
    this.lines.visible = visible;
    this.nodes.visible = visible;
    if (!visible) return;
    if (headBone) this.uHead.value.multiplyMatrices(headBone.matrixWorld, this.bindInverse);
    const level = { fovDeg: camera.fov, aspect: camera.aspect, y: camera.position.y, z: camera.position.z };
    const count = this.targets.length;
    for (let i = 0; i < count; i += 1) {
      const target = this.targets[i];
      if (!target) continue;
      const p = projectToPlane(target, level, planeZ);
      this.uTargets.value[i]?.set(p.x, p.y, p.z);
      this.nodePositions.setXYZ(i, p.x, p.y, p.z);
    }
    this.nodePositions.needsUpdate = true;
    this.nodes.geometry.setDrawRange(0, count);
    this.uCount.value = count;
    // Nothing flows at rest: packets are for speech (and whatever the page asks for).
    const goal = this.reducedMotion ? 0 : Math.max(this.manual, raise);
    this.activity += (goal - this.activity) * (1 - Math.exp(-dt / ACTIVITY_EASE_S));
    this.uActivity.value = this.activity;
  }

  dispose(): void {
    for (const object of [this.lines, this.nodes]) {
      object.geometry.dispose();
      object.material.dispose();
      object.removeFromParent();
    }
  }
}
