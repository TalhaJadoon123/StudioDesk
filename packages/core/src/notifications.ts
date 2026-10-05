import {
  EVENT_NOTIFICATION_MAP,
  formatMoney,
  newNotificationId,
  nowIso,
  sortBy,
  type Currency,
  type Notification,
  type NotificationKind,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';

export function notificationsRepo(ctx: CoreContext) {
  return ctx.repo.table('notifications');
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

export async function queueNotification(
  ctx: CoreContext,
  input: {
    memberId?: string;
    kind: NotificationKind;
    title: string;
    body: string;
    data?: Record<string, string | number>;
    channel?: Notification['channel'];
    /** Delivery is handled by the transport; the row is created immediately. */
    sent?: boolean;
  },
): Promise<Notification> {
  const at = ctx.now().toISOString();
  return notificationsRepo(ctx).insert({
    id: newNotificationId(),
    memberId: input.memberId,
    studioId: ctx.studioId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    data: input.data,
    channel: input.channel ?? 'in-app',
    sentAt: input.sent === false ? undefined : at,
    createdAt: at,
  });
}

export async function listNotifications(
  ctx: CoreContext,
  query: { memberId?: string; unreadOnly?: boolean; limit?: number; kind?: NotificationKind } = {},
): Promise<Notification[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.kind) filter.kind = query.kind;
  if (query.unreadOnly) filter.readAt = { $isNull: true };
  const rows = await notificationsRepo(ctx).list({ filter: filter as never });
  const sorted = sortBy(rows, (n) => n.createdAt ?? '', 'desc');
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

export async function unreadCount(ctx: CoreContext, memberId?: string): Promise<number> {
  const rows = await listNotifications(ctx, { memberId, unreadOnly: true });
  return rows.length;
}

export async function markRead(ctx: CoreContext, id: string): Promise<Notification> {
  return notificationsRepo(ctx).update(id, { readAt: ctx.now().toISOString() });
}

export async function markAllRead(ctx: CoreContext, memberId?: string): Promise<number> {
  const rows = await listNotifications(ctx, { memberId, unreadOnly: true });
  for (const row of rows) await markRead(ctx, row.id);
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

export interface TemplateVars {
  memberName?: string;
  className?: string;
  classId?: string;
  startTime?: string;
  amountCents?: number;
  currency?: Currency;
  position?: number;
  planName?: string;
  credits?: number;
  title?: string;
  body?: string;
}

export interface Template {
  title: string;
  body: string;
  emailSubject?: string;
  emailHtml?: string;
}

const fmtWhen = (iso?: string): string => (iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : 'soon');

/** Copy for every member-facing notification. Also used by the email sender. */
export const TEMPLATES: Record<NotificationKind, (vars: TemplateVars) => Template> = {
  'waitlist-promoted': (v) => ({
    title: "You're in!",
    body: `A spot opened up in ${v.className} and you are now booked. See you ${fmtWhen(v.startTime)}.`,
    emailSubject: `You're off the waitlist for ${v.className}`,
    emailHtml: `<p>Good news - a spot opened up in <strong>${v.className}</strong> and you are now confirmed.</p><p>${fmtWhen(v.startTime)}</p>`,
  }),
  'waitlist-joined': (v) => ({
    title: 'You are on the waitlist',
    body: `You are #${v.position ?? '?'} on the waitlist for ${v.className}. We will text you the moment a spot frees up.`,
    emailSubject: `You are on the waitlist for ${v.className}`,
  }),
  'booking-confirmed': (v) => ({
    title: 'Booking confirmed',
    body: `You are booked into ${v.className} on ${fmtWhen(v.startTime)}.`,
    emailSubject: `Confirmed: ${v.className}`,
  }),
  'booking-cancelled': (v) => ({
    title: 'Booking cancelled',
    body: `Your booking for ${v.className} on ${fmtWhen(v.startTime)} has been cancelled.`,
    emailSubject: `Cancelled: ${v.className}`,
  }),
  'class-cancelled': (v) => ({
    title: 'Class cancelled',
    body: `${v.className} has been cancelled. Your credit has been returned.`,
    emailSubject: `${v.className} cancelled`,
  }),
  'payment-receipt': (v) => ({
    title: 'Payment received',
    body: `Thanks - we received ${formatMoney(v.amountCents ?? 0, v.currency)}. Receipt attached.`,
    emailSubject: `Your receipt - ${formatMoney(v.amountCents ?? 0, v.currency)}`,
  }),
  'payment-failed': (v) => ({
    title: 'Payment failed',
    body: `We could not process your last payment${v.amountCents ? ` of ${formatMoney(v.amountCents, v.currency)}` : ''}. Please update your card to keep your membership active.`,
    emailSubject: 'Action needed: payment failed',
  }),
  'pack-expiring': (v) => ({
    title: `${v.credits ?? 0} credits left`,
    body: `Your remaining credits are running low. Top up before you miss a class.`,
    emailSubject: 'Your class credits are running low',
  }),
  'membership-paused': (v) => ({
    title: 'Membership paused',
    body: 'Your membership has been paused after an unsuccessful payment. Update your card to resume.',
    emailSubject: 'Your membership is paused',
  }),
  'churn-alert': (v) => ({
    title: 'We miss you',
    body: 'It has been a while since your last visit. Your mat is waiting.',
    emailSubject: 'We miss you',
  }),
  digest: (v) => ({
    title: v.title ?? 'Your week at the studio',
    body: v.body ?? '',
  }),
};

export async function notify(
  ctx: CoreContext,
  kind: NotificationKind,
  vars: TemplateVars & { memberId?: string; channel?: Notification['channel']; data?: Record<string, string | number> },
): Promise<Notification | null> {
  if (!vars.memberId) return null;
  const template = TEMPLATES[kind];
  if (!template) return null;
  const rendered = template(vars);
  return queueNotification(ctx, {
    memberId: vars.memberId,
    kind,
    title: rendered.title,
    body: rendered.body,
    data: vars.data,
    channel: vars.channel,
  });
}

/* -------------------------------------------------------------------------- */
/* Event fan-out                                                              */
/* -------------------------------------------------------------------------- */

export interface SubscriberHandle {
  dispose: () => void;
}

/**
 * Wires domain events to member notifications. Every studio service calls this
 * once at boot; the returned handle removes the listeners again (used in tests).
 */
export function connectNotifications(ctx: CoreContext): SubscriberHandle {
  const unsubscribers: Array<() => void> = [];

  const className = async (classId: string) =>
    (await ctx.repo.table('classes').findById(classId))?.name ?? 'your class';
  const classStart = async (classId: string) =>
    (await ctx.repo.table('classes').findById(classId))?.startTime;

  unsubscribers.push(
    ctx.events.on('booking.promoted', async ({ memberId, classId }) => {
      await notify(ctx, 'waitlist-promoted', {
        memberId,
        className: await className(classId),
        startTime: await classStart(classId),
        data: { classId, deepLink: `/classes/${classId}` },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('booking.waitlisted', async ({ memberId, classId, position }) => {
      await notify(ctx, 'waitlist-joined', {
        memberId,
        position,
        className: await className(classId),
        startTime: await classStart(classId),
        data: { classId, position },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('booking.created', async ({ memberId, classId }) => {
      await notify(ctx, 'booking-confirmed', {
        memberId,
        className: await className(classId),
        startTime: await classStart(classId),
        data: { classId },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('booking.cancelled', async ({ memberId, classId }) => {
      await notify(ctx, 'booking-cancelled', {
        memberId,
        className: await className(classId),
        startTime: await classStart(classId),
        data: { classId },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('class.cancelled', async ({ classId, name }) => {
      const bookings = await ctx.repo
        .table('bookings')
        .list({ filter: { classId, status: 'booked' } });
      for (const booking of bookings) {
        await notify(ctx, 'class-cancelled', {
          memberId: booking.memberId,
          className: name,
          classId,
          data: { classId },
        });
      }
    }),
  );

  unsubscribers.push(
    ctx.events.on('invoice.paid', async ({ memberId, totalCents }) => {
      if (!memberId) return;
      await notify(ctx, 'payment-receipt', {
        memberId,
        amountCents: totalCents,
        currency: 'usd',
        data: { totalCents },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('payment.failed', async ({ memberId, failureCode }) => {
      if (!memberId) return;
      await notify(ctx, 'payment-failed', {
        memberId,
        data: { failureCode: failureCode ?? 'unknown' },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('pack.low', async ({ memberId, creditsRemaining }) => {
      await notify(ctx, 'pack-expiring', {
        memberId,
        credits: creditsRemaining,
        data: { creditsRemaining },
      });
    }),
  );

  unsubscribers.push(
    ctx.events.on('membership.paused', async ({ memberId }) => {
      await notify(ctx, 'membership-paused', { memberId, data: {} });
    }),
  );

  return {
    dispose: () => {
      for (const off of unsubscribers) off();
    },
  };
}

/** Generic fan-out used by billing for kinds that are not event-driven. */
export function notificationKindFor(eventType: string): NotificationKind | undefined {
  return EVENT_NOTIFICATION_MAP[eventType as keyof typeof EVENT_NOTIFICATION_MAP];
}

export { nowIso };