import type { TourScript, TourStop, VisemeCue, VoiceClip } from '../types.ts';

export type { TourScript, TourStop, VoiceClip };

/** The pause after a line before the tour moves on by itself. */
export const DEFAULT_DWELL_MS = 900;

/** Where progress lives in localStorage (docs/CONVENTIONS.md lists the key). */
export const TOUR_STORAGE_KEY = 'em-tour';

export interface TourProgress {
  stopId: string;
  at: number;
}

/** Index of a stop by id; unknown or missing ids start from the beginning. */
export const stopIndex = (script: TourScript, id?: string): number => {
  if (id === undefined || id === '') return 0;
  const index = script.stops.findIndex((stop) => stop.id === id);
  return index < 0 ? 0 : index;
};

export const hasVoice = (script: TourScript): boolean => script.stops.some((stop) => stop.voice !== undefined);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isCue = (value: unknown): value is VisemeCue =>
  Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number';

const isVoice = (value: unknown): value is VoiceClip =>
  isRecord(value) &&
  typeof value.src === 'string' &&
  typeof value.durationMs === 'number' &&
  Array.isArray(value.visemes) &&
  value.visemes.every(isCue);

const isStop = (value: unknown): value is TourStop =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.anchor === 'string' &&
  typeof value.text === 'string' &&
  (value.highlight === undefined || typeof value.highlight === 'string') &&
  (value.dwellMs === undefined || typeof value.dwellMs === 'number') &&
  (value.actions === undefined || Array.isArray(value.actions)) &&
  (value.voice === undefined || isVoice(value.voice));

/** Runtime check for the JSON behind /tour/script.json, so a broken deploy fails loudly instead of oddly. */
export const isTourScript = (value: unknown): value is TourScript =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.persona === 'string' &&
  Array.isArray(value.stops) &&
  value.stops.every(isStop);

export const parseProgress = (raw: string | null | undefined): TourProgress | undefined => {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.stopId === 'string' && typeof value.at === 'number') {
      return { stopId: value.stopId, at: value.at };
    }
  } catch {
    // Anything but our own shape is ignored; storage is a convenience, never a dependency.
  }
  return undefined;
};

/** Fetch and validate the script. The shell calls this once the being is mounted, never before. */
export const loadTourScript = async (
  url = '/tour/script.json',
  fetchImpl: typeof fetch = fetch,
): Promise<TourScript> => {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Tour script unavailable (${response.status})`);
  const data: unknown = await response.json();
  if (!isTourScript(data)) throw new Error('Tour script has an unexpected shape');
  return data;
};
