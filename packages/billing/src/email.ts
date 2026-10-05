import { formatMoney, type Currency, type Invoice, type Notification } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { TEMPLATES } from '@studiodesk/core';

/**
 * Email delivery.
 *
 * Two transports, both free:
 *   - Resend free tier (3,000 emails/month)
 *   - useSend (open source, self-hostable - run it on the same free Cloudflare
 *     account and there is no third-party quota at all)
 *
 * With neither configured, messages are recorded but not delivered, so the UI
 * can still show what would have been sent.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface SendResult {
  id: string;
  provider: 'resend' | 'usesend' | 'outbox';
  queued: boolean;
  error?: string;
}

export interface EmailConfig {
  resendApiKey?: string;
  from?: string;
  useSendUrl?: string;
  useSendToken?: string;
  /** Fail loudly instead of falling back to the outbox. */
  strict?: boolean;
}

export function emailConfigFromEnv(): EmailConfig {
  return {
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM ?? 'StudioDesk <onboarding@resend.dev>',
    useSendUrl: process.env.USE_SEND_URL,
    useSendToken: process.env.USE_SEND_TOKEN,
  };
}

/** Resend: `POST https://api.resend.com/emails`. */
async function sendViaResend(message: EmailMessage, config: EmailConfig): Promise<SendResult> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from ?? config.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo,
      tags: message.tags?.map((tag) => ({ name: tag.name, value: tag.value })),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${payload.message ?? 'unknown error'}`);
  }
  return { id: payload.id ?? 'unknown', provider: 'resend', queued: true };
}

/** useSend: `POST {url}/api/v1/email`. */
async function sendViaUseSend(message: EmailMessage, config: EmailConfig): Promise<SendResult> {
  const base = config.useSendUrl!.replace(/\/$/, '');
  const response = await fetch(`${base}/api/v1/email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.useSendToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from ?? config.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    throw new Error(`useSend ${response.status}: ${payload.message ?? 'unknown error'}`);
  }
  return { id: payload.id ?? 'unknown', provider: 'usesend', queued: true };
}

export async function sendEmail(
  message: EmailMessage,
  config: EmailConfig = emailConfigFromEnv(),
): Promise<SendResult> {
  if (config.resendApiKey) {
    try {
      return await sendViaResend(message, config);
    } catch (error) {
      if (config.strict) throw error;
      return { id: 'failed', provider: 'resend', queued: false, error: String(error) };
    }
  }
  if (config.useSendUrl) {
    try {
      return await sendViaUseSend(message, config);
    } catch (error) {
      if (config.strict) throw error;
      return { id: 'failed', provider: 'usesend', queued: false, error: String(error) };
    }
  }
  return { id: 'no-transport', provider: 'outbox', queued: false, error: 'No email transport configured' };
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

export function wrapHtml(heading: string, body: string, footer?: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">
    <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${heading}</h1>
    ${body}
    ${footer ? `<p style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">${footer}</p>` : ''}
  </div>
</body></html>`;
}

export function bookingEmail(ctx: CoreContext, classId: string, kind: 'created' | 'cancelled' | 'promoted') {
  return async (memberId: string): Promise<EmailMessage | null> => {
    const [member, klass] = await Promise.all([
      ctx.repo.table('members').findById(memberId),
      ctx.repo.table('classes').findById(classId),
    ]);
    if (!member?.email || !klass) return null;
    const template =
      kind === 'created'
        ? TEMPLATES['booking-confirmed']({ className: klass.name, startTime: klass.startTime })
        : kind === 'promoted'
          ? TEMPLATES['waitlist-promoted']({ className: klass.name, startTime: klass.startTime })
          : TEMPLATES['booking-cancelled']({ className: klass.name, startTime: klass.startTime });

    return {
      to: member.email,
      subject: template.emailSubject ?? template.title,
      html: wrapHtml(
        template.title,
        `<p style="color:#334155;font-size:15px;line-height:1.6">${template.body}</p>`,
        'Cancel any time from the StudioDesk app or your account page.',
      ),
      text: template.body,
      tags: [{ name: 'kind', value: `booking-${kind}` }],
    };
  };
}

export function invoiceEmail(
  invoice: Invoice,
  memberName?: string,
  studioName = 'StudioDesk Studio',
): EmailMessage | null {
  if (!memberName) return null;
  const currency = invoice.currency as Currency;
  return {
    to: '',
    subject: `Invoice ${invoice.number} - ${formatMoney(invoice.totalCents, currency)}`,
    html: wrapHtml(
      `Invoice ${invoice.number}`,
      `<p style="color:#334155">Hi ${memberName}, thanks for your payment.</p>
       <table style="width:100%;border-collapse:collapse;margin-top:16px">
         ${invoice.lineItems
           .map(
             (item) =>
               `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#334155">${item.description}</td>
               <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;color:#0f172a">${formatMoney(item.amountCents, currency)}</td></tr>`,
           )
           .join('')}
         <tr><td style="padding:12px 0;font-weight:600">Total</td>
         <td style="padding:12px 0;text-align:right;font-weight:600">${formatMoney(invoice.totalCents, currency)}</td></tr>
       </table>`,
      studioName,
    ),
    tags: [{ name: 'kind', value: 'invoice' }],
  };
}

/** Payment-failed reminder used by the dunning runner. */
export async function paymentFailedEmail(
  ctx: CoreContext,
  memberId: string,
  amountCents?: number,
): Promise<EmailMessage | null> {
  const member = await ctx.repo.table('members').findById(memberId);
  if (!member?.email) return null;
  const template = TEMPLATES['payment-failed']({ amountCents, currency: 'usd' });
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';
  return {
    to: member.email,
    subject: template.emailSubject ?? template.title,
    html: wrapHtml(
      template.title,
      `<p style="color:#334155;font-size:15px;line-height:1.6">${template.body}</p>
       <p><a href="${baseUrl}/settings/billing"
             style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Update payment method</a></p>`,
      'We will retry your payment a few times before anything changes.',
    ),
    text: template.body,
    tags: [{ name: 'kind', value: 'payment-failed' }],
  };
}

/** Sends queued in-app notifications by email, in one pass. */
export async function flushNotifications(
  ctx: CoreContext,
  config: EmailConfig = emailConfigFromEnv(),
  limit = 50,
): Promise<{ attempted: number; sent: number; failed: number }> {
  const notifications = await ctx.repo.table('notifications').list({ filter: { channel: 'in-app' } });
  const result = { attempted: 0, sent: 0, failed: 0 };

  for (const notification of notifications.slice(0, limit)) {
    const message = await notificationToEmail(ctx, notification);
    if (!message) continue;
    result.attempted += 1;
    const sendResult = await sendEmail(message, config);
    if (sendResult.queued) {
      result.sent += 1;
      await ctx.repo
        .table('notifications')
        .update(notification.id, { channel: 'email', sentAt: ctx.now().toISOString() });
    } else {
      result.failed += 1;
    }
  }
  return result;
}

async function notificationToEmail(
  ctx: CoreContext,
  notification: Notification,
): Promise<EmailMessage | null> {
  if (!notification.memberId) return null;
  const member = await ctx.repo.table('members').findById(notification.memberId);
  if (!member?.email) return null;
  const render = TEMPLATES[notification.kind];
  const template = render ? render({}) : undefined;
  return {
    to: member.email,
    subject: template?.emailSubject ?? notification.title,
    html: wrapHtml(
      notification.title,
      `<p style="color:#334155;font-size:15px">${notification.body}</p>`,
    ),
    text: notification.body,
    tags: [{ name: 'kind', value: notification.kind }],
  };
}