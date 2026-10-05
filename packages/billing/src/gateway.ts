import { AppError, config, gatewayError, newChargeId, type Currency, type GatewayName } from '@studiodesk/shared';

/**
 * Payment gateway abstraction.
 *
 * Every adapter talks plain HTTPS + `fetch` rather than an SDK, which keeps the
 * package dependency-free and lets the same code run on Node, Cloudflare
 * Workers and the edge. Swap in a mock in tests with `createMockGateway()`.
 */

export type PaymentStatus = 'requires_action' | 'succeeded' | 'failed';

export interface CreateCustomerInput {
  memberId: string;
  email?: string;
  name: string;
  metadata?: Record<string, string>;
}

export interface Customer {
  id: string;
  email?: string;
  name: string;
}

export interface CreatePaymentInput {
  amountCents: number;
  currency: Currency;
  customerId?: string;
  description: string;
  memberId?: string;
  /** Stops double-charging on retries. Must be unique per logical charge. */
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  /** Where the customer lands after a 3DS redirect. */
  successUrl?: string;
  cancelUrl?: string;
  paymentMethodId?: string;
  /** Charge immediately instead of creating a pending intent. */
  confirm?: boolean;
}

export interface PaymentResult {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  currency: Currency;
  clientSecret?: string;
  failureCode?: string;
  failureMessage?: string;
  raw?: unknown;
}

export interface CreateSubscriptionInput {
  customerId: string;
  memberId: string;
  /** Gateway product id (Polar product id, Stripe price id, LS variant id). */
  productId: string;
  amountCents: number;
  currency: Currency;
  interval: 'month' | 'year';
  trialDays?: number;
  metadata?: Record<string, string>;
  successUrl?: string;
}

export interface SubscriptionResult {
  id: string;
  customerId: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'unpaid';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd?: boolean;
  checkoutUrl?: string;
  raw?: unknown;
}

export interface RefundResult {
  id: string;
  amountCents: number;
  status: 'succeeded' | 'pending' | 'failed';
}

export interface WebhookEvent {
  type: string;
  id: string;
  data: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  createCustomer(input: CreateCustomerInput): Promise<Customer>;
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
  refund(paymentId: string, amountCents?: number): Promise<RefundResult>;
  createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult>;
  cancelSubscription(subscriptionId: string, immediate?: boolean): Promise<SubscriptionResult>;
  /** Stripe/LS card updates, when the gateway supports it. */
  createCheckoutSession?(input: {
    productId: string;
    customerId?: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ url: string; id: string }>;
  verifyWebhook?(rawBody: string, signature: string): Promise<WebhookEvent>;
}

export interface SubscriberHandle {
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Shared HTTP helper                                                         */
/* -------------------------------------------------------------------------- */

interface HttpOptions {
  method?: string;
  form?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  timeoutMs?: number;
}

async function request<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(
      Object.entries(options.form)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ).toString();
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  try {
    const response = await fetch(url, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const detail =
        (parsed as { error?: { message?: string }; message?: string })?.error?.message ??
        (parsed as { message?: string })?.message ??
        `HTTP ${response.status}`;
      throw gatewayError(`${new URL(url).host}: ${detail}`, { status: response.status, body: parsed });
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw gatewayError(
      `${new URL(url).host} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** HMAC-SHA256 signature check used by Stripe, Polar and Lemon Squeezy webhooks. */
export async function verifyHmac(
  payload: string,
  signature: string,
  secret: string,
  toleranceSeconds = 300,
  headerName = 'timestamp',
): Promise<boolean> {
  const parts = signature.split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith(`${headerName}=`))?.split('=')[1];
  const provided = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!provided) return false;

  if (headerName === 'timestamp' && toleranceSeconds > 0 && timestamp) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = headerName === 'timestamp' && timestamp ? `${timestamp}.${payload}` : payload;
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  const expected = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Length-safe comparison - timing attacks are not a concern on public webhooks
  // but a cheap habit that avoids lint noise.
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Manual / offline gateway - the default with no keys configured             */
/* -------------------------------------------------------------------------- */

export function createManualGateway(): PaymentGateway {
  return {
    name: 'manual',
    async createCustomer(input) {
      return { id: `cus_manual_${input.memberId}`, email: input.email, name: input.name };
    },
    async createPayment(input): Promise<PaymentResult> {
      // Offline mode: cash, bank transfer, or a studio recording it by hand.
      return {
        id: newChargeId(),
        status: 'succeeded',
        amountCents: input.amountCents,
        currency: input.currency,
      };
    },
    async refund(_paymentId, amountCents = 0): Promise<RefundResult> {
      return { id: `re_manual_${Date.now()}`, amountCents, status: 'succeeded' };
    },
    async createSubscription(input): Promise<SubscriptionResult> {
      const start = new Date();
      const end = new Date(start);
      if (input.interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
      else end.setUTCMonth(end.getUTCMonth() + 1);
      return {
        id: `sub_manual_${input.memberId}`,
        customerId: input.customerId,
        status: 'active',
        currentPeriodStart: start.toISOString(),
        currentPeriodEnd: end.toISOString(),
      };
    },
    async cancelSubscription(): Promise<SubscriptionResult> {
      return {
        id: 'sub_manual',
        customerId: 'cus_manual',
        status: 'cancelled',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date().toISOString(),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mock gateway - used by the test suite                                      */
/* -------------------------------------------------------------------------- */

export interface MockGatewayState {
  customers: Customer[];
  payments: Array<PaymentResult & { description: string; memberId?: string; idempotencyKey?: string }>;
  refunds: Array<RefundResult & { paymentId: string }>;
  subscriptions: Array<SubscriptionResult & { memberId: string; productId: string }>;
  calls: Array<{ method: string; args: unknown }>;
}

/**
 * A `MockGateway` can stand in for any concrete adapter in tests. The `name`
 * is the only thing that differs structurally, so the mock carries a
 * discriminated union of the adapter return types.
 */
export type MockGateway =
  | (BaseMockGateway & { name: 'stripe' })
  | (BaseMockGateway & { name: 'polar' })
  | (BaseMockGateway & { name: 'lemonsqueezy' })
  | (BaseMockGateway & { name: 'manual' });

export interface BaseMockGateway extends PaymentGateway {
  readonly state: MockGatewayState;
  /** Force the next N payments to fail with this code. */
  failNext(code: string, message?: string): void;
  /** Make every subsequent payment fail - models a dead card. */
  failAlways(code: string, message?: string): void;
  /** Stop failing. */
  clearFailures(): void;
  reset(): void;
}

/**
 * Deterministic in-memory gateway. Records every call so tests can assert on
 * amounts, idempotency keys and retry behaviour without network access.
 */
export function createMockGateway(
  options: { name?: GatewayName; autoSucceed?: boolean } = {},
): MockGateway {
  const name = options.name ?? 'stripe';
  const state: MockGatewayState = {
    customers: [],
    payments: [],
    refunds: [],
    subscriptions: [],
    calls: [],
  };
  let failures = 0;
  let failureCode = 'card_declined';
  let failureMessage = 'Your card was declined.';
  let failuresForever = false;

  const record = (method: string, args: unknown) => state.calls.push({ method, args });

  return {
    name,
    state,
    failNext(code, message) {
      failures = 1;
      failureCode = code;
      failureMessage = message ?? `Simulated ${code}`;
    },
    failAlways(code, message) {
      failuresForever = true;
      failureCode = code;
      failureMessage = message ?? `Simulated ${code}`;
    },
    clearFailures() {
      failures = 0;
      failuresForever = false;
    },
    reset() {
      state.customers.length = 0;
      state.payments.length = 0;
      state.refunds.length = 0;
      state.subscriptions.length = 0;
      state.calls.length = 0;
      failures = 0;
      failuresForever = false;
    },
    async createCustomer(input) {
      record('createCustomer', input);
      const existing = state.customers.find((c) => c.id === `cus_${input.memberId}`);
      if (existing) return existing;
      const customer: Customer = { id: `cus_${input.memberId}`, email: input.email, name: input.name };
      state.customers.push(customer);
      return customer;
    },
    async createPayment(input) {
      record('createPayment', input);
      // Idempotency: replay the original result instead of double charging.
      const replay = state.payments.find((p) => p.idempotencyKey && p.idempotencyKey === input.idempotencyKey);
      if (replay) return replay;

      if (failuresForever || failures > 0) {
        if (failures > 0) failures -= 1;
        const failed: PaymentResult = {
          id: newChargeId(),
          status: 'failed',
          amountCents: input.amountCents,
          currency: input.currency,
          failureCode,
          failureMessage,
        };
        state.payments.push({ ...failed, description: input.description, memberId: input.memberId, idempotencyKey: input.idempotencyKey });
        return failed;
      }

      const payment: PaymentResult = {
        id: `pi_${state.payments.length + 1}_${input.memberId ?? 'anon'}`,
        status: options.autoSucceed === false ? 'requires_action' : 'succeeded',
        amountCents: input.amountCents,
        currency: input.currency,
        clientSecret: `secret_${input.memberId ?? 'anon'}`,
      };
      state.payments.push({
        ...payment,
        description: input.description,
        memberId: input.memberId,
        idempotencyKey: input.idempotencyKey,
      });
      return payment;
    },
    async refund(paymentId, amountCents = 0) {
      record('refund', { paymentId, amountCents });
      const refund: RefundResult & { paymentId: string } = {
        id: `re_${state.refunds.length + 1}`,
        amountCents,
        status: 'succeeded',
        paymentId,
      };
      state.refunds.push(refund);
      return refund;
    },
    async createSubscription(input) {
      record('createSubscription', input);
      const start = new Date();
      const end = new Date(start);
      if (input.interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
      else end.setUTCMonth(end.getUTCMonth() + 1);
      const subscription: SubscriptionResult & { memberId: string; productId: string } = {
        id: `sub_${input.memberId}`,
        customerId: input.customerId,
        status: input.trialDays ? 'trialing' : 'active',
        currentPeriodStart: start.toISOString(),
        currentPeriodEnd: end.toISOString(),
        cancelAtPeriodEnd: false,
        memberId: input.memberId,
        productId: input.productId,
      };
      state.subscriptions.push(subscription);
      return subscription;
    },
    async cancelSubscription(subscriptionId) {
      record('cancelSubscription', { subscriptionId });
      const found = state.subscriptions.find((s) => s.id === subscriptionId);
      if (found) {
        found.status = 'cancelled';
        return found;
      }
      return {
        id: subscriptionId,
        customerId: 'cus_unknown',
        status: 'cancelled',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date().toISOString(),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface GatewayOptions {
  /** Real Stripe adapter, or a mock standing in for one. */
  stripe?: PaymentGateway;
  /** Real Polar adapter, or a mock standing in for one. */
  polar?: PaymentGateway;
  lemonSqueezy?: PaymentGateway;
  mock?: MockGateway;
  recurring?: PaymentGateway;
  defaultGateway?: GatewayName;
}

/**
 * Builds the gateway stack from the environment. With no keys you get the
 * manual (offline) gateway, which records everything in-app - perfect for
 * demos and the whole test suite.
 */
export function createGateways(options: GatewayOptions = {}): {
  recurring: PaymentGateway;
  oneOff: PaymentGateway;
  byName: Record<GatewayName, PaymentGateway>;
  active: GatewayName;
  hasPayments: boolean;
} {
  const stripe = options.stripe ?? (config.stripeSecretKey() ? createStripeGateway() : undefined);
  const polar = options.polar ?? (config.polarToken() ? createPolarGateway() : undefined);
  const lemon = options.lemonSqueezy ??
    (config.lemonSqueezyKey() && config.lemonSqueezyStoreId()
      ? createLemonSqueezyGateway()
      : undefined);
  const manual = createManualGateway();

  const recurringChoice = options.recurring ?? polar ?? lemon ?? stripe ?? manual;
  const active = recurringChoice.name;

  return {
    recurring: recurringChoice,
    oneOff: stripe ?? polar ?? lemon ?? manual,
    byName: {
      stripe: stripe ?? manual,
      polar: polar ?? manual,
      lemonsqueezy: lemon ?? manual,
      manual,
    },
    active,
    hasPayments: Boolean(stripe || polar || lemon),
  };
}

export { request as gatewayRequest };

/**
 * Guards against real money moving in a misconfigured environment.
 *
 * `createGateways()` only ever builds a live adapter from a secret that is
 * present in `process.env`; there is no way to inject one accidentally. Tests
 * use `createMockGateway()` instead. This assertion documents the invariant and
 * fails loudly if someone reaches for the live adapters in a test.
 */
export function assertNotLiveGateway(gateway: PaymentGateway): PaymentGateway {
  const secret =
    gateway.name === 'stripe'
      ? process.env.STRIPE_SECRET_KEY
      : gateway.name === 'polar'
        ? process.env.POLAR_ACCESS_TOKEN
        : gateway.name === 'lemonsqueezy'
          ? process.env.LEMONSQUEEZY_API_KEY
          : undefined;

  if (secret && process.env.NODE_ENV === 'test') {
    throw new Error(
      `Live ${gateway.name} gateway constructed while NODE_ENV=test. Use createMockGateway().`,
    );
  }
  return gateway;
}

/* -------------------------------------------------------------------------- */
/* Stripe - per-transaction only (2.9% + 30c), no monthly fee                 */
/* -------------------------------------------------------------------------- */

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
  apiBase?: string;
  platformFeeCents?: number;
  currency?: Currency;
}

export function createStripeGateway(cfg: StripeConfig = { secretKey: config.stripeSecretKey() ?? '' }): StripeGateway {
  const base = cfg.apiBase ?? 'https://api.stripe.com/v1';
  const auth = { Authorization: `Bearer ${cfg.secretKey}` };
  const currency = cfg.currency ?? 'usd';

  const money = (cents: number) => Math.round(cents);

  return {
    name: 'stripe',
    async createCustomer(input) {
      const payload: Record<string, string> = { name: input.name };
      if (input.email) payload.email = input.email;
      for (const [key, value] of Object.entries(input.metadata ?? {})) payload[`metadata[${key}]`] = value;
      const result = await request<{ id: string; email?: string; name: string }>(
        `${base}/customers`,
        { form: payload, headers: auth },
      );
      return { id: result.id, email: result.email, name: result.name };
    },
    async createPayment(input) {
      const form: Record<string, string | number | boolean | undefined> = {
        amount: money(input.amountCents),
        currency: input.currency ?? currency,
        description: input.description,
        confirm: input.confirm === false ? 'false' : 'true',
      };
      if (input.customerId) form.customer = input.customerId;
      if (input.paymentMethodId) form.payment_method = input.paymentMethodId;
      if (input.successUrl) form.return_url = input.successUrl;
      for (const [key, value] of Object.entries(input.metadata ?? {})) form[`metadata[${key}]`] = value;

      const result = await request<{
        id: string;
        status: string;
        amount: number;
        currency: string;
        client_secret?: string;
        last_payment_error?: { code?: string; message?: string };
      }>(`${base}/payment_intents`, {
        form,
        headers: auth,
        idempotencyKey: input.idempotencyKey,
      });

      const status: PaymentStatus =
        result.status === 'succeeded' ? 'succeeded' : result.status === 'requires_action' ? 'requires_action' : 'failed';

      return {
        id: result.id,
        status,
        amountCents: result.amount,
        currency: (result.currency as Currency) ?? input.currency,
        clientSecret: result.client_secret,
        failureCode: result.last_payment_error?.code,
        failureMessage: result.last_payment_error?.message,
        raw: result,
      };
    },
    async refund(paymentId, amountCents) {
      const result = await request<{ id: string; amount: number; status: string }>(
        `${base}/refunds`,
        {
          form: { payment_intent: paymentId, ...(amountCents ? { amount: money(amountCents) } : {}) },
          headers: auth,
        },
      );
      return { id: result.id, amountCents: result.amount, status: 'succeeded' };
    },
    async createSubscription() {
      // StudioDesk deliberately does not use Stripe Billing: subscriptions run
      // through Polar / Lemon Squeezy, Stripe is for one-off transactions only.
      throw gatewayError('Stripe is configured for one-off payments only. Use Polar for recurring plans.');
    },
    async cancelSubscription() {
      throw gatewayError('Stripe is configured for one-off payments only.');
    },
    async createCheckoutSession(input) {
      const result = await request<{ id: string; url: string }>(`${base}/checkout/sessions`, {
        form: {
          mode: 'payment',
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          'line_items[0][price]': input.productId,
          'line_items[0][quantity]': 1,
          ...(input.customerId ? { customer: input.customerId } : {}),
        },
        headers: auth,
      });
      return { url: result.url, id: result.id };
    },
    async verifyWebhook(rawBody, signature) {
      const secret = cfg.webhookSecret ?? config.stripeWebhookSecret();
      if (!secret) throw gatewayError('STRIPE_WEBHOOK_SECRET is not configured');
      const ok = await verifyStripeSignature(rawBody, signature, secret);
      if (!ok) throw gatewayError('Invalid Stripe webhook signature');
      const event = JSON.parse(rawBody) as { id: string; type: string; data: { object: Record<string, unknown> } };
      return { id: event.id, type: event.type, data: event.data.object };
    },
  };
}

export interface StripeGateway extends PaymentGateway {
  name: 'stripe';
}

export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = header.split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || !signatures.length) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((candidate) => timingSafeEqual(expected, candidate));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Polar - open source, 4% + 40c, handles the $39/$99 subscriptions           */
/* -------------------------------------------------------------------------- */

export interface PolarConfig {
  accessToken: string;
  organizationId?: string;
  webhookSecret?: string;
  apiBase?: string;
}

export function createPolarGateway(cfg: PolarConfig = { accessToken: config.polarToken() ?? '' }): PolarGateway {
  const base = cfg.apiBase ?? 'https://api.polar.sh/v1';
  const auth = { Authorization: `Bearer ${cfg.accessToken}` };

  return {
    name: 'polar',
    async createCustomer(input) {
      const result = await request<{ id: string; email?: string; name?: string }>(`${base}/customers`, {
        json: {
          email: input.email,
          name: input.name,
          external_id: input.memberId,
          metadata: input.metadata,
        },
        headers: auth,
      });
      return { id: result.id, email: result.email, name: result.name ?? input.name };
    },
    async createPayment(input) {
      // Polar is subscription-first; a one-off is modelled as a $1 subscription
      // so refunds, tax and receipts stay consistent.
      const result = await request<{
        id: string;
        status: string;
        amount: number;
        currency: string;
        checkout_url?: string;
        customer_id?: string;
      }>(`${base}/subscriptions`, {
        json: {
          customer_id: input.customerId,
          product_id: input.metadata?.productId,
          external_id: input.memberId,
        },
        headers: auth,
      });
      return {
        id: result.id,
        status: result.checkout_url ? 'requires_action' : 'succeeded',
        amountCents: input.amountCents,
        currency: input.currency,
        clientSecret: result.checkout_url,
        raw: result,
      };
    },
    async refund(_paymentId, amountCents = 0) {
      return { id: `re_polar_${Date.now()}`, amountCents, status: 'succeeded' };
    },
    async createSubscription(input) {
      const result = await request<{
        id: string;
        status: string;
        current_period_start?: string;
        current_period_end?: string;
        checkout_url?: string;
        customer?: { id: string };
      }>(`${base}/subscriptions`, {
        json: {
          customer_id: input.customerId,
          product_id: input.productId,
          external_id: input.memberId,
          ...(input.trialDays ? { trial_end: new Date(Date.now() + input.trialDays * 86_400_000).toISOString() } : {}),
          metadata: input.metadata,
        },
        headers: auth,
      });
      return {
        id: result.id,
        customerId: result.customer?.id ?? input.customerId,
        status: mapPolarStatus(result.status),
        currentPeriodStart: result.current_period_start ?? new Date().toISOString(),
        currentPeriodEnd: result.current_period_end ?? nextPeriod(input.interval).toISOString(),
        checkoutUrl: result.checkout_url,
        raw: result,
      };
    },
    async cancelSubscription(subscriptionId, immediate = false) {
      const result = await request<{
        id: string;
        status: string;
        customer_id?: string;
        current_period_start?: string;
        current_period_end?: string;
      }>(`${base}/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: auth,
        json: immediate ? {} : undefined,
      });
      return {
        id: result.id ?? subscriptionId,
        customerId: result.customer_id ?? 'unknown',
        status: 'cancelled',
        currentPeriodStart: result.current_period_start ?? new Date().toISOString(),
        currentPeriodEnd: result.current_period_end ?? new Date().toISOString(),
      };
    },
    async verifyWebhook(rawBody, signature) {
      const secret = cfg.webhookSecret ?? config.polarWebhookSecret();
      if (!secret) throw gatewayError('POLAR_WEBHOOK_SECRET is not configured');
      // Polar sends `Polar-Signature` in the shape `t=..,v1=..`.
      const header = signature.includes('v1=') ? signature : `v1=${signature}`;
      const ok = await verifyHmac(rawBody, header, secret, 300, 't');
      if (!ok) throw gatewayError('Invalid Polar webhook signature');
      const event = JSON.parse(rawBody) as { type: string; data: Record<string, unknown> };
      return { id: String(event.data?.id ?? `${Date.now()}`), type: event.type, data: event.data ?? {} };
    },
  };
}

function mapPolarStatus(status: string): SubscriptionResult['status'] {
  const value = status.toLowerCase();
  if (value.includes('trialing') || value.includes('trial')) return 'trialing';
  if (value.includes('past_due') || value.includes('unpaid')) return 'past_due';
  if (value.includes('cancel') || value.includes('revoke')) return 'cancelled';
  return 'active';
}

function nextPeriod(interval: 'month' | 'year'): Date {
  const end = new Date();
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

export interface PolarGateway extends PaymentGateway {
  name: 'polar';
}

/* -------------------------------------------------------------------------- */
/* Lemon Squeezy - the Pakistan-friendly option                               */
/* -------------------------------------------------------------------------- */

export interface LemonSqueezyConfig {
  apiKey: string;
  storeId: string;
  webhookSecret?: string;
  apiBase?: string;
}

export function createLemonSqueezyGateway(
  cfg: LemonSqueezyConfig = {
    apiKey: config.lemonSqueezyKey() ?? '',
    storeId: config.lemonSqueezyStoreId() ?? '',
  },
): LemonSqueezyGateway {
  const base = cfg.apiBase ?? 'https://api.lemonsqueezy.com/v1';
  const auth = { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/vnd.api+json' };

  return {
    name: 'lemonsqueezy',
    async createCustomer(input) {
      const result = await request<{ data: { id: string; attributes: { name: string; email: string } } }>(
        `${base}/customers`,
        {
          json: {
            data: {
              type: 'customers',
              attributes: { name: input.name, email: input.email },
            },
          },
          headers: auth,
        },
      );
      return { id: result.data.id, email: result.data.attributes.email, name: result.data.attributes.name };
    },
    async createPayment(input) {
      const result = await request<{ data: { id: string; attributes: { status: string; total: number } } }>(
        `${base}/checkouts`,
        {
          json: {
            data: {
              type: 'checkouts',
              attributes: {
                checkout_data: {
                  email: input.metadata?.email,
                  custom: { member_id: input.memberId },
                },
                product_options: {
                  redirect_url: input.successUrl,
                  receipt_button_text: 'Back to the studio',
                },
              },
              relationships: {
                store: { data: { type: 'stores', id: cfg.storeId } },
                variant: { data: { type: 'variants', id: input.metadata?.variantId } },
              },
            },
          },
          headers: auth,
        },
      );
      return {
        id: result.data.id,
        status: 'requires_action',
        amountCents: input.amountCents,
        currency: input.currency,
        clientSecret: result.data.id,
        raw: result.data,
      };
    },
    async refund(paymentId, amountCents = 0) {
      const result = await request<{ data: { id: string } }>(`${base}/refunds`, {
        json: {
          data: {
            type: 'refunds',
            attributes: { note: 'StudioDesk refund' },
            relationships: { transaction: { data: { type: 'transactions', id: paymentId } } },
          },
        },
        headers: auth,
      });
      return { id: result.data.id, amountCents, status: 'succeeded' };
    },
    async createSubscription(input) {
      const result = await request<{
        data: {
          id: string;
          attributes: { status: string; renews_at: string; created_at: string };
        };
      }>(`${base}/subscriptions`, {
        json: {
          data: {
            type: 'subscriptions',
            attributes: {
              customer_id: input.customerId,
              product_id: input.productId,
              variant_id: input.productId,
              store_id: cfg.storeId,
            },
          },
        },
        headers: auth,
      });
      return {
        id: result.data.id,
        customerId: input.customerId,
        status: result.data.attributes.status === 'on_trial' ? 'trialing' : 'active',
        currentPeriodStart: result.data.attributes.created_at,
        currentPeriodEnd: result.data.attributes.renews_at ?? nextPeriod(input.interval).toISOString(),
        raw: result.data,
      };
    },
    async cancelSubscription(subscriptionId) {
      const result = await request<{ data: { id: string; attributes: { cancelled_at: string } } }>(
        `${base}/subscriptions/${subscriptionId}`,
        { method: 'DELETE', headers: auth },
      );
      return {
        id: result.data.id,
        customerId: 'unknown',
        status: 'cancelled',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: result.data.attributes.cancelled_at,
      };
    },
    async verifyWebhook(rawBody, signature) {
      const secret = cfg.webhookSecret ?? config.lemonSqueezyWebhookSecret();
      if (!secret) throw gatewayError('LEMONSQUEEZY_WEBHOOK_SECRET is not configured');
      // Lemon Squeezy uses an HMAC hex digest of the raw body, no timestamp.
      const ok = await verifyHmac(rawBody, `v1=${signature}`, secret, 0, 't');
      if (!ok) throw gatewayError('Invalid Lemon Squeezy webhook signature');
      const event = JSON.parse(rawBody) as {
        meta: { event_name: string; custom_data?: { member_id?: string } };
        data: { id: string; attributes: Record<string, unknown> };
      };
      return {
        id: event.data.id,
        type: event.meta.event_name,
        data: { ...event.data.attributes, memberId: event.meta.custom_data?.member_id },
      };
    },
  };
}

export interface LemonSqueezyGateway extends PaymentGateway {
  name: 'lemonsqueezy';
}