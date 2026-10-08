/**
 * Content collections (Astro content layer). Three collections feed the site: docs (Markdown pages under /docs),
 * games (the titles listed on /games) and tour (the scripted guide, served as /tour/script.json). The schemas are
 * the contract between the writers and the pages, so a typo in a front matter field fails the build here rather
 * than rendering an empty page.
 */

import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** Sidebar order of the docs sections; their labels are site.docs.sections. */
export const DOC_SECTIONS = ['beings', 'products', 'trust'] as const;
export type DocSection = (typeof DOC_SECTIONS)[number];

/** Their labels are site.games.statuses. */
export const GAME_STATUSES = ['coming-soon', 'released'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

/** A spoken line must fit one breath and one caption bubble. */
const MAX_TOUR_WORDS = 40;

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const docs = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    section: z.enum(DOC_SECTIONS),
    order: z.number().int().nonnegative(),
    updated: z.coerce.date(),
    /** The tour stop "Take the tour from here" starts at; the technology stop when absent. */
    tour: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
  }),
});

const games = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/games' }),
  schema: z.object({
    title: z.string().min(1),
    year: z.number().int().min(2023),
    platform: z.string().min(1),
    status: z.enum(GAME_STATUSES),
    /** Path of a cover image under /public, once there is one. */
    cover: z.string().min(1).optional(),
    links: z.array(z.object({ label: z.string().min(1), href: z.string().min(1) })).optional(),
  }),
});

/** Mirrors TourAction in @emersa/being; the union is spelled out so the YAML is validated at build time. */
const tourAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goto'), target: z.string().min(1) }),
  z.object({ type: z.literal('highlight'), target: z.string().min(1) }),
  z.object({ type: z.literal('point'), side: z.enum(['left', 'right']) }),
  z.object({ type: z.literal('emote'), name: z.enum(['smile', 'nod', 'think', 'neutral']) }),
  z.object({ type: z.literal('open'), what: z.literal('talk') }),
]);

const tour = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/tour' }),
  schema: z.object({
    /** The stop id is also the file name of its voice clip (src/assets/tour/<id>.mp3) and the value of ?tour=. */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    order: z.number().int().positive(),
    anchor: z.string().min(1),
    text: z
      .string()
      .min(1)
      .refine((text) => countWords(text) <= MAX_TOUR_WORDS, {
        message: `A tour line is at most ${MAX_TOUR_WORDS} words`,
      }),
    highlight: z.string().min(1).optional(),
    dwellMs: z.number().int().nonnegative().optional(),
    actions: z.array(tourAction).optional(),
  }),
});

export const collections = { docs, games, tour };

/** The shape the docs helpers need; CollectionEntry<'docs'> satisfies it. */
export interface DocSummary {
  id: string;
  data: { title: string; description: string; section: DocSection; order: number };
}

export interface DocGroup<T extends DocSummary> {
  id: DocSection;
  docs: T[];
}

const sectionIndex = (doc: DocSummary): number => DOC_SECTIONS.indexOf(doc.data.section);

/** Reading order: section by section, then by `order`, so prev/next links walk the sidebar top to bottom. */
export const sortDocs = <T extends DocSummary>(docs: readonly T[]): T[] =>
  [...docs].sort(
    (a, b) =>
      sectionIndex(a) - sectionIndex(b) || a.data.order - b.data.order || a.data.title.localeCompare(b.data.title),
  );

/** The sidebar and the index page share this grouping; empty sections are left out. */
export const groupDocs = <T extends DocSummary>(docs: readonly T[]): DocGroup<T>[] =>
  DOC_SECTIONS.map((id) => ({
    id,
    docs: sortDocs(docs.filter((doc) => doc.data.section === id)),
  })).filter((group) => group.docs.length > 0);
