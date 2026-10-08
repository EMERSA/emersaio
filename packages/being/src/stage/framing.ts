/**
 * Camera placement, kept free of three.js so node --test can check the numbers. The Stage reads the result on every
 * layout: the camera sits at (0, targetY, targetZ + distance), level, and looks at (0, targetY, targetZ).
 */

export interface Framing {
  fov: number;
  distance: number;
  targetY: number;
  /** Depth of the point the camera looks at; 0 is the figure's axis. */
  targetZ: number;
  /** 0 on a portrait canvas, 1 on a landscape canvas; other layouts interpolate. */
  t: number;
}

/** The head's extent in bind-pose world space, measured once from the loaded head mesh (avatar/headMeasure.ts). */
export interface HeadBounds {
  minY: number;
  maxY: number;
  centreZ: number;
}

/** The face look's lens: longer than the figure's, so the head keeps its proportions up close. */
export const FACE_FOV = 24;
/**
 * Landscape: the crown this far below the top edge and the chin this far above the bottom, as shares of the height
 * (the minimal brief: crown at 6 percent, chin at 53 percent, so the head takes about 47 percent of the hero and the
 * copy block sits under it). The shell's hero cloud fits the head to the same numbers so the crossfade lands in place.
 */
export const FACE_CROWN_AIR = 0.06;
export const FACE_CHIN_AIR = 0.47;
/** Portrait: the head's share of the canvas height, with its centre this much above the middle (none: nothing sits under the chin now). */
export const FACE_PORTRAIT_SHARE = 0.7;
export const FACE_PORTRAIT_LIFT = 0;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite interpolation of x between min and max, 0 below and 1 above (the GLSL function of the same name). */
export function smoothstep(x: number, min: number, max: number): number {
  const t = clamp01((x - min) / (max - min));
  return t * t * (3 - 2 * t);
}

/** 0 for portrait canvases (aspect 0.7 and under), 1 for landscape ones (1.3 and over), smooth in between. */
export const layoutT = (aspect: number): number => smoothstep(aspect, 0.7, 1.3);

/**
 * The face look's own blend: a phone's 46svh stage is about square (390 x 388) and must still frame the head the
 * portrait way, so portrait runs up to aspect 1.0 and landscape begins at 1.6 (a 1440 x 828 hero is 1.74).
 */
export const faceLayoutT = (aspect: number): number => smoothstep(aspect, 1.0, 1.6);

/** Metres of height a framing takes in at the point it looks at. */
export function visibleHeight(framing: Pick<Framing, 'fov' | 'distance'>): number {
  return 2 * framing.distance * Math.tan((framing.fov * Math.PI) / 360);
}

const distanceFor = (fov: number, visible: number): number => visible / (2 * Math.tan((fov * Math.PI) / 360));

/**
 * Camera placement for an aspect ratio. A portrait canvas (the 2:3 hero stage) shows the whole 1.75 m figure at
 * about 87% of the canvas height with 0.16 m of floor reflection under the feet, so the A-pose hands, the ring and
 * the ribbon stay inside the edges and the head stays high; a landscape canvas pulls back and lowers its centre
 * for about 0.26 m of reflection. The docked tour panel (small) comes in to head and shoulders instead.
 */
export function framingFor(aspect: number, small = false): Framing {
  const t = layoutT(aspect);
  if (small) {
    // A small stage (the docked tour panel) is where the face has to be legible while she speaks, so the camera
    // comes in to head and shoulders: the crown sits at 1.75 m and the eyes at about 1.62 m.
    return { t, fov: 28, distance: lerp(0.95, 1.25, t), targetY: 1.56, targetZ: 0 };
  }
  // At fov 32 a distance of 3.5 m takes in 2.0 m of height at the figure, centred on 0.84 m: the crown keeps 0.09 m
  // of air, the floor shows 0.16 m of reflection, and the figure stays within 3% of the hero cloud's 90% fit so
  // the crossfade lands in place. Landscape: 2.12 m at 3.95 m, centred on 0.80 m, for 0.26 m of reflection.
  return {
    t,
    fov: lerp(32, 30, t),
    distance: lerp(3.5, 3.95, t),
    targetY: lerp(0.84, 0.8, t),
    targetZ: 0,
  };
}

/**
 * The face look: the head alone, large. A landscape canvas puts the crown 6 percent below the top edge and the chin
 * 47 percent above the bottom; a portrait canvas scales the head to 70 percent of the height, centred. The camera
 * looks at the head's own depth, so the numbers hold at the face.
 */
export function faceFramingFor(aspect: number, head: HeadBounds): Framing {
  const t = faceLayoutT(aspect);
  const height = Math.max(0.05, head.maxY - head.minY);
  const landscape = height / (1 - FACE_CROWN_AIR - FACE_CHIN_AIR);
  const portrait = height / FACE_PORTRAIT_SHARE;
  const visible = lerp(portrait, landscape, t);
  const targetY = lerp(
    (head.minY + head.maxY) / 2 - FACE_PORTRAIT_LIFT * portrait,
    head.maxY + FACE_CROWN_AIR * landscape - landscape / 2,
    t,
  );
  return { t, fov: FACE_FOV, distance: distanceFor(FACE_FOV, visible), targetY, targetZ: head.centreZ };
}

/** The kinect-demo look's head and shoulders: their share of the canvas height, centred, on any aspect. */
export const BUST_SHARE = 0.75;
/** The bust's lower edge as a share of the figure's height (its crown): 1.25 m of a 1.75 m figure. */
export const BUST_FLOOR_SHARE = 1.25 / 1.75;

/** The head-and-shoulders crop under a measured head: from BUST_FLOOR_SHARE of the crown's height up to the crown. */
export function bustBounds(head: HeadBounds): HeadBounds {
  return { minY: head.maxY * BUST_FLOOR_SHARE, maxY: head.maxY, centreZ: head.centreZ };
}

/**
 * On a landscape canvas the bust rides this share of the visible height above centre, so the shoulders have faded
 * into the page before the copy block (label, headline) that sits over the lower half of the hero.
 */
export const BUST_LIFT = 0.08;

/**
 * The kinect-demo look: the bust fills BUST_SHARE of the height through the face look's lens, centred on a portrait
 * canvas and lifted by BUST_LIFT of the height on a landscape one.
 */
export function bustFramingFor(aspect: number, bust: HeadBounds): Framing {
  const height = Math.max(0.05, bust.maxY - bust.minY);
  const visible = height / BUST_SHARE;
  const t = faceLayoutT(aspect);
  return {
    t,
    fov: FACE_FOV,
    distance: distanceFor(FACE_FOV, visible),
    targetY: (bust.minY + bust.maxY) / 2 - BUST_LIFT * t * visible,
    targetZ: bust.centreZ,
  };
}
