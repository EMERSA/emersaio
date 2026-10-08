import type { Brain, BrainContext, BrainEvent, BrainMiddleware, BrainNext, TourAction } from '../types.ts';

export type { Brain, BrainContext, BrainEvent, BrainMiddleware, BrainNext };

/** Build a Brain from a respond function, for tests and one-off providers. */
export const createBrain = (
  name: string,
  respond: (context: BrainContext) => AsyncIterable<BrainEvent>,
  dispose?: () => void,
): Brain => ({ name, respond, dispose });

/** A context with nothing but the question, the shape a first turn has. */
export const contextOf = (text: string, extra: Partial<Omit<BrainContext, 'text'>> = {}): BrainContext => ({
  text,
  history: [],
  facts: [],
  ...extra,
});

export interface Reply {
  /** Every token joined. */
  text: string;
  sentences: string[];
  actions: TourAction[];
  reason: 'complete' | 'aborted' | 'limit' | undefined;
  error: string | undefined;
}

/** Drain a stream into one reply, for typed mode and tests. */
export const collect = async (events: AsyncIterable<BrainEvent>): Promise<Reply> => {
  const reply: Reply = { text: '', sentences: [], actions: [], reason: undefined, error: undefined };
  for await (const event of events) {
    switch (event.type) {
      case 'token':
        reply.text += event.text;
        break;
      case 'sentence':
        reply.sentences.push(event.text);
        break;
      case 'action':
        reply.actions.push(event.action);
        break;
      case 'done':
        reply.reason = event.reason ?? 'complete';
        break;
      case 'error':
        reply.error = event.message;
        break;
    }
  }
  return reply;
};
