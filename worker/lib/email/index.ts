/**
 * Outbound email behind one small interface, so the contact route does not care which service sends. Postmark
 * carries Phase 1 (postmark.ts); the Cloudflare adapter (cloudflare.ts) is a placeholder that reports itself
 * unconfigured until the send_email binding is wired.
 */
import type { Env } from '../env.ts';
import { cloudflareEmail } from './cloudflare.ts';
import { postmark } from './postmark.ts';

export type EmailEnv = Pick<Env, 'POSTMARK_TOKEN' | 'POSTMARK_FROM'>;

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text only: the people who read these use ordinary mail clients, and text cannot carry a script. */
  text: string;
  /** The visitor's address, so a reply from the inbox goes straight back to them. */
  replyTo?: string;
  /** A tag the service groups statistics by, for example "contact". */
  tag?: string;
}

export interface EmailResult {
  ok: boolean;
  id?: string;
  /** A short classification with codes, never the message or the addresses, so it can be logged. */
  error?: string;
}

export interface EmailAdapter {
  readonly name: string;
  /** False when the secret or binding the adapter needs is absent; a route then answers 503 instead of trying. */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

/** Postmark when its token is set, otherwise the Cloudflare adapter, which says it is not configured. */
export const emailAdapter = (env: EmailEnv): EmailAdapter => (env.POSTMARK_TOKEN ? postmark(env) : cloudflareEmail());
