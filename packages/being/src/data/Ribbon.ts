import {
  type Blending,
  CatmullRomCurve3,
  FrontSide,
  type IUniform,
  Mesh,
  ShaderMaterial,
  TubeGeometry,
  Vector3,
} from 'three';
import { ribbonFrag } from '../avatar/shaders/ribbon.frag.glsl.ts';
import { ribbonVert } from '../avatar/shaders/ribbon.vert.glsl.ts';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';

/** The spiral's shape: its distance from the figure's axis, the heights of its two ends and how often it turns. */
export interface RibbonProfile {
  /** Distance from the body axis in metres. */
  radius: number;
  /** Height of the lower end and of the upper end, in metres. */
  from: number;
  to: number;
  turns: number;
  /** The tube's radius in metres; left out, the figure's tube scaled with the spiral's radius. */
  tube?: number;
}

/** Around the whole figure: from the knees to the shoulders at arm's length, so it never reaches the head. */
export const FIGURE_RIBBON: Readonly<RibbonProfile> = { radius: 0.45, from: 0.5, to: 1.4, turns: 2 };

export interface RibbonOptions {
  /** One ribbon, or two half a turn apart. */
  count?: 1 | 2;
  profile?: RibbonProfile;
  tubeRadius?: number;
  reducedMotion?: boolean;
}

type RibbonUniforms = {
  uRibbon: SharedUniforms['uRibbon'];
  uDot: SharedUniforms['uDot'];
  uTime: SharedUniforms['uTime'];
  uFlow: IUniform<number>;
  uWave: IUniform<number>;
  uMirror: IUniform<number>;
  uMirrorPlane: SharedUniforms['uMirrorPlane'];
  uViewport: SharedUniforms['uViewport'];
  uOpacity: SharedUniforms['uOpacity'];
  uIsLight: SharedUniforms['uIsLight'];
};

/** Seconds for one turn around the figure. */
const TURN_S = 24;
/** Triangles for all ribbons together: 220 tube segments of 6 sides for one, 110 each for two. */
const SEGMENTS_TOTAL = 220;
const RADIAL_SEGMENTS = 6;
/** Undulation amplitude in metres. */
const WAVE_M = 0.012;
const TUBE_RADIUS_M = 0.025;

/**
 * The swirl of water around the bottle: one or two glossy tubes spiralling around the figure's axis, turning
 * slowly. The profile says where: around the whole figure from the knees to the shoulders by default, or, in the
 * face look, tight under the chin and down past the plinth, never crossing the face. The spiral bulges a little at
 * its middle, like water thrown outward as it turns. All ribbons share one material; a FloorReflection mirrors each
 * mesh through the material's uMirror uniform.
 */
export class Ribbon {
  readonly meshes: Mesh<TubeGeometry, ShaderMaterial>[] = [];
  readonly material: ShaderMaterial;
  private readonly uniforms: RibbonUniforms;
  private readonly reducedMotion: boolean;
  private readonly tubeRadius: number;
  private profile: RibbonProfile;

  constructor(shared: SharedUniforms, blending: Blending, options: RibbonOptions = {}) {
    this.reducedMotion = options.reducedMotion === true;
    this.tubeRadius = options.tubeRadius ?? TUBE_RADIUS_M;
    this.profile = { ...(options.profile ?? FIGURE_RIBBON) };
    this.uniforms = {
      uRibbon: shared.uRibbon,
      uDot: shared.uDot,
      uTime: shared.uTime,
      uFlow: { value: this.reducedMotion ? 0 : 1 },
      uWave: { value: this.reducedMotion ? 0 : WAVE_M },
      uMirror: { value: 0 },
      uMirrorPlane: shared.uMirrorPlane,
      uViewport: shared.uViewport,
      uOpacity: shared.uOpacity,
      uIsLight: shared.uIsLight,
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: ribbonVert,
      fragmentShader: ribbonFrag,
      transparent: true,
      depthWrite: false,
      // Outside faces only: both walls of a translucent tube would double the light. three flips the winding for
      // the mirrored proxy itself, so the same material serves it.
      side: FrontSide,
      blending,
    });
    this.material.name = 'Ribbon';

    const count = options.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      const mesh = new Mesh(this.tube(i, count), this.material);
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
    }
    this.applyWave();
  }

  /** Triangles drawn by all ribbons. */
  triangles(): number {
    let total = 0;
    for (const mesh of this.meshes) total += (mesh.geometry.index?.count ?? 0) / 3;
    return total;
  }

  /** Reshape the spiral; a reflection that borrowed the old geometry picks the new one up on its next update. */
  setProfile(profile: RibbonProfile): void {
    const p = this.profile;
    const same =
      profile.radius === p.radius && profile.from === p.from && profile.to === p.to && profile.turns === p.turns;
    if (same && profile.tube === p.tube) return;
    this.profile = { ...profile };
    this.meshes.forEach((mesh, i) => {
      mesh.geometry.dispose();
      mesh.geometry = this.tube(i, this.meshes.length);
    });
    this.applyWave();
  }

  update(dt: number): void {
    if (this.reducedMotion) return;
    const step = (dt * Math.PI * 2) / TURN_S;
    for (const mesh of this.meshes) mesh.rotation.y += step;
  }

  setEnabled(on: boolean): void {
    for (const mesh of this.meshes) mesh.visible = on;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    this.material.dispose();
  }

  /** The tube's radius for the current profile. */
  private tubeRadiusNow(): number {
    return this.profile.tube ?? (this.tubeRadius * this.profile.radius) / FIGURE_RIBBON.radius;
  }

  /** The undulation keeps its proportion to the tube: a wave the width of a thin tube would twist it into a blade. */
  private applyWave(): void {
    this.uniforms.uWave.value = this.reducedMotion ? 0 : (WAVE_M * this.tubeRadiusNow()) / TUBE_RADIUS_M;
  }

  private tube(index: number, count: number): TubeGeometry {
    const scale = this.profile.radius / FIGURE_RIBBON.radius;
    const curve = spiral(this.profile, (index / count) * Math.PI * 2, scale);
    return new TubeGeometry(curve, Math.floor(SEGMENTS_TOTAL / count), this.tubeRadiusNow(), RADIAL_SEGMENTS);
  }
}

/** Control points of one spiral; the Catmull-Rom curve through them is what the tube follows. */
function spiral(profile: RibbonProfile, phase: number, scale: number): CatmullRomCurve3 {
  const { radius, from, to, turns } = profile;
  const steps = Math.max(8, Math.round(turns * 12));
  const points: Vector3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = phase + t * turns * Math.PI * 2;
    // A slight bulge at the middle, like water thrown outward as it turns.
    const r = radius + 0.05 * scale * Math.sin(Math.PI * t);
    points.push(new Vector3(Math.cos(angle) * r, from + (to - from) * t, Math.sin(angle) * r));
  }
  return new CatmullRomCurve3(points, false, 'centripetal');
}
