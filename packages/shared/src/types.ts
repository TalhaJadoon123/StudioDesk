/**
 * StudioDesk domain types.
 *
 * These are the canonical shapes used by every package (core, booking, billing,
 * checkin, api, web, mobile). Money is ALWAYS integer cents. Timestamps are
 * ALWAYS ISO-8601 UTC strings unless the field name says otherwise.
 */

/* -------------------------------------------------------------------------- */
/* Studio & tenancy                                                           */
/* -------------------------------------------------------------------------- */

export type PlanTier = 'free' | 'starter' | 'business';
export type BillingInterval = 'month' | 'year';
export type Currency = 'usd' | 'eur' | 'gbp' | 'pkr';

/* -------------------------------------------------------------------------- */
/* Members                                                                    */
/* -------------------------------------------------------------------------- */

export type MemberStatus = 'active' | 'paused' | 'cancelled';

/**
 * A studio member. The four fields in the brief (`id`, `name`, `planId`,
 * `status`) are the required contract; everything else is optional detail used
 * by billing, check-in and churn scoring.
 */
export interface Member {
  id: string;
  name: string;
  planId: string;
  status: MemberStatus;
  email?: string;
  phone?: string;
  studioId?: string;
  /** Minor units, e.g. `3900` = $39.00. */
  monthlyPriceCents?: number;
  currency?: Currency;
  joinedAt?: string;
  /** ISO date (YYYY-MM-DD) - memberships pause until this day. */
  pausedUntil?: string;
  cancelledAt?: string;
  notes?: string;
  tags?: string[];
  /** Remembers the user's intent across plan changes. */
  homeStudioId?: string;
  marketingOptIn?: boolean;
  /** Auto-generated passcode for the kiosk (last 4 digits style). */
  kioskPin?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemberWithUsage extends Member {
  visitsLast30Days: number;
  visitsPrev30Days: number;
  daysSinceLastVisit: number | null;
  attendanceRate: number;
  lateCancels: number;
  noShows: number;
  outstandingCents: number;
  tenureDays: number;
  churnRisk: number;
  churnBand: ChurnBand;
}

export type ChurnBand = 'low' | 'medium' | 'high' | 'at-risk';

/* -------------------------------------------------------------------------- */
/* Plans                                                                      */
/* -------------------------------------------------------------------------- */

export interface Plan {
  id: string;
  studioId: string;
  name: string;
  tier: PlanTier;
  priceCents: number;
  currency: Currency;
  interval: BillingInterval;
  /** Credits granted per interval; `null` = unlimited. */
  classCredits: number | null;
  description?: string;
  /** Stripe/Polar product id for the recurring charge. */
  gatewayProductId?: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanLimits {
  maxMembers: number | null;
  /** `null` = unlimited class types (a Studio plan limit, not a member plan). */
  maxClassTypes: number | null;
  maxInstructors: number | null;
  waitlist: boolean;
  qrCheckin: boolean;
  kioskMode: boolean;
  churnAi: boolean;
  dunning: boolean;
  customBranding: boolean;
  apiAccess: boolean;
  reportRetentionDays: number;
  seats: number;
}

export interface CatalogPlan {
  tier: PlanTier;
  name: string;
  priceCents: number;
  yearlyPriceCents: number;
  currency: Currency;
  tagline: string;
  features: string[];
  limits: PlanLimits;
  highlighted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Classes & instructors                                                      */
/* -------------------------------------------------------------------------- */

export interface Instructor {
  id: string;
  studioId: string;
  name: string;
  email?: string;
  phone?: string;
  /** Denormalised for quick roster lookups. */
  bio?: string;
  specialties?: string[];
  color?: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type ClassStatus = 'scheduled' | 'cancelled' | 'completed';

export interface Class {
  id: string;
  studioId?: string;
  name: string;
  instructorId: string;
  /** ISO-8601 UTC. */
  startTime: string;
  /** ISO-8601 UTC. */
  endTime?: string;
  capacity: number;
  durationMinutes?: number;
  room?: string;
  color?: string;
  level?: 'beginner' | 'intermediate' | 'advanced' | 'all-levels';
  status?: ClassStatus;
  description?: string;
  /** Present when the class belongs to a recurring series. */
  seriesId?: string;
  rrule?: string;
  /** Credits charged per booking (1 = one credit). */
  creditCost?: number;
  /** Studio-specific type key used by the free-tier "1 class type" limit. */
  classType?: string;
  waitlistEnabled?: boolean;
  /** Hours before start after which a cancellation counts as "late". */
  lateCancelHours?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClassOccurrence extends Class {
  occurrenceId: string;
  seriesId?: string;
  overridden?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Bookings                                                                   */
/* -------------------------------------------------------------------------- */

export type BookingStatus =
  | 'booked'
  | 'waitlisted'
  | 'attended'
  | 'no-show'
  | 'cancelled';

export interface Booking {
  id: string;
  memberId: string;
  classId: string;
  status: BookingStatus;
  /** Position on the waitlist, 1-based. */
  waitlistPosition?: number;
  bookedAt?: string;
  cancelledAt?: string;
  promotedAt?: string;
  creditsCharged?: number;
  waitlistJoinedAt?: string;
  source?: 'web' | 'mobile' | 'kiosk' | 'staff' | 'api';
  note?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookingWithContext extends Booking {
  className?: string;
  instructorId?: string;
  startTime?: string;
  memberName?: string;
}

export interface BookingResult {
  booking: Booking;
  promoted?: Booking[];
  waitlistPosition?: number;
  chargedCredits: number;
}

/* -------------------------------------------------------------------------- */
/* Attendance                                                                 */
/* -------------------------------------------------------------------------- */

export type CheckinMethod = 'qr' | 'geo' | 'manual' | 'kiosk';

export interface Attendance {
  id: string;
  memberId: string;
  classId: string;
  bookingId?: string;
  method: CheckinMethod;
  checkedInAt: string;
  lateByMinutes?: number;
  latitude?: number;
  longitude?: number;
  distanceMeters?: number;
  deviceId?: string;
  staffId?: string;
  createdAt?: string;
}

export interface AttendanceSummary {
  classId: string;
  className?: string;
  startTime: string;
  capacity: number;
  booked: number;
  attended: number;
  noShows: number;
  cancelled: number;
  waitlisted: number;
  fillRate: number;
  attendanceRate: number;
  revenueCents: number;
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

export interface Invoice {
  id: string;
  studioId?: string;
  memberId?: string;
  number: string;
  status: InvoiceStatus;
  currency: Currency;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  lineItems: InvoiceLineItem[];
  dueAt?: string;
  paidAt?: string;
  pdfUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
  kind:
    | 'membership'
    | 'class-pack'
    | 'drop-in'
    | 'late-cancel-fee'
    | 'no-show-fee'
    | 'proration'
    | 'discount'
    | 'tax';
  metadata?: Record<string, string | number>;
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'cancelled'
  | 'unpaid';

export interface Membership {
  id: string;
  studioId?: string;
  memberId: string;
  planId: string;
  status: SubscriptionStatus;
  gateway: GatewayName;
  gatewayCustomerId?: string;
  gatewaySubscriptionId?: string;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelledAt?: string;
  cancelAtPeriodEnd?: boolean;
  pausedUntil?: string;
  /** Cycle index used by the dunning state machine. */
  dunningStage?: number;
  nextDunningAttemptAt?: string;
  lastPaymentAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClassPack {
  id: string;
  studioId?: string;
  memberId: string;
  name: string;
  credits: number;
  creditsRemaining: number;
  priceCents: number;
  currency: Currency;
  purchasedAt: string;
  expiresAt?: string;
  status: 'active' | 'expired' | 'depleted';
  createdAt?: string;
  updatedAt?: string;
}

export interface DropIn {
  id: string;
  studioId?: string;
  memberId: string;
  classId: string;
  priceCents: number;
  currency: Currency;
  purchasedAt: string;
  paymentId?: string;
  status: 'active' | 'refunded' | 'used';
  createdAt?: string;
}

export type FeeKind = 'late-cancel' | 'no-show' | 'admin-cancel';
export type FeeWaiverReason = 'studio-error' | 'instructor-cancel' | 'medical' | 'manager-override';

export interface Fee {
  id: string;
  studioId?: string;
  memberId: string;
  classId?: string;
  bookingId?: string;
  kind: FeeKind;
  amountCents: number;
  currency: Currency;
  status: 'assessed' | 'waived' | 'charged' | 'void';
  assessedAt: string;
  chargedAt?: string;
  waivedAt?: string;
  waiverReason?: FeeWaiverReason;
  note?: string;
  createdAt?: string;
}

export interface Charge {
  id: string;
  studioId?: string;
  memberId?: string;
  invoiceId?: string;
  amountCents: number;
  currency: Currency;
  status: PaymentStatus;
  gateway: GatewayName;
  gatewayPaymentId?: string;
  failureCode?: string;
  failureMessage?: string;
  attempt: number;
  idempotencyKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type GatewayName = 'stripe' | 'polar' | 'lemonsqueezy' | 'manual';

/* -------------------------------------------------------------------------- */
/* Dunning                                                                    */
/* -------------------------------------------------------------------------- */

export type DunningAction =
  | 'none'
  | 'email_receipt'
  | 'retry_payment'
  | 'pause_membership'
  | 'cancel_membership'
  | 'notify_studio';

export interface DunningPolicy {
  /** Days after the charge date before each action fires. */
  retryAfterDays: number[];
  emailReceipt: boolean;
  pauseAfterDays: number;
  cancelAfterDays: number;
  feeCents: number;
}

export interface DunningStep {
  stage: number;
  dueAt: string;
  action: DunningAction;
}

export interface DunningEvent {
  id: string;
  membershipId: string;
  memberId: string;
  stage: number;
  action: DunningAction;
  attemptedAt: string;
  succeeded: boolean;
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/* Check-in                                                                   */
/* -------------------------------------------------------------------------- */

export interface CheckinTicket {
  /** Compact payload encoded into the member's QR code. */
  code: string;
  memberId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface CheckinResult {
  ok: boolean;
  status: 'checked-in' | 'duplicate' | 'invalid' | 'late' | 'outside-geofence' | 'not-booked' | 'class-full';
  memberId?: string;
  memberName?: string;
  classId?: string;
  attendance?: Attendance;
  message: string;
  distanceMeters?: number;
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export type NotificationKind =
  | 'waitlist-promoted'
  | 'waitlist-joined'
  | 'booking-confirmed'
  | 'booking-cancelled'
  | 'class-cancelled'
  | 'payment-receipt'
  | 'payment-failed'
  | 'pack-expiring'
  | 'membership-paused'
  | 'churn-alert'
  | 'digest';

export interface Notification {
  id: string;
  memberId?: string;
  studioId?: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data?: Record<string, string | number>;
  readAt?: string;
  sentAt?: string;
  channel: 'push' | 'email' | 'sms' | 'in-app';
  createdAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReportRange {
  from: string;
  to: string;
}

export interface RevenuePoint {
  date: string;
  grossCents: number;
  feesCents: number;
  packsCents: number;
  dropInsCents: number;
  membershipsCents: number;
  refundsCents: number;
  netCents: number;
  transactions: number;
}

export interface RevenueReport extends ReportRange {
  grossCents: number;
  netCents: number;
  membershipsCents: number;
  packsCents: number;
  dropInsCents: number;
  feesCents: number;
  refundsCents: number;
  transactions: number;
  averageTransactionCents: number;
  byDay: RevenuePoint[];
  byClass: Array<{ classId: string; name: string; revenueCents: number; bookings: number }>;
}

export interface AttendanceReport extends ReportRange {
  totalBookings: number;
  attended: number;
  noShows: number;
  cancelled: number;
  waitlisted: number;
  attendanceRate: number;
  fillRate: number;
  uniqueMembers: number;
  byClass: AttendanceSummary[];
  byInstructor: Array<{ instructorId: string; name: string; classes: number; attended: number; attendanceRate: number }>;
}

export interface ChurnReport extends ReportRange {
  totalMembers: number;
  activeMembers: number;
  churnedLast30Days: number;
  churnRate: number;
  retainedCents: number;
  atRisk: MemberWithUsage[];
  byPlan: Array<{ planId: string; name: string; members: number; atRisk: number; mrrCents: number }>;
  insights: string[];
}

export interface DashboardSnapshot {
  studio: { id: string; name: string; tier: PlanTier; timezone: string };
  todayClasses: Array<Class & { booked: number; attended: number; waitlisted: number }>;
  todayBookings: number;
  todayCheckedIn: number;
  revenueTodayCents: number;
  revenueMonthCents: number;
  newMembersThisMonth: number;
  newMembersLastMonth: number;
  activeMembers: number;
  pausedMembers: number;
  cancelledMembers: number;
  atRiskCount: number;
  mrrCents: number;
  fillRate: number;
  topClasses: Array<{ name: string; bookings: number; fillRate: number }>;
  recentActivity: Array<{ at: string; message: string; kind: string }>;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface IdResult {
  id: string;
}

export interface Ok {
  ok: boolean;
}