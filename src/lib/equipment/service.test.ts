/**
 * Who gets what of the equipment rows. These are the rules the browser cannot be
 * trusted with: a hidden column has to be absent from the query itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT_COLUMNS } from './columns';

vi.mock('server-only', () => ({}));

type Grant = 'hidden' | 'view' | 'edit';

const state = {
  flagged: true,
  listed: true,
  opens: true,
  subtab: 'edit' as Grant,
  columns: {} as Record<string, Grant>,
  addProviders: 'no',
  allowed: true,
  row: { id: 'row-1', record_id: 'rec-1', provider_id: null } as Record<string, unknown> | null,
  rows: [] as Record<string, unknown>[],
  providers: [{ id: '00000000-0000-4000-8000-000000000001', name: 'NMI' }] as { id: string; name: string }[],
  selects: [] as { table: string; columns: string }[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  rpcError: null as { code: string; message: string } | null,
};

const chain = (table: string) => {
  const c = {
    select: (columns: string) => {
      state.selects.push({ table, columns });
      return c;
    },
    eq: () => c,
    is: () => c,
    order: () => c,
    maybeSingle: async () => {
      if (table === 'records') return { data: state.listed ? { id: 'rec-1' } : null, error: null };
      if (table === 'equipment_rows') return { data: state.row, error: null };
      return { data: state.providers[0] ?? null, error: null };
    },
    then: (resolve: (r: unknown) => void) => resolve({ data: table === 'equipment_rows' ? state.rows : state.providers, error: null }),
  };
  return c;
};

vi.mock('@/lib/records/config', () => ({
  loadConfig: async () => ({
    subtabs: state.flagged ? [{ id: 'st', tabId: 'tab', showsEquipmentSetup: true }] : [],
    rowColumns: EQUIPMENT_COLUMNS.map((c) => ({ id: c.fieldKey, key: c.fieldKey, label: `Label ${c.column}`, subtabId: 'st', tabId: 'tab' })),
  }),
}));
vi.mock('@/lib/records/permissions', () => ({
  permissionsFor: async () => ({ settings: { 'equipment.add_providers': state.addProviders } }),
}));
vi.mock('@/lib/records/tabAccess', () => ({
  subtabCapsFor: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, state.subtab])),
  fieldCapsFor: async (_c: unknown, ids: string[], field: { key: string }) => new Map(ids.map((id) => [id, state.columns[field.key] ?? state.subtab])),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => ({ allowed: state.allowed, retryAfterSeconds: 0 }),
  userKey: (scope: string, id: string) => `${scope}:user:${id}`,
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: (table: string) => chain(table),
    rpc: async () => ({ data: state.opens, error: null }),
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      return { data: 'new-id', error: state.rpcError };
    },
  }),
}));

import { addEquipmentProvider, addEquipmentRow, deleteEquipmentRow, equipmentFor, updateEquipmentRow } from './service';

const ctx = { userId: 'user-1', isAdmin: false } as never;
const ROW = 'row-1';
const REC = 'rec-1';

beforeEach(() => {
  Object.assign(state, {
    flagged: true,
    listed: true,
    opens: true,
    subtab: 'edit',
    columns: {},
    addProviders: 'no',
    allowed: true,
    row: { id: ROW, record_id: REC, provider_id: null },
    rows: [],
    providers: [{ id: '00000000-0000-4000-8000-000000000001', name: 'NMI' }],
    selects: [],
    rpc: [],
    rpcError: null,
  });
});

const rowSelect = () => state.selects.filter((s) => s.table === 'equipment_rows').map((s) => s.columns).join(' ');

describe('who sees the panel', () => {
  it('nobody, until the sub-tab exists', async () => {
    state.flagged = false;
    expect(await equipmentFor(ctx, REC)).toBeNull();
  });
  it('not on a record they cannot open', async () => {
    state.opens = false;
    expect(await equipmentFor(ctx, REC)).toBeNull();
    expect(rowSelect()).toBe('');
  });
  it('not on a record outside their list', async () => {
    state.listed = false;
    expect(await equipmentFor(ctx, REC)).toBeNull();
  });
  it('not with the sub-tab Hidden, and nothing is fetched', async () => {
    state.subtab = 'hidden';
    expect(await equipmentFor(ctx, REC)).toBeNull();
    expect(rowSelect()).toBe('');
  });
});

describe('a hidden column', () => {
  beforeEach(() => {
    state.columns = { eq_monthly_fee: 'hidden' };
    state.rows = [{ id: ROW, row_no: 1, item: 'Terminal', monthly_fee: 99 }];
  });

  it('is absent from the query, not filtered afterwards', async () => {
    await equipmentFor(ctx, REC);
    expect(rowSelect()).toContain('item');
    expect(rowSelect()).not.toContain('monthly_fee');
  });
  it('is absent from what the browser gets', async () => {
    const panel = await equipmentFor(ctx, REC);
    expect(panel!.columns.map((c) => c.column)).not.toContain('monthly_fee');
    expect(Object.keys(panel!.rows[0]!.values)).not.toContain('monthly_fee');
    expect(JSON.stringify(panel)).not.toContain('99');
  });
  it('cannot be written either', async () => {
    const r = await updateEquipmentRow(ctx, ROW, 'monthly_fee', '5');
    expect(r.ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('a hidden provider column takes the provider list with it', async () => {
    state.columns = { eq_provider: 'hidden' };
    state.addProviders = 'yes';
    const panel = await equipmentFor(ctx, REC);
    expect(panel!.providers).toEqual([]);
    expect(panel!.canAddProviders).toBe(false);
    expect(state.selects.some((s) => s.table === 'equipment_providers')).toBe(false);
  });
  it('one column shown to a viewer of the sub-tab can still be edited by its own grant', async () => {
    state.subtab = 'view';
    state.columns = { eq_notes: 'edit' };
    const panel = await equipmentFor(ctx, REC);
    expect(panel!.columns.find((c) => c.column === 'notes')?.canEdit).toBe(true);
    expect(panel!.columns.find((c) => c.column === 'item')?.canEdit).toBe(false);
    expect(panel!.canManageRows).toBe(false);
  });
});

describe('View only', () => {
  beforeEach(() => {
    state.subtab = 'view';
  });
  it('no adding', async () => {
    expect((await addEquipmentRow(ctx, REC)).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('no removing', async () => {
    expect((await deleteEquipmentRow(ctx, ROW)).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('no changing', async () => {
    expect((await updateEquipmentRow(ctx, ROW, 'item', 'x')).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
});

describe('changing a value', () => {
  it('a blank fee goes down as nothing, not 0', async () => {
    await updateEquipmentRow(ctx, ROW, 'monthly_fee', '');
    expect(state.rpc[0]).toEqual({ fn: 'equipment_row_update', args: { p_row: ROW, p_actor: 'user-1', p_changes: { monthly_fee: null } } });
  });
  it('parsed by the column, so money is tidy', async () => {
    await updateEquipmentRow(ctx, ROW, 'monthly_fee', '$1,250.5');
    expect(state.rpc[0]!.args.p_changes).toEqual({ monthly_fee: '1250.50' });
  });
  it('refuses what the column cannot hold', async () => {
    const r = await updateEquipmentRow(ctx, ROW, 'monthly_fee', 'lots');
    expect(r).toEqual({ ok: false, message: expect.stringContaining('amount') });
    expect(state.rpc).toEqual([]);
  });
  it('only the eleven columns', async () => {
    expect((await updateEquipmentRow(ctx, ROW, 'record_id', 'x')).ok).toBe(false);
    expect((await updateEquipmentRow(ctx, ROW, 'deleted_at', null)).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('a row that has gone says so', async () => {
    state.row = null;
    expect(await updateEquipmentRow(ctx, ROW, 'item', 'x')).toEqual({ ok: false, message: 'That row no longer exists.' });
  });
  it('the provider has to be on the list', async () => {
    state.providers = [];
    const r = await updateEquipmentRow(ctx, ROW, 'provider_id', '00000000-0000-4000-8000-000000000009');
    expect(r.ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('Billed by cannot be the provider until there is one', async () => {
    const r = await updateEquipmentRow(ctx, ROW, 'billed_by', 'provider');
    expect(r).toEqual({ ok: false, message: 'Pick a provider for this row first.' });
    state.row = { id: ROW, record_id: REC, provider_id: 'p' };
    expect((await updateEquipmentRow(ctx, ROW, 'billed_by', 'provider')).ok).toBe(true);
  });
  it('a burst is refused', async () => {
    state.allowed = false;
    expect((await updateEquipmentRow(ctx, ROW, 'item', 'x')).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });
  it('the database\'s own failure does not reach the viewer as text', async () => {
    state.rpcError = { code: '23514', message: 'violates check constraint equipment_rows_x' };
    expect(await updateEquipmentRow(ctx, ROW, 'item', 'x')).toEqual({ ok: false, message: 'That could not be saved. Try again.' });
  });
});

describe('adding a custom provider', () => {
  it('not without the permission, and the option is not offered', async () => {
    expect((await addEquipmentProvider(ctx, REC, 'Blue Sky')).ok).toBe(false);
    expect(state.rpc).toEqual([]);
    expect((await equipmentFor(ctx, REC))!.canAddProviders).toBe(false);
  });
  it('anyone who can edit can still pick from the list', async () => {
    const panel = await equipmentFor(ctx, REC);
    expect(panel!.providers).toHaveLength(1);
    expect((await updateEquipmentRow(ctx, ROW, 'provider_id', state.providers[0]!.id)).ok).toBe(true);
  });
  it('not without Edit on the provider column, permission or no', async () => {
    state.addProviders = 'yes';
    state.columns = { eq_provider: 'view' };
    expect((await addEquipmentProvider(ctx, REC, 'Blue Sky')).ok).toBe(false);
    expect((await equipmentFor(ctx, REC))!.canAddProviders).toBe(false);
  });

  describe('with it', () => {
    beforeEach(() => {
      state.addProviders = 'yes';
    });
    it('tidies the name and logs on the record', async () => {
      const r = await addEquipmentProvider(ctx, REC, '  Blue   Sky ');
      expect(r.ok).toBe(true);
      expect(state.rpc[0]).toEqual({ fn: 'equipment_provider_add', args: { p_name: 'Blue Sky', p_record: REC, p_actor: 'user-1' } });
    });
    it('a duplicate, in any case, is refused in code', async () => {
      expect(await addEquipmentProvider(ctx, REC, 'nmi')).toEqual({ ok: false, message: 'That provider is already on the list.' });
      expect(state.rpc).toEqual([]);
    });
    it('a duplicate that slips through hits the database and reads the same', async () => {
      state.rpcError = { code: '23505', message: 'duplicate key' };
      expect(await addEquipmentProvider(ctx, REC, 'New One')).toEqual({ ok: false, message: 'That provider is already on the list.' });
    });
    it('a blank name is refused', async () => {
      expect((await addEquipmentProvider(ctx, REC, '   ')).ok).toBe(false);
      expect(state.rpc).toEqual([]);
    });
  });
});
