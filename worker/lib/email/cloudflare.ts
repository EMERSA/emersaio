/**
 * Cloudflare Email Sending (the send_email binding). Not wired: Postmark carries Phase 1, and this adapter only
 * says so when it is picked. It exists so the route and the tests already go through the adapter interface.
 *
 * TODO Phase 2 (if adopted): declare the SEND_EMAIL binding in wrangler.jsonc, build the MIME message here and
 * send it through the binding; then emailAdapter() in index.ts can prefer it when POSTMARK_TOKEN is absent.
 */
import type { EmailAdapter, EmailResult } from './index.ts';

export const cloudflareEmail = (): EmailAdapter => ({
  name: 'cloudflare',
  configured: false,
  async send(): Promise<EmailResult> {
    return { ok: false, error: 'Cloudflare Email Sending is not configured.' };
  },
});
