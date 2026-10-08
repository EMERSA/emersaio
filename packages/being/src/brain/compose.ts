import type { Brain, BrainContext, BrainEvent, BrainMiddleware } from '../types.ts';

/**
 * Wrap a brain in middleware, koa style: the first middleware is the outermost. It sees the context first
 * (so context shapers go first) and the events last (so event filters that must run before others, like
 * guardrails before the sentence chunker, go nearest the brain). See standardChain() in brain/index.ts.
 */
export const compose =
  (middlewares: readonly BrainMiddleware[]) =>
  (brain: Brain): Brain => {
    const run = (index: number, context: BrainContext): AsyncIterable<BrainEvent> => {
      const middleware = middlewares[index];
      if (middleware === undefined) return brain.respond(context);
      return middleware(context, (next) => run(index + 1, next));
    };
    return {
      name: brain.name,
      respond: (context) => run(0, context),
      dispose: () => brain.dispose?.(),
    };
  };
