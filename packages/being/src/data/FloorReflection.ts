import {
  type Blending,
  DetachedBindMode,
  Group,
  type IUniform,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SkinnedMesh,
} from 'three';
import { glowFrag, glowVert } from '../avatar/shaders/glow.glsl.ts';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';

export interface FloorReflectionOptions {
  /** Radius of the soft floor disc in metres. */
  radius?: number;
}

/** Any renderable the reflection can mirror: it needs a geometry and a material with a uMirror uniform. */
type Mirrorable = Mesh | Points | SkinnedMesh;

interface Proxy {
  source: Mirrorable;
  proxy: Mirrorable;
}

const FLOOR_ALPHA = 0.32;
/** Radius of the floor disc under the figure, in metres; the face look's plinth is smaller. */
export const FLOOR_RADIUS_M = 0.7;

const isSkinned = (object: Object3D): object is SkinnedMesh => (object as SkinnedMesh).isSkinnedMesh === true;
const isPoints = (object: Object3D): object is Points => (object as Points).isPoints === true;

/**
 * The glossy stage the figure stands on: a soft disc of rim light at y = 0 and, below the floor, a mirrored second
 * draw of whatever is handed to mirror(). Each mirrored object is a proxy that shares the source's geometry,
 * material, skeleton and morph influences and lives in a group scaled by -1 in y; three flips the winding for the
 * negative determinant itself. Right before each proxy draws, its world matrix is taken from the source's (so a
 * skinned head and a cloud placed in camera space land where they should) and the shared material's uMirror
 * uniform is raised, which fades the copy from 0.35 at the plane to nothing 0.9 m down. Nothing above the plane
 * changes. setPlane() moves the whole thing from the floor under the feet to the plinth under the chin.
 */
export class FloorReflection {
  readonly group = new Group();
  readonly floor: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly mirrorGroup = new Group();
  private readonly proxies: Proxy[] = [];
  private readonly plane: IUniform<number>;
  private readonly baseRadius: number;
  private enabled = true;

  constructor(shared: SharedUniforms, blending: Blending, options: FloorReflectionOptions = {}) {
    // Small enough that the glow has died away where the canvas bottom cuts the near side of the disc.
    const radius = options.radius ?? FLOOR_RADIUS_M;
    this.baseRadius = radius;
    this.plane = shared.uMirrorPlane;
    const material = new ShaderMaterial({
      uniforms: {
        uColor: shared.uRim,
        uAlpha: { value: FLOOR_ALPHA },
        uAlphaLight: { value: FLOOR_ALPHA * 0.7 },
        uShape: { value: 0 },
        uIsLight: shared.uIsLight,
        uOpacity: shared.uOpacity,
      },
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    material.name = 'FloorDisc';
    this.floor = new Mesh(new PlaneGeometry(radius * 2, radius * 2), material);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.renderOrder = -3;
    this.floor.frustumCulled = false;
    this.mirrorGroup.scale.y = -1;
    this.mirrorGroup.name = 'Mirror';
    this.group.name = 'Floor';
    this.group.add(this.floor, this.mirrorGroup);
  }

  get floorMaterial(): ShaderMaterial {
    return this.floor.material;
  }

  /** Mirror an object below the floor. The material must carry a uMirror uniform; without one the copy draws plain. */
  mirror(source: Mirrorable, material: ShaderMaterial): void {
    const uMirror = material.uniforms.uMirror as IUniform<number> | undefined;
    const mirrorGroup = this.mirrorGroup;
    let proxy: Mirrorable;
    if (isSkinned(source)) {
      const skinned = new SkinnedMesh(source.geometry, material);
      // Detached, so three leaves the bind matrices to us: they are the source's, copied before every draw, and the
      // proxy's own transform (the mirror) then applies on top of the skinned world pose.
      skinned.bindMode = DetachedBindMode;
      skinned.skeleton = source.skeleton;
      skinned.bindMatrix.copy(source.bindMatrix);
      skinned.morphTargetInfluences = source.morphTargetInfluences;
      skinned.morphTargetDictionary = source.morphTargetDictionary;
      proxy = skinned;
    } else if (isPoints(source)) {
      proxy = new Points(source.geometry, material);
    } else {
      proxy = new Mesh(source.geometry, material);
    }
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = false;
    proxy.renderOrder = -2;
    proxy.name = `${source.name || source.type}:mirror`;
    proxy.onBeforeRender = (): void => {
      // The scene's matrices are current here; the renderer takes the model-view matrix from this right after.
      proxy.matrixWorld.multiplyMatrices(mirrorGroup.matrixWorld, source.matrixWorld);
      if (isSkinned(proxy) && isSkinned(source)) proxy.bindMatrixInverse.copy(source.bindMatrixInverse);
      if (uMirror) {
        uMirror.value = 1;
        material.uniformsNeedUpdate = true;
      }
    };
    proxy.onAfterRender = (): void => {
      if (uMirror) {
        uMirror.value = 0;
        material.uniformsNeedUpdate = true;
      }
    };
    mirrorGroup.add(proxy);
    this.proxies.push({ source, proxy });
  }

  /** Follow the sources' visibility and layers each frame; a source hidden from the main camera has no reflection. */
  update(): void {
    for (const { source, proxy } of this.proxies) {
      proxy.visible = this.enabled && source.visible && source.layers.isEnabled(0);
      if (proxy.geometry !== source.geometry) proxy.geometry = source.geometry;
      if (isSkinned(proxy) && isSkinned(source) && proxy.morphTargetInfluences !== source.morphTargetInfluences) {
        proxy.morphTargetInfluences = source.morphTargetInfluences;
      }
    }
  }

  /**
   * Where the reflecting surface lies: the floor under the feet (y = 0, the default) or the plinth under the chin
   * in the face look. The disc moves there and takes the radius; the mirror flips about the plane.
   */
  setPlane(y: number, radius = this.baseRadius): void {
    this.floor.position.y = y;
    this.floor.scale.setScalar(radius / this.baseRadius);
    this.mirrorGroup.position.y = 2 * y;
    this.plane.value = y;
  }

  /** The mirrored draw (the tier's choice); the disc has its own switch. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mirrorGroup.visible = on;
  }

  setFloor(on: boolean): void {
    this.floor.visible = on;
  }

  dispose(): void {
    this.floor.geometry.dispose();
    this.floor.material.dispose();
    // Geometry and materials belong to the sources; the proxies only borrowed them.
    for (const { proxy } of this.proxies) proxy.removeFromParent();
    this.proxies.length = 0;
    this.group.removeFromParent();
  }
}
