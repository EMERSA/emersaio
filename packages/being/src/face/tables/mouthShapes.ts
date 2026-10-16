/**
 * A mouth shape for every sound: each of the 22 Microsoft visemes as a recipe of the model's ARKit blendshapes, so a
 * viseme shapes the lips (rounded for O and U, pressed shut for P, B and M, the lower lip tucked under the teeth for
 * F and V, the tongue between the teeth for TH, spread for EE) rather than only dropping the jaw. The FaceDriver adds
 * each recipe in proportion to its viseme's weight; MakeHuman's sculpted viseme targets stay underneath at
 * VISEME_DETAIL for their fine detail. Values were set by eye on Emily's model; the dev harness's Mouth panel tunes
 * them live and copies the table back.
 */
export type MouthRecipe = Readonly<Record<string, number>>;

/** How much of MakeHuman's own viseme target stays under each recipe. */
export const VISEME_DETAIL = 0.35;

export const MOUTH_RECIPES: readonly MouthRecipe[] = [
  /* 0 sil */ {},
  /* 1 ae (cat, about, cup) */ {
    jawOpen: 0.42,
    mouthStretchLeft: 0.25,
    mouthStretchRight: 0.25,
    mouthUpperUpLeft: 0.15,
    mouthUpperUpRight: 0.15,
  },
  /* 2 aa (father) */ { jawOpen: 0.62, mouthLowerDownLeft: 0.25, mouthLowerDownRight: 0.25 },
  /* 3 ao (law, dog) */ { jawOpen: 0.5, mouthFunnel: 0.45, mouthPucker: 0.1 },
  /* 4 eh (bed, book) */ {
    jawOpen: 0.32,
    mouthStretchLeft: 0.3,
    mouthStretchRight: 0.3,
    mouthLowerDownLeft: 0.15,
    mouthLowerDownRight: 0.15,
  },
  /* 5 er (bird) */ { jawOpen: 0.22, mouthFunnel: 0.35, mouthPucker: 0.2, mouthShrugUpper: 0.15 },
  /* 6 iy (see, sit, yes) */ {
    jawOpen: 0.14,
    mouthSmileLeft: 0.35,
    mouthSmileRight: 0.35,
    mouthStretchLeft: 0.35,
    mouthStretchRight: 0.35,
  },
  /* 7 uw (too, we) */ { jawOpen: 0.12, mouthPucker: 0.85, mouthFunnel: 0.3 },
  /* 8 ow (go) */ { jawOpen: 0.32, mouthFunnel: 0.65, mouthPucker: 0.3 },
  /* 9 aw (how) */ { jawOpen: 0.5, mouthFunnel: 0.35, mouthPucker: 0.2 },
  /* 10 oy (toy) */ { jawOpen: 0.38, mouthFunnel: 0.4, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  /* 11 ay (my) */ { jawOpen: 0.52, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  /* 12 hh (hat) */ { jawOpen: 0.28, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
  /* 13 r (red) */ { jawOpen: 0.16, mouthFunnel: 0.35, mouthPucker: 0.4 },
  /* 14 l (let) */ { jawOpen: 0.24, mouthStretchLeft: 0.15, mouthStretchRight: 0.15, tongueOut: 0.08 },
  /* 15 s (see, zoo) */ {
    jawOpen: 0.04,
    mouthStretchLeft: 0.4,
    mouthStretchRight: 0.4,
    mouthSmileLeft: 0.15,
    mouthSmileRight: 0.15,
    mouthUpperUpLeft: 0.2,
    mouthUpperUpRight: 0.2,
  },
  /* 16 sh (she, chin, joy) */ { jawOpen: 0.08, mouthFunnel: 0.6, mouthShrugUpper: 0.35, mouthPucker: 0.2 },
  /* 17 th (the, thin) */ { jawOpen: 0.14, tongueOut: 0.35, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
  /* 18 f (fat, van) */ {
    jawOpen: 0.04,
    mouthRollLower: 0.75,
    mouthUpperUpLeft: 0.3,
    mouthUpperUpRight: 0.3,
    mouthShrugUpper: 0.1,
  },
  /* 19 d (do, to, no) */ { jawOpen: 0.16, mouthStretchLeft: 0.12, mouthStretchRight: 0.12 },
  /* 20 k (cat, go, sing) */ { jawOpen: 0.26, mouthStretchLeft: 0.08, mouthStretchRight: 0.08 },
  /* 21 p (pat, bat, mat) */ {
    jawOpen: 0,
    mouthPressLeft: 0.7,
    mouthPressRight: 0.7,
    mouthRollLower: 0.2,
    mouthRollUpper: 0.2,
    mouthClose: 0.15,
  },
];

/** Visemes that must always reach their full shape (lips shut, lip under teeth), whatever their neighbours do. */
export const DOMINANT_VISEMES: ReadonlySet<number> = new Set([21, 18, 17]);
