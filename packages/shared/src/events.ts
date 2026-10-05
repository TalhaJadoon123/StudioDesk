import type { NotificationKind } from './types.js';

/**
 * Domain events. A single in-process bus powers webhooks, email, push
 * notifications and the activity feed without pulling in a queue.
 */
export interface DomainEventMap {
  'member.created': { memberId: string; name: string };
  'member.updated': { memberId: string; changes: string[] };
  'member.cancelled': { memberId: string };
  'member.paused': { memberId: string; until: string };
  'member.resumed': { memberId: string };
  'booking.created': { bookingId: string; memberId: string; classId: string };
  'booking.cancelled': { bookingId: string; memberId: string; classId: string; late: boolean };
  'booking.promoted': { bookingId: string; memberId: string; classId: string };
  'booking.waitlisted': { bookingId: string; memberId: string; classId: string; position: number };
  'attendance.recorded': { attendanceId: string; memberId: string; classId: string; method: string };
  'class.created': { classId: string; name: string };
  'class.updated': { classId: string };
  'class.cancelled': { classId: string; name: string; affected: number };
  'class.completed': { classId: string; name: string; noShows: number; attended: number };
  'invoice.created': { invoiceId: string; memberId?: string; totalCents: number };
  'invoice.paid': { invoiceId: string; memberId?: string; totalCents: number };
  'payment.succeeded': { chargeId: string; memberId?: string; amountCents: number };
  'payment.failed': { chargeId: string; memberId?: string; failureCode?: string };
  'membership.started': { membershipId: string; memberId: string; planId: string };
  'membership.paused': { membershipId: string; memberId: string };
  'membership.cancelled': { membershipId: string; memberId: string };
  'pack.purchased': { packId: string; memberId: string; credits: number };
  'pack.low': { packId: string; memberId: string; creditsRemaining: number };
  'fee.assessed': { feeId: string; memberId: string; amountCents: number; kind: string };
  'fee.waived': { feeId: string; memberId: string };
  'churn.alert': { memberId: string; risk: number };
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEvent<K extends DomainEventName> = { type: K; payload: DomainEventMap[K]; at: string };

export type EventHandler<K extends DomainEventName> = (payload: DomainEventMap[K], event: DomainEvent<K>) => void | Promise<void>;

export class EventBus {
  #handlers = new Map<DomainEventName, Set<EventHandler<DomainEventName>>>();

  on<K extends DomainEventName>(type: K, handler: EventHandler<K>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as EventHandler<DomainEventName>);
    return () => this.off(type, handler);
  }

  off<K extends DomainEventName>(type: K, handler: EventHandler<K>): void {
    this.#handlers.get(type)?.delete(handler as EventHandler<DomainEventName>);
  }

  once<K extends DomainEventName>(type: K, handler: EventHandler<K>): () => void {
    const wrapped: EventHandler<K> = async (payload, event) => {
      this.off(type, wrapped);
      await handler(payload, event);
    };
    return this.on(type, wrapped);
  }

  async emit<K extends DomainEventName>(type: K, payload: DomainEventMap[K]): Promise<void> {
    const set = this.#handlers.get(type);
    if (!set?.size) return;
    const event: DomainEvent<K> = { type, payload, at: new Date().toISOString() };
    await Promise.all([...set].map((handler) => handler(payload, event)));
  }

  listenerCount(type: DomainEventName): number {
    return this.#handlers.get(type)?.size ?? 0;
  }

  clear(): void {
    this.#handlers.clear();
  }
}

/** Which notification kinds each domain event fans out to. */
export const EVENT_NOTIFICATION_MAP: Partial<Record<DomainEventName, NotificationKind>> = {
  'booking.promoted': 'waitlist-promoted',
  'booking.waitlisted': 'waitlist-joined',
  'booking.created': 'booking-confirmed',
  'booking.cancelled': 'booking-cancelled',
  'class.cancelled': 'class-cancelled',
  'invoice.paid': 'payment-receipt',
  'payment.failed': 'payment-failed',
  'pack.purchased': 'pack-expiring',
  'membership.paused': 'membership-paused',
  'churn.alert': 'churn-alert',
};