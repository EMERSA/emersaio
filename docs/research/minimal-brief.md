# Minimalist build brief (from the Kinectron study and design spec, 2026-10-08)

Decisions taken for the open questions: light theme stays cream #faf6ee; the theme follows the OS preference (dark otherwise) as today; the hero lead copy stays as written (H1 at least 44px at 390 so it stays the LCP); keep the data fan on desktop; Kinect artefacts subtle; Kinectron is a dev-only input; Marcellus is the display face.

## Build brief
GOAL: a minimalist, sleek, bottle-inspired site with a Kinect-faithful standalone face. There are two parallel agents: A (runtime, packages/being) and B (shell, apps/web). Neither copies anything from Three-Kinectron.

SHARED CONTRACT (agree on this first; neither agent changes it alone)
1. Being options passed by the shell: { bloom:false, ribbon:false, reflection:false, ring:false, hud:false, backdrop:'rim-only', look:'kinect-face' }. The runtime must not construct DataRing, GodRays, FloorReflection, Ribbon or the bloom chunk when these are false. The bloom chunk must never be requested.
2. CSS custom properties that the runtime reads from :root (and re-reads on theme change): --wire, --dot, --echo, --glow, --rim, --fan, --bg-3d, --bloom.
   - Dark values: --wire #cfe4f2, --dot #8bbddf, --echo #5baee6, --glow #2896dd, --rim #2896dd, --fan #5baee6, --bg-3d #040918, --bloom 0.
   - Light values: --wire #073a72, --dot #0e5ba4, --echo #2896dd, --glow #2896dd, --rim #5baee6, --fan #0e5ba4, --bg-3d #faf6ee, --bloom 0.
   - Point ramp: near = --wire, mid = --glow, far = royal #0e5ba4 fading to --bg-3d.
3. Framing: landscape FACE_CROWN_AIR 0.06 and FACE_CHIN_AIR 0.47; portrait FACE_PORTRAIT_SHARE 0.70 with lift 0. The hero canvas fills the hero (inset 0) on desktop and is a 46svh full-bleed block on phones. The hero-cloud poster and fit must match, so the crossfade lands in place.
4. Fan anchors are fixed by the runtime: 4 nodes at x 94%, y 16/26/36/46% of the hero. Desktop with a fine pointer only. Packets run only while speaking. The shell provides no DOM targets for the fan.
5. Rim: one azure glow at alpha 0.22 in dark and 0.08 in light, 8% right of the head centre, radius 0.75 of head height. It is drawn in 3D; the shell draws no CSS rim, pool or beams.
6. Reduced motion or no WebGL2: the shell shows the inline poster SVG in the same head box; the runtime does not start.
7. Orange never appears in any 3D colour.

AGENT A: RUNTIME (packages/being)
- Sensor camera: render BeingDepthSource from a fixed sensor camera (about 1.05 m from the face, 7 deg below the eye line), separate from the view camera. The view gets eased look-at and parallax of at most 6 deg of yaw.
- Sensor clock: re-render depth only when floor(t*30) changes; uSensorHz 30. Freeze it under reduced motion.
- Hash: a PCG integer hash keyed on (cell, frame, salt) in WebGL2 GLSL. Remove any fract(sin()) of time.
- Quantisation: disparity quantisation with uFB 43.19 and uSubPx 8, dither 0.3, and the step capped at 10 mm in the figure framing.
- Edges: replace the flat JUMP_M 0.12 with a relative cut of 0.04*z, in both the points and the wire grid. Stochastic dropout only where facing < 0.45 or at a discontinuity, crossfaded at 10 Hz. Mask out the eyes and mouth (use the existing face landmarks or a UV mask).
- Jitter: fixed x-only jitter of 0.3 cell.
- Points: size max(1, 1.6*dpr*refDist/dist), a soft round disc via gl_PointCoord. Alpha 0.16*mix(1,0.4,depthT). Additive (or screen) blending in dark, normal in light.
- Shader decode: read depth as (r+g+b)/3 in kinect.vert.glsl.ts and kinectGrid.vert.glsl.ts.
- GLSL fix: in hero-cloud/cloud.vert.glsl.ts line 51, replace smoothstep(0.42,0.0,r) with 1.0-smoothstep(0.0,0.42,r).
- KinectronDepthSource: apply all 16 corrections in docs/research/kinectron-study.md. In particular:
  - no peer.connect;
  - an idempotent onReady;
  - feed first, then initKinect raced against a 5 s timeout, after 2 s with no frame;
  - error formatting;
  - accept 0.x array raw frames;
  - sizes chosen per (type, feed);
  - depth decoded to mm with 0.5-4.0 m for Azure and the inverted mm=17g for Kinect v2;
  - raw depth kept in a float R32F texture;
  - dispose rules;
  - widened config type (and update kinect-harness.ts).
  Add the listed unit tests using synthetic frames.
- Docs: fix the KINECT_DEFAULTS comment, the ADR-0005 grey and scale wording, VideoDepthSource and the dev README wording, and the runbook (date, licence, connect).
- Move the HUD readouts to /dev/kinect only. Expose isSpeaking so the shell can show the 'AI-generated voice' line.
ACCEPTANCE A:
- vitest passes, including the new Kinectron tests.
- A home page bundle has no bloom, ribbon, reflection or ring code paths executed, and no bloom chunk request.
- Stillness: no tour running and reduced motion off, two frames 2 s apart differ only in the canvas.
- No full-frame flicker above 3 Hz.
- Face bounding box at 1440x900: centre x 720±30, height 360-420 px. At 390x844: height at least 240 px and centred.
- No orange hue in the canvas pixels.

AGENT B: SHELL (apps/web)
- Fonts: remove Syne and Geist Mono. Add the @fontsource/marcellus latin 400 woff2 and keep inter-latin-wght-400-600.woff2. Preload both, font-display swap. Add a 'Marcellus Fallback' face on local Georgia: size-adjust 92.4%, ascent-override 105.4%, descent-override 30.3%. Code uses the ui-monospace stack.
- Tokens: replace the chrome, metal, amber, glass, pool, beam, floor and showcase tokens with the dark palette (--bg #040918, --bg-2 #03152f, --ink #f2f7fb, --ink-2 #cfe4f2, --ink-muted #8bbddf, --accent #2896dd, --accent-text and --focus #5baee6, --line rgba(207,228,242,.10), --line-2 .16, --field-border #5a86ae, --orange #ff6a00, --orange-hover #ff7a1a, --on-orange #040918) and the cream light palette (--bg #faf6ee, --bg-2 #f3eee4, --surface #fff, --ink #040918, --ink-2 #04244b, --ink-muted #3f5f80, --accent #0e5ba4, --field-border #6f7f96, --orange #f25c05, --orange-hover #ff6a00). Add the gloss recipe tokens, and the 3D tokens from the contract.
- Remove: header blur, the hero label plate, eyebrow ornaments, the SCROLL cue, the hero gradient, pool, beams, floor, the speaking halo, grain, leaks, the partner sweep, TriangleDividers, the H2 hover gradient, glass cards and their sheen and lift, the giant footer wordmark, magnetic buttons and animated underlines.
- Rules: no backdrop-filter and no background-clip:text anywhere. Radii only 8, 16, 999px and 50%.
- Type:
  - Home H1: Marcellus uppercase, tracking 0.08em, clamp(2.75rem, 2rem+3vw, 4rem), centred, max-width 13em, text-wrap balance.
  - H2: Marcellus sentence case.
  - Labels: Inter 500 12px, uppercase, tracking 0.22em.
  - Nav: Inter 500 12px uppercase, tracking 0.16em, inline at 960px and up.
  - Buttons: Inter 600 13px uppercase, tracking 0.12em.
  - Wordmark: EMERSA in Marcellus 16px, tracking 0.32em, beside the 24px orange mark.
- Buttons: the primary is flat orange with a 1px inset highlight and #040918 text, used only for Start the tour, Book a 20-minute demo and Send. Ghost buttons have a transparent fill with a 1px --line-2 border.
- Layout:
  - Hero: label, H1, lead and CTAs centred, 48px above the hero bottom on desktop. On phones they sit below the stage.
  - Sections: Partners (marquee kept with Pause, logos unfiltered, sentences verbatim), Story rail with 7px dots, Products (the Emily card is the page's single gloss; Krupiq is flat), Technology as three hairline columns, Docs and Games as two columns, the Transcript as a disclosure row, Contact as a flat panel. The footer has a hairline and keeps the legal row.
- Captions, tour dock and highlight: flat --bg-2 panels, no blur, 44px buttons, '2 / 9' progress, a 1px ring highlight.
- Motion: sections fade in on opacity only (400 ms, once). UI transitions use colour, opacity and border only.
- Light and dark: the light theme stays cream. Theme boot defaults to dark unless the visitor chose otherwise (pending user confirmation).
- Regenerate og.png.
ACCEPTANCE B:
- All design acceptance items pass: tests/browser/metrics.mjs shows the h1 as LCP at 390 and 1440 in both themes; exactly 2 font files before LCP, 40 KB or less; the orange audit (orange pixels only on the logo marks and .btn-primary); axe reports 0 violations; tour-smoke passes; all content and legal lines are present; the forbidden classes are absent from the DOM; Lighthouse mobile is 95 or higher and budgets.json passes; the gzipped CSS is smaller than today's.

## Design principles
- One hero, one light. The face is the only image on the first screen, with one azure rim light behind it. Nothing else glows.
- Use the bottle's light logic everywhere. Bottle samples from 1.png: near-black navy core #000e20 to #011c3d, an azure streak #0481d0 on the left, an ice-white highlight #e7f5f9 to #abdbff on the right, and label bands #01bef7 down to #0045a2.
- Orange is like the bottle cap: it appears only on the logo mark and on .btn-primary (hero 'Start the tour', Emily 'Book a 20-minute demo', contact 'Send').
- Set type like the bottle label. The hero H1 and the EMERSA wordmark use Marcellus, uppercase and widely tracked. Small labels use tracked Inter caps. Everything else uses Inter. That is two families and no mono font.
- Surfaces are flat by default and glossy only once. Every surface is flat navy (or cream) with 1px hairlines. Each page has at most one glossy surface.
- Whitespace divides the page. There are no ornaments: no diamonds, zigzags, plates, sweeps, grain, chrome text or giant wordmarks.
- The page is still at rest. Only the face, the partner marquee and (while Emily speaks) the data fan move.
- Speed is a feature. Two font files load before LCP (about 34 KB). There are no bloom, ribbon, reflection or ring passes and no backdrop-filter, and the h1 stays the LCP element.
- Accessibility is built in: AA contrast in the tokens, 44px targets, visible focus, captions and transcript, and a still poster under reduced motion.
- All content stays: tour, captions, sliding partners with Pause, story, products, docs, games, transcript, contact and legal footer. Only the presentation becomes minimal.

## Remove or simplify
- **SIMPLIFY** Header translucent blur (backdrop-filter 18px saturate 160%): Use a solid --bg with a 1px --line bottom border. There is nothing to blur, and the blur costs a compositing layer.
- **SIMPLIFY** Header brand 'Emersa' in Syne 700: Keep the orange mark (24px). Set 'EMERSA' in Marcellus 16px, uppercase, tracking 0.32em, like 'AQUA VERA'. Swap in the official wordmark SVG once it is supplied (docs/runbooks/inputs-needed.md).
- **SIMPLIFY** Nav links (sentence case, pill hover background): Inter 500, 12px, uppercase, tracking 0.16em, --ink-2. Hover changes to --ink. The current page gets a 1px underline. Show the links inline at 960px and up; below that use the existing menu sheet (the measured uppercase row of about 533px does not fit at 768px).
- **SIMPLIFY** Theme toggle (40px bordered glass box): Keep the 40px hit area with no border. Show a 1px --line ring only on hover and focus.
- **REMOVE** Hero label plate (.hero-label .glass .metal: brushed-noise pill, chrome hairline, line plus diamond): Keep the words as a plain label line: Inter 12px, tracking 0.22em, pale sky. This is the bottle's 'NATURAL MINERAL WATER' line.
- **REMOVE** Eyebrow ornaments (.eyebrow::before gradient rule and ::after glowing diamond), sitewide: Three ornaments sit on every label. One plain tracked label is enough.
- **SIMPLIFY** Hero H1 in Syne 700 at -0.03em: Marcellus 400, uppercase, tracking 0.08em, centred under the face: the bottle-wordmark moment.
- **SIMPLIFY** Hero lead (152 characters): Recommended copy change: 'Beings that see, remember and act.' The rest is already told in Story. If the full lead stays, the H1 must be at least 44px on phones; otherwise the lead paragraph out-sizes the h1 and becomes the LCP element (about 33,600 px² against 31,500 px² at 40px).
- **SIMPLIFY** Primary button amber-metal 5-stop gradient, hover sweep, magnetic transform, orange glow: Flat --orange, a 1px inset top highlight rgba(255,255,255,.35), a darker orange on hover, and 1px down when pressed. Label in #040918 (6.92:1).
- **SIMPLIFY** Ghost and glass buttons (chrome-edge ring, blur, blue glow): Transparent fill, 1px --line-2 border, --ink label. Hover raises the border to --ink-muted.
- **REMOVE** Hero 'SCROLL' mono cue: It is decoration; the page obviously scrolls.
- **REMOVE** Hero navy gradient (--hero-bg, lifting to #142854 mid-hero): Use a flat --bg #040918. The only tone change is the rim glow behind the head.
- **REMOVE** Stage pool (.being-pool radial): In light mode it reads as a grey-blue smudge (#ecf0f7 on #faf6ee in home-light-1440-t5).
- **REMOVE** Beams (CSS .being-beam-a/-b and the two 3D GodRay quads in Backdrop.ts RAYS): The diagonal shafts cut across the face. Keep only the RimLight quad.
- **SIMPLIFY** Rim glow (.being-rim plus the 3D RimLight): Keep one rim light: azure #2896dd at alpha 0.22 in dark (0.08 in light), centred 8% right of the head centre, radius about 0.75 of head height. It is the bottle's right-edge rim.
- **REMOVE** Floor plinth and line (.being-floor, --floor-line) and 3D FloorReflection: The face stands alone. Set reflection: false; this drops a mirrored second draw.
- **REMOVE** Ribbon (3D glossy spiral under the chin): Product-shot clutter. Set ribbon: false.
- **REMOVE** Data ring (DataRing points): It is already hidden in the face look but still built and updated each frame. Do not construct it on the home page.
- **SIMPLIFY** Data fan (DataFan lines to nodes): Keep it: it is the look of reference 5.png. Use 4 nodes at the right edge (x 94%, y 16/26/36/46% of the hero), 1px #5baee6 lines at alpha 0.18 and 6px ice nodes. Packets flow only while Emily speaks. Desktop and non-touch only; never target a HUD plate or the captions.
- **REMOVE** Bloom postprocessing chunk: Crisp hairlines read sleeker; point sprites carry their own falloff. It saves a chunk and a pass (bloom: false, --bloom 0).
- **REMOVE** HUD instrument plate (brushed-metal mono readouts: fps, tok/s, depth, pts, mode, colo): Engineering readouts are not brand. Move them to /dev/kinect. Keep the 'AI-generated voice' disclosure: show it in the tour dock whenever voice plays.
- **REMOVE** Speaking halo pulse (.being-stage.is-speaking::before): The face itself shows speech.
- **KEEP** Hero cloud canvas, poster SVG and shatter intro: Part of the face pipeline: instant poster, then cloud, then being. Recolour them from the new tokens. The intro runs once, at most 1.2s.
- **SIMPLIFY** Captions bubble (glass with blur): Solid --bg-2, 1px --line, radius 16. Inter 16px/1.5 in --ink-2.
- **SIMPLIFY** Tour bar and dock (glass panel, backdrop blur, glass pill buttons): Flat --bg-2 panel with 1px --line and radius 16, no blur. Text buttons at least 44px with 1px border. Progress shows as '2 / 9' in Inter tabular figures.
- **SIMPLIFY** Tour highlight (.is-highlighted, 2px bright box at offset 10px): 1px #5baee6 ring at offset 8px, radius 16.
- **REMOVE** Film grain overlay (.grain, fixed, 6%): It lifts the navy from #050a16 to #0a0f1a (the seam at y≈900 in docs-dark-full.png) and costs a full-screen layer.
- **REMOVE** Light leaks (.leak) and --band gradients: Use flat surfaces only.
- **SIMPLIFY** Partner band (gradient band, double hairlines): No band fill. The marquee sits on --bg. Logos 28px tall (stacked 38px), 80px gap, 10% edge fade.
- **REMOVE** Partner band light sweep (.sweep, every 7s): Ambient decoration.
- **KEEP** Partner marquee, Pause control, verbatim sentences and '[wording to be confirmed]' flags: Required by the user and by WCAG 2.2.2. Logos stay as unmodified files (partner-permissions.md: 'the logo stays as it is'), so no CSS filter. Ask partners for one-colour variants in the permission request.
- **REMOVE** Triangle zigzag dividers (5 TriangleDivider instances with the blue centre triangle): Section padding divides the page; at most a 1px --line at container width.
- **REMOVE** Section H2 hover chrome-blue clipped gradient: A heading that changes on hover with no action is noise; also drop background-clip:text sitewide.
- **SIMPLIFY** Story rail gradient and metal-blue triangle markers with glow: 1px --line-2 rail with a 7px solid azure dot per step. Years in Inter 500 13px tabular, not mono.
- **REMOVE** Glass card system (.glass gradient ring masks, inner highlight, blue glass-shadow) and hover sheen sweep and lift on .card: Cards become flat --bg-2 with a 1px --line border, radius 16, no motion.
- **SIMPLIFY** Emily showcase card (--showcase gradient plus reflection line): It becomes the page's single glossy surface (the bottle gloss recipe).
- **SIMPLIFY** Metal-blue triangle bullets in Emily's points: An 8px outline triangle, 1px #5baee6. This is the one surviving use of the triangle motif.
- **SIMPLIFY** Video slot (glass frame, specular sheen, wire-mask motif): A flat 16:9 #040918 panel, radius 8, 1px --line, with the disabled play button and its caption. Drop the wire motif so the face stays the only wire drawing.
- **SIMPLIFY** Krupiq card: Flat surface card with an outline CTA.
- **SIMPLIFY** Technology glass cards and glowing icons: Three plain columns, each with a 1px top hairline. Icons 24px, stroke 1.25, no glow.
- **SIMPLIFY** Docs and Games teaser glass cards: Two columns with a top hairline, a Marcellus 28px title, text, and a small outline link button.
- **SIMPLIFY** Transcript card (bordered surface details): A full-width disclosure row with 1px hairlines top and bottom and a chevron. The list inside stays (no-JavaScript tour target).
- **SIMPLIFY** Contact form (white or glass card with heavy shadow, full-width glowing orange pill): Flat --bg-2 panel. Fields 48px tall, radius 8, 1px --field-border. 'Send' is a flat orange primary button, auto width on desktop and full width on phones.
- **SIMPLIFY** Footer band gradient and animated link underlines: Use --bg with a 1px top hairline. Links change colour on hover with a plain underline, no scaleX animation.
- **REMOVE** Giant chrome footer wordmark (.footer-giant, Syne 800, up to 11.5rem): The biggest ornament on the page. The brand block keeps the small mark and the EMERSA wordmark.
- **KEEP** Legal footer row, link columns, vulnerability email: UK disclosure requirement and the user's constraint.
- **SIMPLIFY** Reveal on scroll (18px rise plus 90ms staggers): Fade whole sections only: opacity, 400ms, once, no translate or stagger. Nothing hides under reduced motion.
- **REMOVE** Syne Variable and Geist Mono web fonts: Replace them with Marcellus and Inter. Saves 28,008 B (Syne subset) and 9,864 B (Geist Mono latin 400). Code blocks use the system ui-monospace stack.
- **REMOVE** Chrome, metal and amber tokens (--chrome, --chrome-blue, --metal-*, --amber-metal, --sweep, --glass-*, --pool, --beam, --floor-*, --showcase): Collapse them into the palette and gloss tokens below.

## Palette
Dark: DEFAULT THEME, the bottle body. All contrast ratios were computed with the WCAG formula.

Surfaces and text:
- --bg #040918 (page, header, footer)
- --bg-2 #03152f (cards, captions, form panel, tour dock)
- --bg-3 #04244b (top of the gloss)
- --ink #f2f7fb (headings): 18.42:1 on --bg
- --ink-2 #cfe4f2 (body): 15.16:1 on --bg, 13.91:1 on --bg-2, 11.80:1 on #04244b
- --ink-muted #8bbddf (labels, meta): 9.88:1 on --bg, 9.06:1 on --bg-2, 7.68:1 on #04244b
- --steel #5a86ae: non-text only (rails, icons, placeholders): 5.16:1 on --bg but 4.01:1 on #04244b

Accents and lines:
- --accent #2896dd (rim light, link underlines): 6.14:1
- --accent-text #5baee6 (links, active states): 8.17:1
- --focus #5baee6: 2px ring, offset 2px
- --line rgba(207,228,242,.10)
- --line-2 rgba(207,228,242,.16)
- --field-border #5a86ae: 5.16:1, passes the 3:1 needed for non-text

Orange (logo mark and .btn-primary only):
- --orange #ff6a00
- --orange-hover #ff7a1a
- --on-orange #040918: 6.92:1 on #ff6a00, 7.61:1 on #ff7a1a. White on orange fails at 2.87:1.

Gloss tokens:
- --gloss-body: linear-gradient(180deg,#04244b 0%,#03152f 58%,#040918 100%)
- --gloss-spec rgba(223,237,246,.22). The composite over the body is #2b486a; ice text still reaches 7.16:1 there.
- --gloss-rim rgba(40,150,221,.55)

3D tokens:
- --wire #cfe4f2
- --dot #8bbddf (near points)
- --echo #5baee6
- --glow #2896dd
- --rim #2896dd
- --fan #5baee6
- --ribbon #cfe4f2 (unused)
- --bg-3d #040918
- --bloom 0
- Point depth ramp: ice #cfe4f2 (near) to azure #2896dd to royal #0e5ba4 (far), with a distance alpha fade as in webgl_kinect.

Other:
- royal #0e5ba4 is decorative only on dark (2.89:1).
- theme-color #040918.
- Source swatches (k-means plus pixel samples): #040918, #03152f, #04244b, #073a72, #0e5ba4, #2896dd, #5baee6, #5a86ae, #8bbddf, #cfe4f2, #dfedf6.

Light: LIGHT = CREAMY WHITE (the user's explicit earlier request; keep it as the default light theme).

Surfaces and text:
- --bg #faf6ee
- --bg-2 #f3eee4 (footer, panels)
- --surface #ffffff (cards, fields)
- --ink #040918: 18.42:1
- --ink-2 #04244b: 14.33:1 on cream, 15.45:1 on white (navy instead of the warm #14110f, so the bottle palette carries into light)
- --ink-muted #3f5f80: 6.17:1 on cream, 5.75:1 on #f3eee4, 6.65:1 on white

Accents and lines:
- --accent #0e5ba4 (links, focus): 6.38:1 cream, 6.88:1 white
- --accent-strong #073a72: 10.49:1
- azure #2896dd: decorative or large text only (3.00:1)
- --line rgba(4,9,24,.10)
- --line-2 rgba(4,9,24,.16)
- --field-border #6f7f96: 3.78:1 cream, 4.08:1 white

Orange:
- --orange #f25c05 (mark and button fill)
- --orange-hover #ff6a00
- --on-orange #040918: 5.97:1

Gloss (ice glass):
- body: linear-gradient(180deg,#ffffff,#eef4f9)
- spec: rgba(255,255,255,.95)
- rim: rgba(14,91,164,.35)
- Text on #eef4f9: #04244b 13.94:1, #3f5f80 5.99:1, #0e5ba4 6.21:1

3D tokens (normal blending):
- --wire #073a72
- --dot #0e5ba4
- --echo #2896dd
- --glow #2896dd
- --rim #5baee6 at alpha 0.08
- --fan #0e5ba4
- --bg-3d #faf6ee
- --bloom 0
- No pool or haze on cream.

OPTION, NOT DECIDED (for the user): ICE WHITE.
- --bg #f4f8fb
- --bg-2 #dfedf6 (the bottle's own backdrop)
- --surface #ffffff
- ink #040918 (18.60:1)
- ink-2 #04244b (14.47:1)
- muted #3f5f80 (6.22:1; 5.56:1 on #dfedf6)
- accent #0e5ba4 (6.45:1; 5.76:1 on #dfedf6)
- field-border #6f7f96 (3.82:1)
- --bg-3d #f4f8fb

Assessment: ice would serve the bottle look better. The bottle shot's light is cool (pixel samples #f2f6f8 to #c0dbea), so navy, azure and cobalt read as one material and orange is the only warm hue. Cream keeps warmth and an editorial feel, but makes any blue glow look grey. theme-color #faf6ee (or #f4f8fb).

## Typography
COMPARISON. All three are OFL-1.1, version 5.3.0 on npm, published 2026-07-19. Sources: registry.npmjs.org; data.jsdelivr.com/v1/packages/npm/<pkg>@5.3.0?structure=flat; api.fontsource.org/v1/fonts/<id>; google/fonts DESCRIPTION files. Widths were measured from the font files.

(1) @fontsource/cinzel
- Serif, 'inspired in first century roman inscriptions'.
- Latin woff2: 400 = 14,128 B; variable @fontsource-variable/cinzel wght 400 to 900 = 25,904 B.
- Widest caps: average 0.683em, H 0.693em.
- Lowercase are small caps (verified: 'h' yMax 600 and 'p' yMin 0, no ascenders or descenders), so sentence-case headings are impossible.
- No weight below 400. Reads epic or film-poster.

(2) @fontsource/marcellus
- 'Flared serif typeface ... inspired by classic Roman inscription letterforms'.
- Weight 400 only; latin woff2 = 14,552 B; package unpacked size 70,484 B.
- Average cap 0.636em. True lowercase (h ascender 0.730, p descender -0.250).
- Softer, contemporary flared form; holds up at the 16px tracked wordmark size.

(3) @fontsource/italiana
- Google category sans-serif, 'for headlines ... inspired by Italian calligraphy'.
- 400 only; latin woff2 = 10,100 B.
- Lightest, but narrowest (average cap 0.580em, H 0.491em). Hairlines fade on 1x Windows screens.

Also measured and rejected:
- @fontsource/tenor-sans 400: 18,588 B, a sans
- @fontsource/josefin-sans 300: 12,208 B; variable 28,528 B; vintage geometric
- @fontsource/montserrat 300: 18,708 B; variable 37,956 B; generic

PICK: Marcellus 400. It matches the serif 'AQUA VERA' wordmark tracked wide, and it is the only serif candidate that also allows sentence-case H2s. Runner-up: Cinzel 400, if a sharper Roman wordmark is wanted and caps-only headings are accepted.

TEXT FACE: Inter, kept as the repo's own subset inter-latin-wght-400-600.woff2.
- 19,856 B, made from @fontsource-variable/inter 5.3.0 (OFL-1.1; upstream latin wght file 48,256 B).
- Weights: 400 body, 500 UI and labels, 600 emphasis and H3.
- No mono web font; code uses ui-monospace, 'Cascadia Code', Menlo, Consolas.

FONT TRANSFER BEFORE LCP:
- Marcellus 14,552 B plus Inter 19,856 B = 34,408 B (about 33.6 KiB), against the 75 KB budget.
- Removed: Syne 28,008 B and Geist Mono 9,864 B.
- Optional: subset Marcellus with the README fontTools recipe (static font, so no instancer step). Estimated 9 to 11 KB, UNVERIFIED.
- Preload both files; font-display: swap.

FALLBACK FACE: 'Marcellus Fallback' with src local('Georgia').
- size-adjust 92.4%, ascent-override 105.4%, descent-override 30.3%, line-gap-override 0%.
- Computed from Marcellus hhea (0.9741 / -0.2798) and from Georgia/Marcellus widths of 'WE MAKE SYNTHETIC BEINGS.' (14.9985em against 13.8623em).
- For the sentence-case H2 the matching size-adjust would be 102.2%. Verify that CLS stays below 0.01.

SCALE (root 16px):
- H1, home hero only: Marcellus 400, UPPERCASE, letter-spacing 0.08em, line-height 1.04, clamp(2.75rem, 2rem + 3vw, 4rem). That is 44px at 390 (the floor that keeps the h1 the LCP element) and 64px at 1440. max-width 13em with text-wrap: balance gives 'WE MAKE / SYNTHETIC BEINGS.' on desktop and 3 lines on phones.
- H1 on other pages: Marcellus sentence case, clamp(2.25rem, 1.6rem + 2vw, 3rem), tracking -0.005em.
- H2: Marcellus 400 sentence case, clamp(1.875rem, 1.25rem + 2vw, 2.75rem) (30 to 44px), line-height 1.12, tracking -0.005em.
- Product names and teaser titles: Marcellus 2rem / 1.75rem.
- H3: Inter 600, 1.25rem (1.125rem on phones), line-height 1.3, tracking -0.01em.
- Lead: Inter 400, clamp(1.0625rem, 1rem + 0.3vw, 1.25rem), line-height 1.55, --ink-2, max-width 46ch centred in the hero, 60ch elsewhere.
- Body: Inter 400, 1rem, line-height 1.65, max-width 66ch.
- Small: Inter 400, 0.875rem, line-height 1.55, muted.
- Legal: 0.8125rem, line-height 1.6.
- Label (the bottle's 'NATURAL MINERAL WATER' line; eyebrows, kickers, footer column titles, 'PARTNERS'): Inter 500, 0.75rem, UPPERCASE, tracking 0.22em (0.16em under 400px), --ink-muted.
- Nav: Inter 500, 0.75rem, UPPERCASE, tracking 0.16em.
- Buttons: Inter 600, 0.8125rem, UPPERCASE, tracking 0.12em.
- Wordmark: 'EMERSA' in Marcellus 1rem, tracking 0.32em (about 90px wide).
- Numbers (years, tour progress, transcript numbers): Inter 500, 0.8125rem, tabular-nums, tracking 0.08em.

CASE RULES: uppercase only for the home H1, the wordmark, labels, nav and buttons. Never uppercase a sentence longer than 40 characters other than the H1.

## Layout
GRID AND SPACING
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160 px.
- Container: max 1120px content. Gutters 20px (<768), 32px (768 to 1279), 48px (≥1280).
- Columns: 12 at ≥1024 with 24px gaps; 8 at 768; 4 on phones with 16px gaps.
- Section rhythm: --section-y clamp(4.5rem, 2.5rem + 6vw, 9rem), about 72px at 390 and 126px at 1440.
- Section head to content: 48px (32px on phones).
- Radii: 8px (fields, video), 16px (cards, panels, dock), 999px (buttons), 50% (dots).
- Hairlines are 1px. There are no section dividers and no section background bands.

HEADER
- Sticky, 72px (64 on phones), solid --bg, 1px --line bottom border.
- Left: orange mark 24px, 12px gap, then the EMERSA wordmark.
- Centre at ≥960px: 6 nav links with 28px gaps.
- Right: theme toggle 40px.
- Below 960px: the toggle plus the menu button open the existing <details> sheet. The sheet uses Marcellus 1.75rem links separated by hairlines.

HOME, IN ORDER
1. Hero (see the hero field).
2. Partners
   - Padding 64px (48px on phones).
   - Centred 'PARTNERS' label with a small text 'Pause' button 12px to its right.
   - Full-bleed marquee: 84s linear loop, 10% edge fade, logos 28px tall (stacked 38px), 80px gaps.
   - Sentences: max 960px, 2 columns at ≥768px (gaps 16px by 48px), Inter 14px muted; partner names in --ink-2 600; flags shown.
3. Story
   - Head (label plus H2) in columns 1 to 7.
   - Timeline in columns 1 to 8, max 760px.
   - Year column 88px, right-aligned, accent-text.
   - Rail at 112px; 7px azure dot level with each title.
   - Content from 136px: H3 plus text up to 58ch; 40px between steps.
   - On phones the rail sits at 8px and the year goes above the title.
4. Products
   - Head in columns 1 to 7.
   - Emily card (the gloss) in columns 1 to 7, Krupiq (flat --bg-2) in columns 8 to 12, equal heights, 24px gap, card padding 40px (24px on phones).
   - Emily card order: label, name, lead, 4 points (10px gaps, triangle-outline bullets), 16:9 video panel, orange CTA.
   - Krupiq: outline CTA.
   - Stacked on phones.
5. Technology: head (label, H2, lead) in columns 1 to 7; three columns (1-4, 5-8, 9-12), each with a 1px top hairline and 24px top padding: icon, H3, text.
6. Docs and Games: two columns (1-6, 7-12), each with a top hairline, label, Marcellus 1.75rem title, text and a small outline button.
7. Transcript: one disclosure row between hairlines, 24px vertical padding. List numbers 01 to 09 with text up to 62ch.
8. Contact
   - Columns 1 to 5: label, H2, lead.
   - Columns 7 to 12: flat --bg-2 panel, radius 16, padding 32px. Name and Email side by side, then Company and Topic, then Message (min 160px), then orange 'Send' and the privacy note.
   - Single column on phones.

FOOTER
- --bg, 1px top hairline, padding 64px top and 32px bottom.
- Brand block in columns 1 to 5: mark, wordmark, tagline (14px muted).
- 'Products' column in columns 7 to 9 and 'Company' in columns 10 to 12. Titles use the label style; links are Inter 14px --ink-2 with 12px gaps.
- After 48px: a hairline, then a row with the legal line (13px, max 72ch) on the left and Privacy, Terms, Security and LinkedIn on the right. The vulnerability line sits below.
- No giant wordmark.

OTHER PAGES
- Same header, footer and tokens.
- /docs: H1 plus lead; groups (BEINGS, PRODUCTS, TRUST labels) as list rows (title in Inter 600 18px, one muted line and an arrow, hairline separators) instead of cards.
- Doc pages: 68ch prose, Inter headings inside prose.
- /contact: the form panel may carry the gloss, the page's one gloss.
- /games and 404: list rows; the 404 uses a small poster face.
- Regenerate og.png in the new look.

THEME BOOT
- The user said dark is the default. Today public/theme-boot.js follows prefers-color-scheme when nothing is stored. Change it to dark unless the visitor has chosen otherwise; confirm with the user.

## Hero
The face is the label's emblem, the H1 is the wordmark and the label lines are the small print, like the bottle. Everything is centred.

DESKTOP (reference 1440×900)
- Header 72px; hero 100svh minus 72 = 828px.
- Background: flat #040918 (dark) or flat cream (light). No gradients.
- The being canvas spans the whole hero (inset 0), so nothing is ever cut off.
- Head framing:
  - Centred horizontally (bounding-box centre at x = 720 ± 30px).
  - Crown 6% below the hero top (about 50px).
  - Chin at 53% of the hero height (about 436px).
  - Head height about 47% of the hero (about 390px).
  - In packages/being/src/stage/framing.ts that means landscape FACE_CROWN_AIR 0.06 and FACE_CHIN_AIR 0.47 (currently 0.08 and 0.38). Keep the hero-cloud fit matched so the crossfade lands in place.
- One rim glow: azure #2896dd at 22% alpha in the centre, fading to 0. Centred 8% to the right of the head centre, radius 0.75 of head height. This is the bottle's right rim; the ice wire carries the left-side highlight.
- Fan: 4 nodes at x 94%, y 16/26/36/46% of the hero, never below the chin line. 1px #5baee6 lines at 18% alpha, 6px ice nodes, packets only while speaking. Desktop with a fine pointer only.
- Face rendering:
  - Ice wire over a depth point cloud, points 1.5 to 2 CSS px (three's webgl_kinect uses pointSize 2, depthWrite false and a smoothstep distance alpha; https://raw.githubusercontent.com/timoxley/threejs/master/examples/webgl_kinect.html).
  - Additive blending in dark, normal in light.
  - Gentle pointer look-at, at most about 6° of yaw.
  - The pieces assemble once, at most 1.2s.
- Copy block, centred and anchored 48px above the hero bottom, max-width 760px. Top to bottom:
  - Label 'EMERSA LABS · LONDON · SINCE 2023' (16px line), then 20px.
  - H1 'WE MAKE / SYNTHETIC BEINGS.' at 64px, 2 lines, about 133px tall, then 20px.
  - Lead, 1 line at 18px/27px, then 32px.
  - CTA row, gap 12px: orange 'START THE TOUR' (48px tall, about 194px wide) and outline 'MEET EMILY WILSON' (about 225px).
  - The block totals about 344px and starts at about y 484, at least 24px below the chin.
- Hidden Phase 2 'Talk to Emily' uses the outline style.
- No scroll cue, plate, plinth, beams, pool or HUD.

TABLET (768 to 1023)
- Same composition. Head 44% of the hero; H1 about 55px.

PHONE (reference 390×844)
- Header 64.
- Stage block: full-bleed, 46svh (about 388px). Head centred, crown at 8% of the stage, head about 70% of the stage height (about 270px). FACE_PORTRAIT_SHARE becomes 0.70 with lift 0, now that the extras are gone.
- No fan and no extras on touch devices.
- Copy below, 20px gutters:
  - Label (tracking 0.16em)
  - 16px gap
  - H1 at 44px, 3 lines (about 137px)
  - 16px gap
  - Lead in 1 line
  - 24px gap
  - Full-width stacked buttons, 48px tall with a 12px gap
  - 32px bottom padding
  - Total about 760px, within the 780px hero.
- LCP: the h1 area (about 277×137 = 38,000 px²) must exceed the lead. With the full 152-character lead (about 33,600 px²) the margin is thin; the 1-line lead removes the risk. Verify with tests/browser/metrics.mjs.

TOUR STATE
- 'Start the tour' pins the dock as today. Desktop: bottom-right, 24px inset, width min(448px, 100vw minus gutters), captions on the left and the small face (144px) on the right. Phones: a bottom sheet.
- Flat --bg-2 panel with 1px --line, radius 16, no blur.
- Top line shows 'AI-generated voice' in the label style; captions in Inter 16px; buttons Back, Next, Replay, Mute and End tour at 44px; progress '2 / 9'.

LIGHT THEME
- Same proportions on flat cream (or ice). Cobalt #073a72 wire and royal points; rim glow #5baee6 at 8%.

REDUCED MOTION OR NO WEBGL2
- The inline poster SVG sits in the same head box, in --wire. No fan, no intro.

## Surfaces and motion
SURFACES (four kinds only)
1. Page: flat --bg. No gradients, grain or washes.
2. Raised: flat --bg-2 (dark) or #ffffff (light), 1px --line border, radius 16. No shadow in dark; in light, 0 1px 2px rgba(4,9,24,.06).
3. Hairline: a 1px --line rule at container width, used for column tops, the transcript and the footer.
4. THE GLOSS ('bottle glass'): at most one instance per page. Home: the Emily Wilson card. /contact: the form panel. Nowhere else.
   - Dark recipe: background radial-gradient(8px 55% at 18px 32%, rgba(223,237,246,.22), transparent) (the left specular streak, inside the padding), layered over linear-gradient(180deg,#04244b 0%,#03152f 58%,#040918 100%). Border 1px solid rgba(207,228,242,.10); radius 16. Box-shadow: inset 0 1px 0 rgba(207,228,242,.16), inset -1px 0 0 rgba(40,150,221,.55), inset -24px 0 32px -28px rgba(40,150,221,.45) (the azure right rim).
   - Light recipe: radial streak rgba(255,255,255,.95) over linear-gradient(180deg,#ffffff,#eef4f9). Border rgba(4,9,24,.08). Inset -1px 0 0 rgba(14,91,164,.35) and inset -24px 0 32px -28px rgba(40,150,221,.25), plus 0 1px 2px rgba(4,9,24,.06) and 0 16px 40px -24px rgba(4,36,75,.25).
   - Static: no blur, noise or animation.
- The orange primary button gets only a 1px inset top highlight, rgba(255,255,255,.35).
- The 3D scene uses the same light logic: ice wire highlights, one azure rim light on the right, deep navy field.
- Nothing anywhere uses backdrop-filter, background-clip:text, SVG noise or mask-composite rings.

MOTION
- At rest only three things move:
  - the face (idle breathing, blink, pointer look-at)
  - the partner marquee (linear, 84s per loop, pauses on hover, focus and the Pause button)
  - while Emily speaks only: the mouth (visemes) and the fan packets
- One entrance: the face assembles once (at most 1.2s, ease-out), with the existing 720ms cloud-to-being crossfade.
- UI transitions animate colour, opacity and border only: 160ms fast, 240ms base, cubic-bezier(.22,1,.36,1). Press is translateY(1px).
- Sections fade in on scroll: opacity only, 400ms, once, no stagger.
- Page navigation keeps the native view-transition crossfade.
- Banned: sweeps and sheens, magnetic buttons, card lifts, parallax, halos, pulsing glows, animated underlines, hover gradient text, grain.

REDUCED MOTION
- Poster instead of WebGL, a static wrapped logo row, no reveals, no view-transition animation. Captions and the transcript still work.

PERFORMANCE
- being options: bloom false, ribbon false, reflection false; the ring is not built in the face look; the Backdrop keeps only the RimLight.
- Keep the idle frame cap on touch devices.
- No backdrop-filter layers.

## Acceptance
- home-dark-1440-t5 and home-light-1440-t5: inside the hero the only non-text graphics are the face (wire plus points), one soft rim glow and, on desktop, the fan lines and nodes. There is no pill or plate, no diagonal beam, no floor line or plinth, no HUD and no 'SCROLL'.
- At 1440×900 the face bounding-box centre is at x = 720 ± 30px, head height is 360 to 420px, the crown is at least 40px below the header, and the chin is at least 24px above the label line. At 390×844 the head is at least 240px tall and horizontally centred.
- The home H1 renders in Marcellus, uppercase, with computed letter-spacing 0.08em, centred: 2 lines at 1440 and 3 lines at 390, with a font size of at least 44px at 390.
- tests/browser/metrics.mjs reports the h1 as the LCP element at 390×844 and 1440×900 in both themes.
- Network: before LCP the home page fetches exactly two font files, the Marcellus latin 400 woff2 and inter-latin-wght-400-600.woff2. Font bytes total 40 KB or less (the budget is 75 KB). No page requests Syne or Geist Mono.
- Orange audit on fresh screenshots (all 7 listed views): pixels with hue 15 to 35°, saturation of at least 0.7 and value of at least 0.6 appear only inside the bounding boxes of the logo marks and the .btn-primary elements ('Start the tour', 'Book a 20-minute demo', 'Send').
- No element has a computed backdrop-filter other than none, and none uses background-clip:text. The DOM contains none of .grain, .leak, .sweep, .metal, .triangle-divider, .hud-plate, .footer-giant, .being-beam, .being-pool, .being-floor or .eyebrow::after diamonds.
- Exactly one gloss element on / (the Emily card) and at most one on any other page. All other cards are flat with a 1px border.
- Only 8px, 16px, 999px and 50% border-radius values are in use.
- tests/browser/a11y.mjs (axe with color-contrast) reports 0 violations in both themes. Token ratios: body #cfe4f2 on #040918 at 15.16:1; labels #8bbddf at 9.88:1; light body #04244b on #faf6ee at 14.33:1; light labels #3f5f80 at 6.17:1; field borders at 3:1 or more (#5a86ae 5.16:1, #6f7f96 3.78:1); focus ring #5baee6 at 8.17:1 and #0e5ba4 at 6.38:1. All interactive targets are at least 44px tall.
- Stillness: at rest (no tour), two screenshots taken 2s apart differ only inside the hero canvas box and the partner marquee box. With prefers-reduced-motion they are pixel-identical, and the marquee shows as a static wrapped row.
- Partners: the logo files are unmodified (no CSS filter), the Pause control is present and toggles aria-pressed, and all four sentences with their flags appear verbatim.
- tour-dark-stop2 re-shot: the dock is a flat panel (no blur) showing 'AI-generated voice', captions, and Back, Next, Replay, Mute and End tour (each at least 44px), plus '2 / 9'. The highlighted step shows a 1px ring, not a 2px bright box. tests/browser/tour-smoke.mjs passes.
- All content is present: #hero, #partners, #story, #products (Emily Wilson and Krupiq), #technology, the docs and games teasers, #tour transcript, #contact form, and the footer legal line (company no. 15179283, registered office, VAT, Privacy, Terms, Security, LinkedIn, vulnerability email). No footer text is larger than 24px.
- Headings: uppercase is used only on the home H1, the wordmark, labels, nav and buttons. H2s are Marcellus in sentence case. No mono font is visible outside code blocks.
- Light theme: background pixels in the hero, away from the face's glow radius, are within ΔE 2 of --bg (#faf6ee, or #f4f8fb if the user picks ice), with no blue pool.
- Dark default (pending user confirmation): on a fresh profile with OS light preference, html[data-theme] is 'dark'.
- Lighthouse mobile: performance 95 or higher and budgets.json passes. The gzipped stylesheet is smaller than today's, and the bloom chunk is never requested.
