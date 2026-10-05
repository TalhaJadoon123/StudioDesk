import { config } from '@studiodesk/shared';

/**
 * Minimal Groq client (free tier, OpenAI-compatible API).
 *
 * Used for churn prediction narratives and member insights. Everything degrades
 * gracefully: with no `GROQ_API_KEY` the caller falls back to the deterministic
 * heuristics in churn.ts, so the app never hard-depends on the LLM.
 */

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the model for strict JSON and parse it. */
  json?: boolean;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GroqError';
  }
}

export function isGroqConfigured(env?: Record<string, string | undefined>): boolean {
  return Boolean(config.groqApiKey(env));
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function chatCompletion(
  messages: GroqMessage[],
  options: GroqOptions = {},
): Promise<{ text: string; usage: GroqUsage; model: string }> {
  const apiKey = options.apiKey ?? config.groqApiKey();
  if (!apiKey) throw new GroqError('GROQ_API_KEY is not configured');

  const model = options.model ?? config.groqModel();
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 20_000;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 800,
          response_format: options.json ? { type: 'json_object' } : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // 429 and 5xx are worth retrying, 4xx are not.
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new GroqError(`Groq ${response.status}: ${body.slice(0, 300)}`, response.status, body);
        if (retryable && attempt < retries) {
          await backoff(attempt);
          continue;
        }
        throw lastError;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: GroqUsage;
      };
      const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
      return {
        text,
        usage: payload.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries && !(error instanceof GroqError && error.status && error.status < 500 && error.status !== 429)) {
        await backoff(attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError ?? new GroqError('Groq request failed');
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts the first JSON object/array from a model response. */
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Fall back to the first balanced object.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface GroqChatOptions extends GroqOptions {
  /** Called with the full prompt - used in tests and for debugging. */
  onPrompt?: (messages: GroqMessage[]) => void;
}

export async function askJson<T>(
  system: string,
  user: string,
  options: GroqChatOptions = {},
): Promise<T | null> {
  const messages: GroqMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  options.onPrompt?.(messages);
  const { text } = await chatCompletion(messages, { ...options, json: true });
  return extractJson<T>(text);
}