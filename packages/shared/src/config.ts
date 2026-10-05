/**
 * Environment access that never throws. Every integration in StudioDesk is
 * optional: with an empty environment the app runs in "demo mode" against the
 * in-memory repository, which is exactly what the test suite and `npm run seed`
 * rely on.
 */

export type Env = Record<string, string | undefined>;

export function readEnv(env: Env = typeof process !== 'undefined' ? (process.env as Env) : {}): Env {
  return env ?? {};
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'change-me' || trimmed === 'change-me-too') return undefined;
  return trimmed;
}

export function getString(key: string, env?: Env): string | undefined {
  return clean((env ?? readEnv())[key]);
}

export function getNumber(key: string, fallback: number, env?: Env): number {
  const raw = getString(key, env);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getBool(key: string, fallback: boolean, env?: Env): boolean {
  const raw = getString(key, env)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export const config = {
  port: () => getNumber('PORT', 4000),
  nodeEnv: () => getString('NODE_ENV') ?? 'development',
  webUrl: () => getString('PUBLIC_WEB_URL') ?? 'http://localhost:3000',
  apiUrl: () => getString('API_URL') ?? `http://localhost:${getNumber('PORT', 4000)}`,
  nextAuthSecret: (env?: Env) => getString('NEXTAUTH_SECRET', env) ?? 'studiodesk-dev-secret-do-not-use-in-prod',
  allowEmailLogin: (env?: Env) => getBool('ALLOW_EMAIL_LOGIN', true, env),
  supabaseUrl: (env?: Env) => getString('NEXT_PUBLIC_SUPABASE_URL', env),
  supabaseAnonKey: (env?: Env) => getString('NEXT_PUBLIC_SUPABASE_ANON_KEY', env),
  supabaseServiceKey: (env?: Env) => getString('SUPABASE_SERVICE_ROLE_KEY', env),
  groqApiKey: (env?: Env) => getString('GROQ_API_KEY', env),
  groqModel: (env?: Env) => getString('GROQ_MODEL', env) ?? 'llama-3.3-70b-versatile',
  resendApiKey: (env?: Env) => getString('RESEND_API_KEY', env),
  emailFrom: (env?: Env) => getString('EMAIL_FROM', env) ?? 'StudioDesk <onboarding@resend.dev>',
  useSendUrl: (env?: Env) => getString('USE_SEND_URL', env),
  useSendToken: (env?: Env) => getString('USE_SEND_TOKEN', env),
  stripeSecretKey: (env?: Env) => getString('STRIPE_SECRET_KEY', env),
  stripeWebhookSecret: (env?: Env) => getString('STRIPE_WEBHOOK_SECRET', env),
  polarToken: (env?: Env) => getString('POLAR_ACCESS_TOKEN', env),
  polarWebhookSecret: (env?: Env) => getString('POLAR_WEBHOOK_SECRET', env),
  lemonSqueezyKey: (env?: Env) => getString('LEMONSQUEEZY_API_KEY', env),
  lemonSqueezyStoreId: (env?: Env) => getString('LEMONSQUEEZY_STORE_ID', env),
  lemonSqueezyWebhookSecret: (env?: Env) => getString('LEMONSQUEEZY_WEBHOOK_SECRET', env),
  recurringGateway: (env?: Env) => (getString('RECURRING_GATEWAY', env) ?? 'polar') as 'polar' | 'lemonsqueezy' | 'stripe',
  checkinSecret: (env?: Env) => getString('CHECKIN_SIGNING_SECRET', env) ?? 'studiodesk-dev-checkin-secret',
  uptimeFlareKey: (env?: Env) => getString('UPTIMEFLARE_API_KEY', env),
  /** True when at least one hosted backend is configured. */
  hasHostedBackend: (env?: Env) => Boolean(config.supabaseUrl(env) && config.supabaseServiceKey(env)),
  hasAi: (env?: Env) => Boolean(config.groqApiKey(env)),
  hasPayments: (env?: Env) =>
    Boolean(config.stripeSecretKey(env) || config.polarToken(env) || config.lemonSqueezyKey(env)),
};

export type StudioDeskConfig = typeof config;