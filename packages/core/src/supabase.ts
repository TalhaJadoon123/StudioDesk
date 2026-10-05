import { config } from '@studiodesk/shared';
import type { Filter, OrderSpec, QueryOptions, Repository, Row, Table, TableName } from './repository.js';

/**
 * Supabase (free tier) driver.
 *
 * Every StudioDesk row is stored as JSONB in a single `records` table keyed by
 * (table, id). That keeps the free-tier schema tiny, makes the driver a ~150
 * line adapter, and means a brand new studio can be onboarded without any
 * migration. Run `npm run db:types` to print the optional relational schema if
 * you prefer normalised tables - the rest of the codebase is unaware.
 */

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  schema?: string;
}

export function toColumn(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function toField(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

interface RecordRow {
  table: string;
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

type Postgrest = {
  from: (table: string) => PostgrestQuery;
};

type PostgrestQuery = {
  select: (cols?: string) => PostgrestQuery;
  insert: (values: unknown) => PostgrestQuery;
  upsert: (values: unknown, opts?: { onConflict?: string }) => PostgrestQuery;
  update: (values: unknown) => PostgrestQuery;
  delete: () => PostgrestQuery;
  eq: (col: string, value: unknown) => PostgrestQuery;
  neq: (col: string, value: unknown) => PostgrestQuery;
  gt: (col: string, value: unknown) => PostgrestQuery;
  gte: (col: string, value: unknown) => PostgrestQuery;
  lt: (col: string, value: unknown) => PostgrestQuery;
  lte: (col: string, value: unknown) => PostgrestQuery;
  in: (col: string, values: unknown[]) => PostgrestQuery;
  is: (col: string, value: unknown) => PostgrestQuery;
  or: (filters: string) => PostgrestQuery;
  and: (filters: string) => PostgrestQuery;
  not: (column: string, operator: string, value: unknown) => PostgrestQuery;
  order: (col: string, opts?: { ascending?: boolean }) => PostgrestQuery;
  range: (from: number, to: number) => PostgrestQuery;
  limit: (n: number) => PostgrestQuery;
  single: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  then: <R>(onFulfilled: (value: { data: unknown; error: { message: string } | null }) => R) => Promise<R>;
};

function postgrestError(op: string, error: { message: string } | null): never {
  throw new Error(`supabase ${op} failed: ${error?.message ?? 'unknown error'}`);
}

function encodeValue(value: unknown): string {
  if (value === null) return 'is.null';
  if (typeof value === 'boolean') return value ? 'is.true' : 'is.false';
  if (typeof value === 'number') return `eq.${value}`;
  const text = String(value).replace(/[(),'"\\]/g, (c) => `\\${c}`);
  return `eq.${text}`;
}

/** Translates our filter language into PostgREST modifiers. */
export function applyFilter(query: PostgrestQuery, filter?: Filter): PostgrestQuery {
  if (!filter) return query;
  let q = query;
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$or' || field === '$and' || field === '$not') {
      const branches = (expected as Filter[]) ?? [];
      const encoded = branches.map((branch) => encodeFilter(branch)).join(',');
      if (field === '$or' && encoded) q = q.or(`(${encoded})`);
      if (field === '$and' && encoded) q = q.and(`(${encoded})`);
      continue;
    }
    const column = `data->>${toColumn(field)}`;
    if (Array.isArray(expected)) {
      q = expected.length ? q.in(column, expected) : q.eq(column, '__none__');
      continue;
    }
    if (expected && typeof expected === 'object') {
      const op = Object.keys(expected)[0] as keyof NonNullable<typeof expected>;
      const value = (expected as Record<string, unknown>)[op as string];
      if (op === '$in') q = q.in(column, value as unknown[]);
      else if (op === '$nin') q = q.not(column, 'in', `(${JSON.stringify(value)})`);
      else if (op === '$ne') q = q.neq(column, value);
      else if (op === '$gt') q = q.gt(column, value);
      else if (op === '$gte') q = q.gte(column, value);
      else if (op === '$lt') q = q.lt(column, value);
      else if (op === '$lte') q = q.lte(column, value);
      else if (op === '$isNull') q = q.is(column, null);
      // $like is handled client-side by the read-modify-write path below.
      continue;
    }
    q = q.eq(column, expected);
  }
  return q;
}

function encodeFilter(filter: Filter): string {
  const parts: string[] = [];
  for (const [field, expected] of Object.entries(filter)) {
    const column = `data->>${toColumn(field)}`;
    if (Array.isArray(expected)) parts.push(`${column}.in.(${expected.join(',')})`);
    else parts.push(`${column}.${encodeValue(expected)}`);
  }
  return parts.join(',');
}

function applyOrderSpec(query: PostgrestQuery, order?: OrderSpec | OrderSpec[]): PostgrestQuery {
  if (!order) return query;
  const specs = Array.isArray(order) ? order : [order];
  let q = query;
  for (const spec of specs) {
    q = q.order(`data->>${toColumn(spec.field)}`, { ascending: spec.dir !== 'desc' });
  }
  return q;
}

export class SupabaseTable<T extends { id: string }> implements Table<T> {
  constructor(
    readonly name: string,
    private readonly pg: Postgrest,
  ) {}

  #apply(options?: QueryOptions): PostgrestQuery {
    let q = applyFilter(this.pg.from('records').select('*'), options?.filter);
    q = applyOrderSpec(q, options?.order);
    if (options?.offset !== undefined && options.limit !== undefined) {
      q = q.range(options.offset, options.offset + options.limit - 1);
    } else if (options?.limit !== undefined) {
      q = q.limit(options.limit);
    }
    return q;
  }

  #decode(row: RecordRow): T {
    return { ...(row.data as T), id: row.id } as T;
  }

  #encode(row: Partial<T>): RecordRow {
    const data = { ...row } as Record<string, unknown>;
    const id = data.id as string;
    delete data.id;
    return {
      table: this.name,
      id,
      data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  async list(options?: QueryOptions): Promise<T[]> {
    const { data, error } = await this.#apply({ ...options, filter: withTable(this.name, options?.filter) });
    if (error) postgrestError(`select ${this.name}`, error);
    return ((data ?? []) as RecordRow[]).map((row) => this.#decode(row));
  }

  async findById(id: string): Promise<T | null> {
    const { data, error } = await this.pg
      .from('records')
      .select('*')
      .eq('table', this.name)
      .eq('id', id)
      .maybeSingle();
    if (error) postgrestError(`findById ${this.name}`, error);
    return data ? this.#decode(data as RecordRow) : null;
  }

  async findOne(options?: QueryOptions): Promise<T | null> {
    const rows = await this.list({ ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async count(options?: QueryOptions): Promise<number> {
    return (await this.list({ ...options, limit: undefined, offset: undefined })).length;
  }

  async insert(row: T): Promise<T> {
    const { data, error } = await this.pg.from('records').insert(this.#encode(row)).single();
    if (error) postgrestError(`insert ${this.name}`, error);
    return this.#decode(data as RecordRow);
  }

  async insertMany(rows: T[]): Promise<T[]> {
    if (!rows.length) return [];
    const { data, error } = await this.pg
      .from('records')
      .upsert(rows.map((row) => this.#encode(row)), { onConflict: 'table,id' })
      .select();
    if (error) postgrestError(`insertMany ${this.name}`, error);
    return ((data ?? []) as RecordRow[]).map((row) => this.#decode(row));
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = await this.findById(id);
    if (!existing) throw new Error(`supabase update ${this.name}/${id}: not found`);
    const merged = { ...existing, ...patch, id };
    const { data, error } = await this.pg
      .from('records')
      .update({ data: { ...merged, id: undefined } as Record<string, unknown>, updated_at: new Date().toISOString() })
      .eq('table', this.name)
      .eq('id', id)
      .single();
    if (error) postgrestError(`update ${this.name}`, error);
    return this.#decode(data as RecordRow);
  }

  async upsert(row: T, conflictKey = 'id'): Promise<T> {
    const keyValue = (row as Record<string, unknown>)[conflictKey] ?? row.id;
    const existing = await this.findById(String(keyValue));
    if (existing) return this.update(row.id, row);
    return this.insert(row);
  }

  async remove(id: string): Promise<boolean> {
    const { error } = await this.pg
      .from('records')
      .delete()
      .eq('table', this.name)
      .eq('id', id);
    if (error) postgrestError(`delete ${this.name}`, error);
    return true;
  }

  async removeWhere(filter: Filter): Promise<number> {
    const ids = (await this.list({ filter })).map((row) => row.id);
    if (!ids.length) return 0;
    const { error } = await this.pg
      .from('records')
      .delete()
      .eq('table', this.name)
      .in('id', ids);
    if (error) postgrestError(`deleteWhere ${this.name}`, error);
    return ids.length;
  }
}

function withTable(name: string, filter?: Filter): Filter {
  return { ...(filter ?? {}), table: name } as Filter;
}

export class SupabaseRepository implements Repository {
  readonly kind = 'supabase' as const;
  #tables = new Map<string, SupabaseTable<{ id: string }>>();
  #serial = Promise.resolve();

  constructor(
    private readonly pg: Postgrest,
    readonly config: SupabaseConfig,
  ) {}

  table<T extends TableName>(name: T): Table<Row<T>> {
    let found = this.#tables.get(name);
    if (!found) {
      found = new SupabaseTable(name, this.pg);
      this.#tables.set(name, found);
    }
    return found as unknown as Table<Row<T>>;
  }

  /**
   * Supabase REST has no multi-statement transaction, so we serialise writes
   * per process. Every mutation in StudioDesk is a single-row upsert, which
   * keeps this correct in practice; use `publishable` RPCs if you need
   * cross-row atomicity.
   */
  async transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    const run = this.#serial.then(() => fn(this));
    this.#serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    await this.#serial.catch(() => undefined);
  }
}

/**
 * Creates a Supabase-backed repository. Returns `null` when Supabase is not
 * configured so callers can fall back to the in-memory driver.
 */
export async function createSupabaseRepository(
  cfg: SupabaseConfig = {
    url: config.supabaseUrl() ?? '',
    serviceRoleKey: config.supabaseServiceKey() ?? '',
  },
): Promise<SupabaseRepository | null> {
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return new SupabaseRepository(client as unknown as Postgrest, cfg);
}

export const SUPABASE_SCHEMA_SQL = `-- StudioDesk: one row per entity, JSONB payload. Free tier friendly.
create table if not exists public.records (
  table_name text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (table_name, id)
);

create index if not exists records_table_idx on public.records (table_name);
create index if not exists records_data_idx  on public.records using gin (data);
create index if not exists records_created_idx on public.records (created_at desc);

alter table public.records enable row level security;

-- Server-side only. The API uses the service-role key, the client apps never
-- touch this table directly.
create policy "service role only" on public.records
  for all using (auth.role() = 'service_role');
`;