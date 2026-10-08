import type { BrainMiddleware } from '../../types.ts';

export type TokenUnit = 'tokens' | 'chars';

/** What one token event is worth to the meter: a token, or its characters (the typewriter counts characters). */
export const countUnits = (text: string, unit: TokenUnit): number => (unit === 'chars' ? text.length : 1);

/**
 * Feed the sparkle: every token that reaches the shell also reaches the callback (being.tokens), so the mesh
 * glitters at the rate the brain thinks. Innermost of the event filters, after guardrails has cleaned.
 */
export const tokenMeter = (onToken: (n: number) => void, unit: TokenUnit = 'tokens'): BrainMiddleware =>
  async function* meter(context, next) {
    for await (const event of next(context)) {
      if (event.type === 'token' && event.text.length > 0) onToken(countUnits(event.text, unit));
      yield event;
    }
  };
