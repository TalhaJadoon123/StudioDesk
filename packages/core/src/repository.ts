import type {
  Attendance,
  Booking,
  Charge,
  Class,
  DunningEvent,
  DropIn,
  Fee,
  Instructor,
  Invoice,
  Member,
  Membership,
  ClassPack,
  Notification,
  Plan,
} from '@studiodesk/shared';

/** Structured deep clone that works on every runtime StudioDesk targets. */
const clone = <T>(value: T): T => globalThis.structuredClone(value);

/* -------------------------------------------------------------------------- */
/* Table registry                                                             */
/* -------------------------------------------------------------------------- */

export interface Studio {
  id: string;
  name: string;
  ownerId?: string;
  tier: 'free' | 'starter' | 'business';
  timezone: string;
  currency: 'usd' | 'eur' | 'gbp' | 'pkr';
  branding?: { accentColor?: string; logoUrl?: string };
  checkinGeofence?: { latitude: number; longitude: number; radiusMeters: number };
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KioskDevice {
  id: string;
  studioId: string;
  name: string;
  pin: string;
  location?: string;
  lastSeenAt?: string;
  active: boolean;
  createdAt: string;
}

export interface Tables {
  studios: Studio;
  members: Member;
  plans: Plan;
  instructors: Instructor;
  classes: Class;
  bookings: Booking;
  attendance: Attendance;
  invoices: Invoice;
  charges: Charge;
  memberships: Membership;
  packs: ClassPack;
  dropIns: DropIn;
  fees: Fee;
  notifications: Notification;
  dunningEvents: DunningEvent;
  devices: KioskDevice;
}

export type TableName = keyof Tables;
export type Row<T extends TableName> = Tables[T];

/** Every table has an `id` we can filter and update on. */
export type WithId = { id: string };

/* -------------------------------------------------------------------------- */
/* Query language                                                             */
/* -------------------------------------------------------------------------- */

export type Scalar = string | number | boolean | null | undefined;

export type ValueOp =
  | { $in: Scalar[] }
  | { $nin: Scalar[] }
  | { $ne: Scalar }
  | { $gt: Scalar }
  | { $gte: Scalar }
  | { $lt: Scalar }
  | { $lte: Scalar }
  | { $like: string }
  | { $isNull: true };

export type Filter = {
  $or?: Filter[];
  $and?: Filter[];
  $not?: Filter;
} & {
  [field: string]: Scalar | Scalar[] | ValueOp | Filter | Filter[] | undefined;
};

export type OrderSpec = { field: string; dir?: 'asc' | 'desc' };

export interface QueryOptions {
  filter?: Filter;
  order?: OrderSpec | OrderSpec[];
  limit?: number;
  offset?: number;
}

function isValueOp(value: unknown): value is ValueOp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((key) => key.startsWith('$'));
}

/** Evaluates `{ $gte: x, $lte: y }` - every operator in the object must pass. */
function matchesValueOp(actual: unknown, op: Record<string, unknown>): boolean {
  for (const [operator, expected] of Object.entries(op)) {
    const want = expected as Scalar;
    switch (operator) {
      case '$in':
        if (!(want as unknown as Scalar[]).includes(actual as Scalar)) return false;
        break;
      case '$nin':
        if ((want as unknown as Scalar[]).includes(actual as Scalar)) return false;
        break;
      case '$ne':
        if (actual === want) return false;
        break;
      case '$gt':
        if (!(actual !== null && actual !== undefined && compare(actual, want) > 0)) return false;
        break;
      case '$gte':
        if (!(actual !== null && actual !== undefined && compare(actual, want) >= 0)) return false;
        break;
      case '$lt':
        if (!(actual !== null && actual !== undefined && compare(actual, want) < 0)) return false;
        break;
      case '$lte':
        if (!(actual !== null && actual !== undefined && compare(actual, want) <= 0)) return false;
        break;
      case '$like':
        if (typeof actual !== 'string' || !actual.toLowerCase().includes(String(want).toLowerCase())) {
          return false;
        }
        break;
      case '$isNull':
        if (actual !== null && actual !== undefined) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b));
}

/** Evaluates the filter language against a plain object row. */
export function matchesFilter(row: Record<string, unknown>, filter?: Filter): boolean {
  if (!filter) return true;
  for (const [field, expected] of Object.entries(filter) as Array<[string, unknown]>) {
    if (field === '$or') {
      const branches = (expected as Filter[]) ?? [];
      if (!branches.some((branch) => matchesFilter(row, branch))) return false;
      continue;
    }
    if (field === '$and') {
      const branches = (expected as Filter[]) ?? [];
      if (!branches.every((branch) => matchesFilter(row, branch))) return false;
      continue;
    }
    if (field === '$not') {
      if (matchesFilter(row, expected as Filter)) return false;
      continue;
    }
    const actual = row[field];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual as Scalar)) return false;
      continue;
    }
    if (isValueOp(expected)) {
      if (!matchesValueOp(actual, expected as Record<string, unknown>)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyOrder<T>(rows: T[], order?: OrderSpec | OrderSpec[]): T[] {
  if (!order) return rows;
  const specs = Array.isArray(order) ? order : [order];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const result = compare(
        (a as Record<string, unknown>)[spec.field],
        (b as Record<string, unknown>)[spec.field],
      );
      if (result !== 0) return spec.dir === 'desc' ? -result : result;
    }
    return 0;
  });
}

function applyRange<T>(rows: T[], options?: QueryOptions): T[] {
  if (!options) return rows;
  const ordered = applyOrder(rows, options.order);
  const offset = options.offset ?? 0;
  const end = options.limit === undefined ? undefined : offset + options.limit;
  return ordered.slice(offset, end);
}

/* -------------------------------------------------------------------------- */
/* Table + Repository interfaces                                              */
/* -------------------------------------------------------------------------- */

export interface Table<T> {
  readonly name: string;
  list(options?: QueryOptions): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  findOne(options?: QueryOptions): Promise<T | null>;
  count(options?: QueryOptions): Promise<number>;
  insert(row: T): Promise<T>;
  insertMany(rows: T[]): Promise<T[]>;
  update(id: string, patch: Partial<T>): Promise<T>;
  upsert(row: T, conflictKey?: string): Promise<T>;
  remove(id: string): Promise<boolean>;
  removeWhere(filter: Filter): Promise<number>;
}

export interface Repository {
  readonly kind: 'memory' | 'supabase';
  /** `table('members')` is a `Table<Member>`. */
  table<T extends TableName>(name: T): Table<Row<T>>;
  /** Runs `fn` atomically. The memory driver runs it inline; Supabase uses RPC/serialised writes. */
  transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
  /** Persist anything buffered (no-op for memory). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Memory driver - the default, used by tests, `npm run seed` and demos       */
/* -------------------------------------------------------------------------- */

export type SeedData = Partial<Record<TableName, unknown[]>>;

export class MemoryTable<T extends WithId> implements Table<T> {
  readonly name: string;
  readonly rows = new Map<string, T>();
  #dirty = false;

  constructor(
    name: string,
    initial: T[] = [],
    private readonly onChange?: (name: string) => void,
  ) {
    this.name = name;
    for (const row of initial) this.rows.set(row.id, clone(row));
  }

  #touch(): void {
    this.#dirty = true;
    this.onChange?.(this.name);
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  async list(options?: QueryOptions): Promise<T[]> {
    const all = [...this.rows.values()].filter((row) =>
      matchesFilter(row as Record<string, unknown>, options?.filter),
    );
    return applyRange(all, options).map((row) => clone(row));
  }

  async findById(id: string): Promise<T | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async findOne(options?: QueryOptions): Promise<T | null> {
    const rows = await this.list({ ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async count(options?: QueryOptions): Promise<number> {
    if (!options?.filter) return this.rows.size;
    const all = [...this.rows.values()].filter((row) =>
      matchesFilter(row as Record<string, unknown>, options.filter),
    );
    return all.length;
  }

  async insert(row: T): Promise<T> {
    if (!row.id) throw new Error(`${this.name}: cannot insert a row without an id`);
    if (this.rows.has(row.id)) throw new Error(`${this.name}: duplicate id ${row.id}`);
    const stored = clone(row);
    this.rows.set(stored.id, stored);
    this.#touch();
    return clone(stored);
  }

  async insertMany(rows: T[]): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) out.push(await this.insert(row));
    return out;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`${this.name}: ${id} not found`);
    const merged = { ...existing, ...clone(patch), id } as T;
    this.rows.set(id, merged);
    this.#touch();
    return clone(merged);
  }

  async upsert(row: T, conflictKey = 'id'): Promise<T> {
    const key = (row as Record<string, unknown>)[conflictKey];
    const id = typeof key === 'string' ? key : row.id;
    if (this.rows.has(id)) return this.update(id, row);
    return this.insert(row);
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.rows.delete(id);
    if (removed) this.#touch();
    return removed;
  }

  async removeWhere(filter: Filter): Promise<number> {
    const victims = [...this.rows.values()].filter((row) =>
      matchesFilter(row as Record<string, unknown>, filter),
    );
    for (const row of victims) this.rows.delete(row.id);
    if (victims.length) this.#touch();
    return victims.length;
  }

  clear(): void {
    this.rows.clear();
    this.#touch();
  }
}

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;
  #tables = new Map<string, MemoryTable<WithId>>();

  constructor(seed: SeedData = {}) {
    for (const [name, rows] of Object.entries(seed)) {
      this.#tables.set(name, new MemoryTable(name, (rows ?? []) as WithId[]));
    }
  }

  table<T extends TableName>(name: T): Table<Row<T>> {
    let found = this.#tables.get(name);
    if (!found) {
      found = new MemoryTable(name, []);
      this.#tables.set(name, found);
    }
    return found as unknown as Table<Row<T>>;
  }

  /** Direct (non-cloning) handle used by seeds and tests. */
  rawTable(name: TableName): MemoryTable<WithId> {
    return this.table(name) as unknown as MemoryTable<WithId>;
  }

  async transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.#tables.clear();
  }

  /** Snapshot every table - handy for assertions and debug dumps. */
  dump(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [name, table] of this.#tables) out[name] = [...table.rows.values()];
    return out;
  }

  restore(snapshot: Record<string, unknown[]>): void {
    this.#tables.clear();
    for (const [name, rows] of Object.entries(snapshot)) {
      this.#tables.set(name, new MemoryTable(name, rows as WithId[]));
    }
  }
}