import {
  AdditiveBlending,
  type Blending,
  Color,
  ColorManagement,
  type IUniform,
  NormalBlending,
  type ShaderMaterial,
} from 'three';
import type { Theme, ThemeColors } from '../types.ts';

/**
 * The custom properties tokens.css reserves for the being. --ribbon and --rim are optional and fall back to --glow;
 * --fan is optional and falls back to --wire.
 */
const COLOR_TOKENS: Readonly<Record<keyof ThemeColors, string>> = {
  wire: '--wire',
  glow: '--glow',
  dot: '--dot',
  echo: '--echo',
  bg3d: '--bg-3d',
  ribbon: '--ribbon',
  rim: '--rim',
  fan: '--fan',
};
const BLOOM_TOKEN = '--bloom';

/** Bloom strength when the page defines no --bloom token (the values tokens.css ships). */
const DEFAULT_BLOOM: Readonly<Record<Theme, number>> = { dark: 0.85, light: 0.35 };

const NO_COLORS: Readonly<ThemeColors> = {
  wire: '',
  glow: '',
  dot: '',
  echo: '',
  bg3d: '',
  ribbon: '',
  rim: '',
  fan: '',
};

export interface ThemeReading {
  colors: ThemeColors;
  bloom: number | null;
}

/** Read the 3D tokens off the document. Missing tokens come back as empty strings so callers keep their last value. */
export function readThemeTokens(
  root: Element | null = typeof document === 'undefined' ? null : document.documentElement,
) {
  const empty: ThemeReading = { colors: { ...NO_COLORS }, bloom: null };
  if (!root) return empty;
  const style = getComputedStyle(root);
  const read = (token: string): string => style.getPropertyValue(token).trim();
  const bloomText = read(BLOOM_TOKEN);
  const bloom = bloomText === '' ? Number.NaN : Number.parseFloat(bloomText);
  const colors = { ...NO_COLORS };
  for (const key of Object.keys(COLOR_TOKENS) as Array<keyof ThemeColors>) colors[key] = read(COLOR_TOKENS[key]);
  return { colors, bloom: Number.isFinite(bloom) ? bloom : null };
}

/**
 * CSS colour text to a Color in three's working space. With colour management on (the default) setStyle already
 * converts sRGB to linear; the manual conversion only covers a host that switched it off. Returns false and leaves
 * the target alone when the text is empty.
 */
export function cssToColor(css: string, target: Color): boolean {
  if (css === '') return false;
  target.setStyle(css);
  if (!ColorManagement.enabled) target.convertSRGBToLinear();
  return true;
}

/**
 * The colour uniforms every being material shares, filled from the page's custom properties. One object per
 * colour is handed to all materials, so setTheme() recolours the whole scene with a handful of writes.
 */
export class ThemeUniforms {
  // White is "no token": what a page without tokens.css shows, and a loud reminder to load it.
  readonly uWire: IUniform<Color> = { value: new Color(1, 1, 1) };
  readonly uGlow: IUniform<Color> = { value: new Color(1, 1, 1) };
  readonly uDot: IUniform<Color> = { value: new Color(1, 1, 1) };
  readonly uEcho: IUniform<Color> = { value: new Color(1, 1, 1) };
  /** The ribbon's colour (--ribbon) and the rim light's (--rim); both are the glow when the page sets neither. */
  readonly uRibbon: IUniform<Color> = { value: new Color(1, 1, 1) };
  readonly uRim: IUniform<Color> = { value: new Color(1, 1, 1) };
  /** The data fan's colour (--fan), the wire colour when the page sets none. */
  readonly uFan: IUniform<Color> = { value: new Color(1, 1, 1) };
  readonly uBg: IUniform<Color> = { value: new Color(0, 0, 0) };
  readonly uIsLight: IUniform<number> = { value: 0 };
  theme: Theme;
  bloom: number;
  private tokens: ThemeColors = { ...NO_COLORS };
  private readonly materials = new Set<ShaderMaterial>();

  constructor(theme: Theme) {
    this.theme = theme;
    this.bloom = DEFAULT_BLOOM[theme];
    this.setTheme(theme);
  }

  /** Additive light on a dark page, ordinary alpha blending on cream where adding light would wash out. */
  blending(): Blending {
    return this.theme === 'dark' ? AdditiveBlending : NormalBlending;
  }

  /** Materials whose blending mode follows the theme. */
  register(material: ShaderMaterial): void {
    this.materials.add(material);
    material.blending = this.blending();
  }

  unregister(material: ShaderMaterial): void {
    this.materials.delete(material);
  }

  /** Re-read the tokens (the html[data-theme] attribute must already be set) and push them into the uniforms. */
  setTheme(theme: Theme): void {
    this.theme = theme;
    const reading = readThemeTokens();
    cssToColor(reading.colors.wire, this.uWire.value);
    cssToColor(reading.colors.glow, this.uGlow.value);
    cssToColor(reading.colors.dot, this.uDot.value);
    cssToColor(reading.colors.echo, this.uEcho.value);
    cssToColor(reading.colors.bg3d, this.uBg.value);
    if (!cssToColor(reading.colors.ribbon, this.uRibbon.value)) this.uRibbon.value.copy(this.uGlow.value);
    if (!cssToColor(reading.colors.rim, this.uRim.value)) this.uRim.value.copy(this.uGlow.value);
    if (!cssToColor(reading.colors.fan, this.uFan.value)) this.uFan.value.copy(this.uWire.value);
    this.tokens = reading.colors;
    this.bloom = reading.bloom ?? DEFAULT_BLOOM[theme];
    this.uIsLight.value = theme === 'light' ? 1 : 0;
    const blending = this.blending();
    for (const material of this.materials) material.blending = blending;
  }

  /** The token text last read, for the HUD or for tests. */
  colors(): ThemeColors {
    return this.tokens;
  }
}
