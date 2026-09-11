import type { ReactElement } from 'react';
import { Resend } from 'resend';

export interface SendEmailOptions {
  to: string;
  subject: string;
  react: ReactElement;
}

/**
 * Send a transactional email via Resend. `apiKey` and `from` come from Worker
 * bindings (`c.env.RESEND_API_KEY`, `c.env.EMAIL_FROM`). `from` MUST be a
 * verified Resend sender or delivery fails silently.
 */
export async function sendEmail(
  opts: SendEmailOptions,
  apiKey: string,
  from: string,
): Promise<void> {
  const { error } = await new Resend(apiKey).emails.send({ from, ...opts });
  if (error) throw new Error(`email send failed: ${error.message}`);
}
