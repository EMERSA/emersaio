/**
 * /docs/index.json: the build-time list of docs ids. Phase 2 validates "?ask=<id>" and the page context sent to
 * the brain against this list, so a visitor can never point the being at text of their own choosing.
 */

import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { sortDocs } from '../../content.config.ts';

export const GET: APIRoute = async () => {
  const docs = sortDocs(await getCollection('docs'));
  const index = docs.map(({ id, data }) => ({
    id,
    title: data.title,
    description: data.description,
    section: data.section,
  }));
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
