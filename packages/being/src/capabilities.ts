import type { Quality } from './types.ts';

/** What the shell needs to decide whether, when and how to mount the being. */
export interface Capabilities {
  webgl2: boolean;
  touch: boolean;
  hoverFine: boolean;
  lowEnd: boolean;
  saveData: boolean;
  reducedMotion: boolean;
  maxPixelRatio: number;
  suggestedQuality: Quality;
}

/** Hints that are not in every browser's Navigator type yet. */
interface NavigatorHints {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

const matches = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches;

/** True on coarse-pointer devices; the stage uses it for the idle frame cap and the antialias decision. */
export const isCoarsePointer = (): boolean => matches('(pointer: coarse)');

const probeWebgl2 = (): boolean => {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    // The probe context is thrown away at once so it never counts against the browser's context limit.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
};

export function detectCapabilities(): Capabilities {
  const hints: NavigatorHints = typeof navigator === 'undefined' ? {} : (navigator as Navigator & NavigatorHints);
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  const touch = isCoarsePointer();
  const hoverFine = matches('(hover: hover) and (pointer: fine)');
  const saveData = hints.connection?.saveData === true;
  const lowEnd =
    (hints.deviceMemory !== undefined && hints.deviceMemory <= 4) || (cores !== undefined && cores <= 4) || saveData;
  const reducedMotion = matches('(prefers-reduced-motion: reduce)');
  const webgl2 = probeWebgl2();

  let suggestedQuality: Quality = 'full';
  if (!webgl2 || reducedMotion) suggestedQuality = 'poster';
  else if (lowEnd || saveData) suggestedQuality = 'lite';
  else if (touch) suggestedQuality = 'balanced';

  return {
    webgl2,
    touch,
    hoverFine,
    lowEnd,
    saveData,
    reducedMotion,
    maxPixelRatio: touch ? 1.5 : 2,
    suggestedQuality,
  };
}
