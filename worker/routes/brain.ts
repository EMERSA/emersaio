/**
 * POST /api/brain: the NIM text brain as server-sent events ("token", "action", "done", "error"). Only where
 * NIM_BASE_URL is set (wrangler dev and beta; the hosted NIM is licensed for prototyping only), with NVIDIA_API_KEY.
 * The visitor must have consented (the em_vid cookie); 40 turns per session, 200 per day. The system prompt carries
 * the site's facts, what Emily remembers and the visitor's attached documents.
 */
import { MARKER_HELP, MarkerParser } from '../lib/actions.ts';
import type { ApiContext } from '../lib/compose.ts';
import { fail } from '../lib/http.ts';
import {
  bump,
  documentContext,
  listFacts,
  MAX_TURNS_PER_DAY,
  MAX_TURNS_PER_SESSION,
  type MemoryDb,
  openSession,
  recentTurns,
  sessionTurn,
  startSession,
} from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import { readSse, sseStream } from '../lib/sse.ts';
import { multiLine, oneLine } from '../lib/text.ts';
import { consented, store } from '../lib/visitor.ts';

export const MAX_BRAIN_TEXT = 2048;
/** The body: the text plus a page id and the JSON around them. */
export const MAX_BRAIN_BYTES = 4096;
export const MAX_TOKENS = 300;
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const BRAIN_OFF = 'The text brain is not available here.';

export const PERSONA = [
  'You are Emily, the AI guide of emersa.io, the site of Emersa Labs. You are an AI and say so if asked.',
  'Emersa Labs builds intelligent NPCs and synthetic beings: real-time 3D characters that listen, think, speak and remember.',
  'Answer in plain British English, warmly and briefly: two or three sentences. Never invent clients, prices or figures.',
  'If you do not know, say so and suggest the contact form or sales@emersa.io.',
  MARKER_HELP,
].join('\n');

export async function systemPrompt(db: MemoryDb, id: string, page?: string): Promise<string> {
  const [facts, docs] = await Promise.all([listFacts(db, id), documentContext(db, id)]);
  let prompt = PERSONA;
  if (page) prompt += `\nThe visitor is on the page section "${page}".`;
  if (facts.length)
    prompt += `\nWhat you remember about the visitor: ${facts.map((f) => `${f.key}: ${f.value}`).join('; ')}.`;
  if (docs) prompt += `\nThe visitor shared these documents; use them when relevant:\n${docs}`;
  return prompt;
}

export async function brain(c: ApiContext): Promise<Response> {
  const { env } = c;
  if (!env.NIM_BASE_URL || !env.NVIDIA_API_KEY) {
    writePoint(env, c.route, '503-binding');
    return fail(503, BRAIN_OFF);
  }
  const s = store(c);
  if (s instanceof Response) return s;
  const text = multiLine(c.fields.text, MAX_BRAIN_TEXT + 1);
  if (!text) return fail(422, 'Say something first.');
  if (new TextEncoder().encode(text).length > MAX_BRAIN_TEXT) return fail(413, 'That message is too long.');
  const page = /^[a-z][a-z0-9-]{0,31}$/.test(c.fields.page ?? '') ? c.fields.page : undefined;
  const id = await consented(c, s);
  if (id instanceof Response) return id;

  const session = (await openSession(s.db, id))?.id ?? (await startSession(s.db, id, 'nim'));
  if ((await sessionTurn(s.db, session)) > MAX_TURNS_PER_SESSION) {
    return fail(429, 'This conversation has reached its length. Start a new one to carry on.');
  }
  if ((await bump(s.db, id, 'turns')) > MAX_TURNS_PER_DAY) {
    return fail(429, 'That is all the talking for today. Please come back tomorrow.');
  }

  const history = (await recentTurns(s.db, id, 12)).map((t) => ({
    role: t.role === 'user' ? 'user' : 'assistant',
    content: t.text,
  }));
  const messages = [
    { role: 'system', content: await systemPrompt(s.db, id, page) },
    ...history,
    { role: 'user', content: text },
  ];

  const { writer, response } = sseStream();
  const run = async (): Promise<void> => {
    try {
      const upstream = await fetch(`${env.NIM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.NIM_MODEL, messages, stream: true, max_tokens: MAX_TOKENS }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok || !upstream.body) {
        writePoint(env, c.route, `upstream-${upstream.status}`);
        await writer.send('error', { message: 'Emily cannot think right now. Please try again.' });
        return;
      }
      const markers = new MarkerParser();
      for await (const data of readSse(upstream.body)) {
        if (data === '[DONE]') break;
        let delta = '';
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === 'string') delta = content;
        } catch {
          continue;
        }
        const { text: shown, actions } = markers.push(delta);
        if (shown) await writer.send('token', { text: shown });
        for (const action of actions) await writer.send('action', action);
      }
      const rest = markers.flush();
      if (rest) await writer.send('token', { text: rest });
      await writer.send('done', { reason: 'complete' });
    } catch (error) {
      console.error('brain: stream failed', oneLine(error instanceof Error ? error.name : 'unknown', 40));
      await writer.send('error', { message: 'Emily lost her train of thought. Please try again.' });
    } finally {
      await writer.close();
    }
  };
  c.ctx.waitUntil(run());
  return response;
}
