/**
 * /tour/script.json: the whole scripted tour as one TourScript. Stops come from src/content/tour/*.yaml in `order`;
 * a stop gets a voice clip when both src/assets/tour/<id>.mp3 and <id>.json exist at build time, and simply has
 * no voice otherwise (the tour then runs captions-only for that stop). The globs tolerate an empty assets folder.
 */

import { getCollection } from 'astro:content';
import type { TourScript, TourStop, VisemeCue, VoiceClip } from '@emersa/being';
import type { APIRoute } from 'astro';
import { site } from '../../data/site.ts';

/** Hashed, same-origin URLs of the baked clips. */
const clipUrls = import.meta.glob<string>('../../assets/tour/*.mp3', { eager: true, query: '?url', import: 'default' });
/** The viseme timelines next to them: { durationMs, visemes: [[offsetMs, viseme, weight?]] }. */
const timelines = import.meta.glob<unknown>('../../assets/tour/*.json', { eager: true, import: 'default' });

/** Canonical Microsoft viseme ids run 0-21. */
const VISEME_MAX = 21;

interface Timeline {
  durationMs: number;
  visemes: VisemeCue[];
}

const stopIdOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');

const byStopId = <T>(modules: Record<string, T>): Map<string, T> =>
  new Map(Object.entries(modules).map(([path, module]) => [stopIdOf(path), module]));

const isUnitWeight = (value: unknown): boolean => typeof value === 'number' && value >= 0 && value <= 1;

const isCue = (value: unknown): value is VisemeCue =>
  Array.isArray(value) &&
  (value.length === 2 || value.length === 3) &&
  typeof value[0] === 'number' &&
  value[0] >= 0 &&
  Number.isInteger(value[1]) &&
  value[1] >= 0 &&
  value[1] <= VISEME_MAX &&
  (value.length === 2 || isUnitWeight(value[2]));

/** A malformed timeline is a bake error, so it fails the build instead of shipping a silent stop. */
const parseTimeline = (id: string, value: unknown): Timeline => {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Tour clip "${id}": the timeline JSON must be an object`);
  }
  const { durationMs, visemes } = value as { durationMs?: unknown; visemes?: unknown };
  if (typeof durationMs !== 'number' || !(durationMs > 0)) {
    throw new Error(`Tour clip "${id}": durationMs must be a positive number`);
  }
  if (!Array.isArray(visemes) || !visemes.every(isCue)) {
    throw new Error(`Tour clip "${id}": visemes must be [offsetMs, viseme 0-${VISEME_MAX}, weight?] tuples`);
  }
  return { durationMs, visemes };
};

const clips = byStopId(clipUrls);
const cues = byStopId(timelines);

const voiceFor = (id: string): VoiceClip | undefined => {
  const src = clips.get(id);
  const timeline = cues.get(id);
  if (src === undefined || timeline === undefined) {
    return undefined;
  }
  return { src, ...parseTimeline(id, timeline) };
};

export const GET: APIRoute = async () => {
  const entries = await getCollection('tour');
  const ordered = [...entries].sort((a, b) => a.data.order - b.data.order);

  const seen = new Set<string>();
  for (const { data } of ordered) {
    if (seen.has(data.id)) {
      throw new Error(`Tour stop id "${data.id}" is used twice`);
    }
    seen.add(data.id);
  }

  // JSON.stringify drops the undefined optionals, so a stop without a highlight or a clip stays small.
  const stops: TourStop[] = ordered.map(({ data }) => ({
    id: data.id,
    anchor: data.anchor,
    text: data.text,
    highlight: data.highlight,
    dwellMs: data.dwellMs,
    actions: data.actions,
    voice: voiceFor(data.id),
  }));

  const script: TourScript = { version: 1, persona: site.products.emily.name, stops };
  return new Response(JSON.stringify(script), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
