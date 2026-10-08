import type { BrainContext, BrainMiddleware } from '../../types.ts';

export const PAGE_EXCERPT_MAX_CHARS = 800;

/** Docs ids are slugs; anything else never reaches a prompt. */
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PageContextOptions {
  /** The page the visitor is on, added to every context that does not name one. */
  page?: BrainContext['page'];
  /** The build-time list of docs ids; a page outside it is dropped. */
  ids?: readonly string[];
  maxChars?: number;
}

/** Attach the current page's excerpt so "this page" means something, with the id checked and the text trimmed. */
export const pageContext = (options: PageContextOptions = {}): BrainMiddleware =>
  async function* withPage(context, next) {
    const page = context.page ?? options.page;
    const allowed =
      page !== undefined && PAGE_ID.test(page.id) && (options.ids === undefined || options.ids.includes(page.id));
    if (!allowed) {
      const { page: _dropped, ...rest } = context;
      yield* next(rest);
      return;
    }
    const maxChars = options.maxChars ?? PAGE_EXCERPT_MAX_CHARS;
    yield* next({ ...context, page: { id: page.id, title: page.title, excerpt: page.excerpt.slice(0, maxChars) } });
  };
