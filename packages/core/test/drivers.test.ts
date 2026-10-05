import { describe, expect, it } from 'vitest';
import { memoryDriver, supabaseFilterSpec } from '@studiodesk/core';

describe('repository adapter contract', () => {
  it('documents the memory driver as the default', () => {
    expect(memoryDriver).toBe('memory');
  });

  it('describes the Supabase storage shape', () => {
    const spec = supabaseFilterSpec;
    expect(spec.table).toBe('records');
    expect(spec.primaryKey).toEqual(['table_name', 'id']);
    // One JSONB row per entity keeps the free tier small and migrations boring.
    expect(spec.payloadColumn).toBe('data');
  });

  it('lists the tables the platform expects to exist', () => {
    expect(supabaseFilterSpec.tables).toContain('members');
    expect(supabaseFilterSpec.tables).toContain('bookings');
    expect(supabaseFilterSpec.tables).toContain('invoices');
  });
});
