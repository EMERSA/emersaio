/**
 * Transactional email through Postmark. One secret, POSTMARK_TOKEN, set with `npx wrangler secret put`. The sender
 * must be a verified sender or domain in Postmark, and emersa.io needs SPF, DKIM and DMARC records for any of this
 * to land in an inbox rather than a spam folder (docs/runbooks/dns-records.md).
 */
import { oneLine } from '../text.ts';
import type { EmailAdapter, EmailEnv, EmailMessage, EmailResult } from './index.ts';

export const DEFAULT_FROM = 'Emersa Labs <noreply@emersa.io>';
export const POSTMARK_API = 'https://api.postmarkapp.com/email';

interface PostmarkReply {
  MessageID?: string;
  ErrorCode?: number;
}

const parseReply = (payload: unknown): PostmarkReply => {
  if (!payload || typeof payload !== 'object') return {};
  const { MessageID, ErrorCode } = payload as Record<string, unknown>;
  return {
    MessageID: typeof MessageID === 'string' ? MessageID : undefined,
    ErrorCode: typeof ErrorCode === 'number' ? ErrorCode : undefined,
  };
};

export const postmark = (env: EmailEnv): EmailAdapter => ({
  name: 'postmark',
  configured: Boolean(env.POSTMARK_TOKEN),

  async send(message: EmailMessage): Promise<EmailResult> {
    const token = env.POSTMARK_TOKEN;
    if (!token) return { ok: false, error: 'POSTMARK_TOKEN is not set' };
    const body = {
      From: env.POSTMARK_FROM || DEFAULT_FROM,
      To: oneLine(message.to),
      ReplyTo: message.replyTo ? oneLine(message.replyTo) : undefined,
      Subject: oneLine(message.subject),
      TextBody: message.text,
      MessageStream: 'outbound',
      Tag: message.tag,
    };
    try {
      const response = await fetch(POSTMARK_API, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': token,
        },
        body: JSON.stringify(body),
      });
      const reply = parseReply(await response.json().catch(() => null));
      // Postmark's error text can quote the addresses involved, so only the codes are kept for the log.
      if (!response.ok || reply.ErrorCode) {
        return { ok: false, error: `Postmark ${response.status} (code ${reply.ErrorCode ?? 'none'})` };
      }
      return { ok: true, id: reply.MessageID };
    } catch (error) {
      return { ok: false, error: `Postmark unreachable (${error instanceof Error ? error.name : 'error'})` };
    }
  },
});
