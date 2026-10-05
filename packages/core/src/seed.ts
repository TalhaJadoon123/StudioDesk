import { DAY_MS, addDays, addMinutes, sortBy, type Booking, type Class, type Instructor, type Member } from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { createPlan } from './plans.js';
import { createInstructor } from './classes.js';
import { createMember } from './members.js';
import type { Studio } from './repository.js';

/* -------------------------------------------------------------------------- */
/* Deterministic RNG so every seed run produces the same demo studio.        */
/* -------------------------------------------------------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Ada', 'Mia', 'Sofia', 'Lena', 'Priya', 'Yuki', 'Nora', 'Amara', 'Zoe', 'Ines',
  'Hana', 'Elif', 'Ruth', 'Ivy', 'Noor', 'Tara', 'Esme', 'Lila', 'Maya', 'Freya',
  'Clara', 'Ana', 'Bex', 'Cosima', 'Dara', 'Eve', 'Faye', 'Greta', 'Hana', 'Isla',
  'Juno', 'Kaia', 'Liv', 'Mabel', 'Nika', 'Orla', 'Petra', 'Quinn', 'Rosa', 'Suki',
  'Talia', 'Uma', 'Vera', 'Wren', 'Xan', 'Yara', 'Zola', 'Aiko', 'Bex', 'Cleo',
  'Delphine', 'Esha', 'Frida', 'Gita', 'Hester', 'Indra', 'Juno', 'Kira', 'Liora', 'Maeve',
  'Nadira', 'Oona', 'Pia', 'Rhian', 'Saoirse', 'Thandi', 'Uma', 'Veda', 'Willa', 'Xiomara',
  'Yara', 'Zainab', 'Alba', 'Beatriz', 'Chiara', 'Dilara', 'Eira', 'Fionnuala', 'Gemma', 'Halima',
  'Iman', 'Jamila', 'Katarzyna', 'Leila', 'Mireia', 'Nour', 'Ophelia', 'Paloma', 'Rania', 'Selin',
  'Tova', 'Ursula', 'Valeria', 'Winnie', 'Xiulan', 'Yara', 'Zara',
];

const LAST_NAMES = [
  'Okafor', 'Lindqvist', 'Rossi', 'Haddad', 'Nakamura', 'Silva', 'Kowalski', 'Duarte',
  'Novak', 'Berg', 'Costa', 'Ferrari', 'Mensah', 'Petrova', 'Sharma', 'Larsen',
  'Moreau', 'Bianchi', 'Almeida', 'Vargas', 'Ivanova', 'Horvath', 'Nilsen', 'Dvorak',
  'Fontaine', 'Guerrero', 'Kaplan', 'Rahman', 'Sorensen', 'Tanaka', 'Ueda', 'Wagner',
  'Yilmaz', 'Zielinski', 'Andersen', 'Brennan', 'Castro', 'Delgado', 'Eriksen', 'Fischer',
  'Gruber', 'Hoffmann', 'Ibrahim', 'Jansen', 'Keller', 'Larsen', 'Meyer', 'Nyberg', 'Ortiz',
  'Pereira', 'Quintana', 'Reyes', 'Sandberg', 'Thomsen', 'Ungaretti', 'Vasquez', 'Weber',
  'Xu', 'Yamamoto', 'Zimmermann',
];

const CLASS_CATALOGUE = [
  { name: 'Vinyasa Flow', type: 'vinyasa', duration: 60, capacity: 18, creditCost: 1, level: 'all-levels' as const, days: [1, 3, 5], hour: 7, color: '#6366f1' },
  { name: 'Power Flow', type: 'power', duration: 60, capacity: 16, creditCost: 1, level: 'intermediate' as const, days: [2, 4], hour: 18, color: '#f43f5e' },
  { name: 'Restorative', type: 'restorative', duration: 75, capacity: 14, creditCost: 1, level: 'all-levels' as const, days: [2, 6], hour: 19, color: '#14b8a6' },
  { name: 'Yin Deep Release', type: 'yin', duration: 75, capacity: 14, creditCost: 1, level: 'beginner' as const, days: [0, 4], hour: 20, color: '#8b5cf6' },
  { name: 'Ashtanga Led Primary', type: 'ashtanga', duration: 90, capacity: 12, creditCost: 2, level: 'advanced' as const, days: [1, 4], hour: 6, color: '#f97316' },
  { name: 'Slow Flow + Breath', type: 'slow', duration: 60, capacity: 20, creditCost: 1, level: 'beginner' as const, days: [0, 3], hour: 10, color: '#22c55e' },
  { name: 'Prenatal Yoga', type: 'prenatal', duration: 60, capacity: 10, creditCost: 1, level: 'all-levels' as const, days: [3], hour: 11, color: '#ec4899' },
  { name: 'Sunrise Ashtanga', type: 'ashtanga', duration: 60, capacity: 12, creditCost: 2, level: 'intermediate' as const, days: [1, 3, 5], hour: 6, color: '#eab308' },
];

const INSTRUCTORS = [
  { name: 'Maya Krishnan', email: 'maya@riverbendyoga.test', specialties: ['vinyasa', 'power'], color: '#6366f1' },
  { name: 'Tom Ferreira', email: 'tom@riverbendyoga.test', specialties: ['yin', 'restorative'], color: '#14b8a6' },
  { name: 'Sara Lindqvist', email: 'sara@riverbendyoga.test', specialties: ['ashtanga'], color: '#f97316' },
  { name: 'Omar Haddad', email: 'omar@riverbendyoga.test', specialties: ['slow', 'prenatal'], color: '#22c55e' },
  { name: 'Jules Moreau', email: 'jules@riverbendyoga.test', specialties: ['vinyasa', 'yin'], color: '#8b5cf6' },
];

export interface SeedOptions {
  studioName?: string;
  members?: number;
  weeksBack?: number;
  weeksForward?: number;
  seed?: number;
  timezone?: string;
  tier?: Studio['tier'];
}

export interface SeedSummary {
  studio: Studio;
  instructors: number;
  plans: number;
  members: number;
  classes: number;
  bookings: number;
  attendance: number;
  invoices: number;
  packs: number;
  dropIns: number;
  fees: number;
  memberships: number;
}

/**
 * Seeds a believable yoga studio: 5 instructors, 8 class types, 100 members
 * with 8 weeks of booking history and 6 weeks scheduled ahead.
 *
 * Deterministic - same seed, same studio, every time. That is what makes it
 * safe to assert against in tests.
 */
export async function seedDemoStudio(ctx: CoreContext, options: SeedOptions = {}): Promise<SeedSummary> {
  const rand = mulberry32(options.seed ?? 20_260_115);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const memberCount = options.members ?? 100;
  const weeksBack = options.weeksBack ?? 8;
  const weeksForward = options.weeksForward ?? 6;
  const now = ctx.now();

  /* --- Studio --------------------------------------------------------- */
  const { getStudio, updateStudio } = await import('./studio.js');
  const studio = await getStudio(ctx);
  await updateStudio(ctx, studio.id, {
    name: options.studioName ?? 'Riverbend Yoga',
    tier: options.tier ?? 'business',
    timezone: options.timezone ?? 'Europe/London',
    checkinGeofence: { latitude: 51.5074, longitude: -0.1278, radiusMeters: 150 },
    branding: { accentColor: '#6366f1' },
  });

  /* --- Instructors ---------------------------------------------------- */
  const instructors: Instructor[] = [];
  for (const spec of INSTRUCTORS) {
    instructors.push(await createInstructor(ctx, spec));
  }
  const instructorFor = (types: string[]) =>
    instructors.find((i) => i.specialties?.some((s: string) => types.includes(s))) ?? instructors[0]!;

  /* --- Plans ---------------------------------------------------------- */
  const unlimited = await createPlan(ctx, {
    name: 'Unlimited Monthly',
    priceCents: 8900,
    currency: 'usd',
    classCredits: null,
    description: 'Unlimited classes, cancel anytime.',
  });
  const eightPack = await createPlan(ctx, {
    name: '8 Classes / month',
    priceCents: 6900,
    currency: 'usd',
    classCredits: 8,
    description: 'Eight credits, refreshes monthly.',
  });
  const tenPack = await createPlan(ctx, {
    name: '10 Class Pack',
    priceCents: 15_000,
    currency: 'usd',
    classCredits: 10,
    description: 'Ten credits, valid for 90 days.',
  });
  const unlimitedYearly = await createPlan(ctx, {
    name: 'Unlimited Yearly',
    priceCents: 84_000,
    currency: 'usd',
    interval: 'year',
    classCredits: null,
    description: 'Unlimited classes, billed once a year.',
  });
  const plans = [unlimited, eightPack, tenPack, unlimitedYearly];

  /* --- Members -------------------------------------------------------- */
  const usedNames = new Set<string>();
  const members: Member[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    let name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    let guard = 0;
    while (usedNames.has(name) && guard < 20) {
      name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      guard += 1;
    }
    usedNames.add(name);

    // Tenure: most members are long-standing, a few are brand new (they churn).
    const tenureDays = rand() < 0.12 ? between(1, 25) : between(30, 900);
    const joinedAt = addDays(now, -tenureDays).toISOString();

    // Engagement archetypes drive the rest of the fixture.
    const archetype = rand();
    const engagement =
      archetype < 0.12 ? 'lapsed' : archetype < 0.32 ? 'declining' : archetype < 0.85 ? 'regular' : 'devoted';
    const status: Member['status'] =
      rand() < 0.06 ? 'cancelled' : rand() < 0.05 ? 'paused' : 'active';

    const plan = pick(engagement === 'devoted' ? [unlimited, unlimitedYearly, unlimited] : plans);

    const member = await createMember(ctx, {
      name,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      phone: `+44 7${between(100, 999)} ${between(100000, 999999)}`,
      planId: plan.id,
      status,
      joinedAt,
      monthlyPriceCents: plan.priceCents,
      currency: 'usd',
      tags: [pick(['morning', 'evening', 'weekend', 'beginner', 'advanced', 'prenatal', 'founder'])],
      notes: engagement === 'devoted' ? 'Very consistent, refers friends.' : undefined,
    });
    members.push(member);
    // Stash the archetype for the booking generator.
    (member as Member & { _engagement?: string })._engagement = engagement;
  }

  /* --- Classes -------------------------------------------------------- */
  const classes: Class[] = [];
  const totalDays = weeksBack * 7 + weeksForward * 7 + 1;
  for (let dayOffset = -weeksBack * 7; dayOffset <= weeksForward * 7; dayOffset += 1) {
    const day = addDays(now, dayOffset);
    const dow = day.getUTCDay();
    for (const spec of CLASS_CATALOGUE) {
      if (!spec.days.includes(dow)) continue;
      const startTime = addMinutes(day, spec.hour * 60).toISOString();
      if (startTime < addDays(now, -weeksBack * 7).toISOString()) continue;

      const instructor = instructorFor(spec.type === 'yin' || spec.type === 'restorative'
        ? ['yin', 'restorative']
        : spec.type === 'ashtanga'
          ? ['ashtanga']
          : [spec.type]);

      // Room and capacity drift a little week to week.
      const capacityJitter = rand() < 0.25 ? between(-3, 3) : 0;
      const klass = {
        id: `cls_seed_${spec.type}_${spec.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${dayOffset}`,
        studioId: studio.id,
        name: spec.name,
        instructorId: instructor.id,
        startTime,
        endTime: addMinutes(startTime, spec.duration).toISOString(),
        capacity: Math.max(6, spec.capacity + capacityJitter),
        durationMinutes: spec.duration,
        room: spec.type === 'prenatal' ? 'Studio 2' : pick(['Main Studio', 'Main Studio', 'Studio 2', 'Loft']),
        color: spec.color,
        level: spec.level,
        status: 'scheduled' as const,
        creditCost: spec.creditCost,
        classType: spec.name,
        waitlistEnabled: true,
        lateCancelHours: 4,
        createdAt: addDays(now, -weeksBack * 7).toISOString(),
        updatedAt: addDays(now, -weeksBack * 7).toISOString(),
      };
      // Popular times run fuller - drive capacity for the booking pass.
      (klass as Class & { _popularity?: number })._popularity = spec.hour <= 8 ? 0.9 : spec.hour >= 19 ? 0.75 : 0.55;
      classes.push(await ctx.repo.table('classes').insert(klass));
    }
  }

  /* --- Bookings + attendance ------------------------------------------ */
  const bookings: Booking[] = [];
  const attendanceRows: Array<Record<string, unknown>> = [];
  const fees: Array<Record<string, unknown>> = [];
  const invoiceRows: Array<Record<string, unknown>> = [];
  const packRows: Array<Record<string, unknown>> = [];

  let invoiceCounter = 1000;

  for (const klass of classes) {
    const klassTime = Date.parse(klass.startTime);
    const isPast = klassTime < now.getTime();
    const hoursFromNow = (klassTime - now.getTime()) / 3_600_000;
    if (hoursFromNow < -24 * 30) continue;

    const popularity = (klass as Class & { _popularity?: number })._popularity ?? 0.6;
    const target = Math.round(klass.capacity * popularity * (0.75 + rand() * 0.35));

    // Who might attend: weight regulars higher, and drop the lapsed.
    const pool = members.filter((member) => {
      if (member.status === 'cancelled') return false;
      const engagement = (member as Member & { _engagement?: string })._engagement;
      if (engagement === 'lapsed') return isPast ? rand() < 0.2 : rand() < 0.08;
      if (engagement === 'declining') return isPast ? rand() < 0.65 : rand() < 0.4;
      if (engagement === 'devoted') return rand() < 0.55;
      return rand() < 0.3;
    });

    const chosen = pool.slice(0, Math.min(pool.length, target));
    const confirmed = chosen.slice(0, klass.capacity);
    const waitlisted = chosen.slice(klass.capacity);

    for (const [index, member] of confirmed.entries()) {
      const engagement = (member as Member & { _engagement?: string })._engagement ?? 'regular';
      const bookedAt = addDays(klass.startTime, -between(1, 12)).toISOString();

      let status: Booking['status'] = 'booked';
      if (isPast) {
        const showRate =
          engagement === 'devoted' ? 0.97 : engagement === 'regular' ? 0.91 : engagement === 'declining' ? 0.83 : 0.7;
        status = rand() < showRate ? 'attended' : 'no-show';
      }

      const booking: Booking = {
        id: `bkg_seed_${klass.id}_${member.id}`,
        memberId: member.id,
        classId: klass.id,
        status,
        bookedAt,
        creditsCharged: status === 'booked' ? (klass.creditCost ?? 1) : 0,
        source: rand() < 0.6 ? 'mobile' : 'web',
        createdAt: bookedAt,
        updatedAt: bookedAt,
      };
      bookings.push(booking);
      await ctx.repo.table('bookings').insert(booking);

      if (status === 'attended') {
        attendanceRows.push({
          id: `att_seed_${booking.id}`,
          memberId: member.id,
          classId: klass.id,
          bookingId: booking.id,
          method: pick(['qr', 'qr', 'geo', 'manual'] as const),
          checkedInAt: addMinutes(klass.startTime, between(-12, 8)).toISOString(),
          lateByMinutes: 0,
          deviceId: rand() < 0.5 ? 'dev_seed_tablet' : undefined,
        });
      }

      if (status === 'no-show' && rand() < 0.7) {
        fees.push({
          id: `fee_seed_${booking.id}`,
          studioId: studio.id,
          memberId: member.id,
          classId: klass.id,
          bookingId: booking.id,
          kind: 'no-show',
          amountCents: 500,
          currency: 'usd',
          status: rand() < 0.8 ? 'charged' : 'waived',
          assessedAt: klass.startTime,
          chargedAt: klass.startTime,
          waiverReason: rand() < 0.8 ? 'medical' : undefined,
        });
      }

      // Late cancellations on future classes.
      if (!isPast && hoursFromNow < 72 && rand() < 0.08) {
        const lateAt = addMinutes(klass.startTime, -60).toISOString();
        await ctx.repo.table('bookings').update(booking.id, {
          status: 'cancelled',
          cancelledAt: lateAt,
          updatedAt: lateAt,
        });
        fees.push({
          id: `fee_seed_late_${booking.id}`,
          studioId: studio.id,
          memberId: member.id,
          classId: klass.id,
          bookingId: booking.id,
          kind: 'late-cancel',
          amountCents: 300,
          currency: 'usd',
          status: 'assessed',
          assessedAt: lateAt,
        });
      }

      // Monthly membership invoices for the last few months.
      if (index === 0 && !isPast && member.status === 'active' && rand() < 0.6) {
        const billedAt = addDays(now, -between(0, 25)).toISOString();
        const plan = plans.find((p) => p.id === member.planId);
        const total = plan?.priceCents ?? 0;
        if (total > 0) {
          const paid = rand() < 0.88;
          invoiceCounter += 1;
          invoiceRows.push({
            id: `inv_seed_${member.id}_${invoiceCounter}`,
            studioId: studio.id,
            memberId: member.id,
            number: `INV-${invoiceCounter}`,
            status: paid ? 'paid' : 'open',
            currency: 'usd',
            subtotalCents: total,
            taxCents: 0,
            discountCents: 0,
            totalCents: total,
            amountPaidCents: paid ? total : 0,
            amountDueCents: paid ? 0 : total,
            lineItems: [
              {
                id: `li_seed_${invoiceCounter}`,
                description: plan!.name,
                quantity: 1,
                unitAmountCents: total,
                amountCents: total,
                kind: 'membership',
              },
            ],
            dueAt: billedAt,
            paidAt: paid ? billedAt : undefined,
            createdAt: billedAt,
            updatedAt: billedAt,
          });
        }
      }
    }

    // Waitlist entries for the oversubscribed classes.
    let position = 1;
    for (const member of waitlisted) {
      const joinedAt = addDays(klass.startTime, -between(1, 6)).toISOString();
      bookings.push(
        await ctx.repo.table('bookings').insert({
          id: `bkg_seed_wl_${klass.id}_${member.id}`,
          memberId: member.id,
          classId: klass.id,
          status: 'waitlisted',
          waitlistPosition: position,
          waitlistJoinedAt: joinedAt,
          bookedAt: joinedAt,
          creditsCharged: 0,
          source: 'mobile',
          createdAt: joinedAt,
          updatedAt: joinedAt,
        }),
      );
      position += 1;
    }
  }

  /* --- Bulk insert the rest ------------------------------------------- */
  await ctx.repo.table('attendance').insertMany(attendanceRows as never);
  await ctx.repo.table('fees').insertMany(fees as never);
  await ctx.repo.table('invoices').insertMany(invoiceRows as never);

  /* --- Class packs ---------------------------------------------------- */
  const packCatalogue = [
    { name: '5 Class Pack', credits: 5, priceCents: 9_000 },
    { name: '10 Class Pack', credits: 10, priceCents: 15_000 },
    { name: '20 Class Pack', credits: 20, priceCents: 27_000 },
  ];
  let packCount = 0;
  for (const member of members) {
    if (member.status === 'cancelled') continue;
    if (rand() > 0.45) continue;
    const spec = pick(packCatalogue);
    const purchasedAt = addDays(now, -between(1, 70));
    const remaining = rand() < 0.4 ? 0 : between(1, spec.credits);
    packRows.push({
      id: `pak_seed_${member.id}`,
      studioId: studio.id,
      memberId: member.id,
      name: spec.name,
      credits: spec.credits,
      creditsRemaining: remaining,
      priceCents: spec.priceCents,
      currency: 'usd',
      purchasedAt: purchasedAt.toISOString(),
      expiresAt: addDays(purchasedAt, 90).toISOString(),
      status: remaining > 0 ? 'active' : 'depleted',
      createdAt: purchasedAt.toISOString(),
      updatedAt: purchasedAt.toISOString(),
    });
    packCount += 1;
  }
  await ctx.repo.table('packs').insertMany(packRows as never);

  /* --- Memberships (recurring billing records) ------------------------ */
  const membershipRows = [];
  for (const member of members.filter((m) => m.status !== 'cancelled')) {
    const plan = plans.find((p) => p.id === member.planId);
    if (!plan) continue;
    const startedAt = member.joinedAt ?? addDays(now, -60).toISOString();
    const periodStart = addDays(now, -between(2, 28));
    const periodEnd = addDays(periodStart, plan.interval === 'year' ? 365 : 30);
    const failed = rand() < 0.06;
    membershipRows.push({
      id: `mbs_seed_${member.id}`,
      studioId: studio.id,
      memberId: member.id,
      planId: plan.id,
      status: failed ? 'past_due' : member.status === 'paused' ? 'paused' : 'active',
      gateway: 'polar',
      startedAt,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
      dunningStage: failed ? 1 : 0,
      lastPaymentAt: addDays(periodStart, 1).toISOString(),
      createdAt: startedAt,
      updatedAt: periodStart.toISOString(),
    });
  }
  await ctx.repo.table('memberships').insertMany(membershipRows as never);

  /* --- Drop-ins -------------------------------------------------------- */
  const dropInRows = [];
  for (let i = 0; i < 18; i += 1) {
    const member = pick(members);
    const klass = pick(classes.filter((c) => Date.parse(c.startTime) > now.getTime()));
    const purchasedAt = addDays(now, -between(0, 20)).toISOString();
    dropInRows.push({
      id: `dip_seed_${i}`,
      studioId: studio.id,
      memberId: member.id,
      classId: klass.id,
      priceCents: 2200,
      currency: 'usd',
      purchasedAt,
      paymentId: `pi_seed_${i}`,
      status: 'active',
      createdAt: purchasedAt,
      updatedAt: purchasedAt,
    });
  }
  await ctx.repo.table('dropIns').insertMany(dropInRows as never);

  return {
    studio,
    instructors: instructors.length,
    plans: plans.length,
    members: members.length,
    classes: classes.length,
    bookings: bookings.length,
    attendance: attendanceRows.length,
    invoices: invoiceRows.length,
    packs: packCount,
    dropIns: dropInRows.length,
    fees: fees.length,
    memberships: membershipRows.length,
  };
}

export { sortBy, DAY_MS };