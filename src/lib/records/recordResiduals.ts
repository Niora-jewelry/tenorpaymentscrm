/**
 * What one merchant earned — read from the merchant's own record.
 *
 * ── THE "VICE VERSA" HALF OF THE LINK KERNEL ─────────────────────────────
 * Daniel, on what linking a MID to a record is for: *"attaching a residual row
 * to the CRM merchant record it belongs to, so the module can be navigated
 * from the CRM and vice versa."* Everything before this was the admin
 * calculation surface. This is the other direction: open a merchant, see its
 * figures.
 *
 * ── IT KEYS ON THE RECORD'S MID, NOT ON `record_id` ──────────────────────
 * Which looks backwards, since `residual_lines.record_id` exists. It is
 * deliberate, and it is Daniel's rule:
 *
 *   "Linking is a convenience for humans; pricing never depends on it."
 *
 * `record_id` is a navigation aid maintained by the reconcile sweep. The MID on
 * the record's Pricing tab is what every rate, line and volume is actually
 * keyed on. Reading by `record_id` would show nothing for a merchant whose
 * link has not been swept yet — figures that exist, attributed correctly, and
 * invisible — whereas reading by MID shows what is there and is wrong only if
 * the MID itself is wrong, which is a thing the operator can see and fix.
 *
 * ── ADMIN ONLY, SAID OUT LOUD ────────────────────────────────────────────
 * Every residual reader is `security definer` gated on `auth_is_admin()`. A
 * non-admin who has been granted this tab gets `adminOnly: true` and a panel
 * that says so — never an empty one. "There is nothing here" and "you may not
 * see this" must not look the same, and on a tab whose whole content is money
 * the difference is the one that matters.
 *
 * Widening that is a client decision the spec does not make. When it is made,
 * it is one SECURITY DEFINER reader gated on the tab grant instead.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';

/** One month's figures for this merchant. Money as text, always. */
export type RecordResidualPeriod = {
  periodId: string;
  statementMonth: string;
  /** Null unless the month computed completely. Never rendered as 0. */
  netIncome: string | null;
  /** False means the month carries no calculation version, so no total exists. */
  disclosable: boolean;
  rowsTotal: number;
  rowsComputed: number;
  /** The month's own state, derived at merchant grain for THIS merchant. */
  state: string | null;
  /** Set only for `awaiting_volumes`; a sentence, not a code. */
  awaitingReason: string | null;
  mismatchCount: number;
  suppressedCount: number;
  /** True once the month is signed off. */
  signedOff: boolean;
};

export type RecordResiduals =
  /** The viewer may not see figures. Distinct from having none. */
  | { kind: 'admin_only' }
  /** The record carries no MID, so nothing can be keyed to it. */
  | { kind: 'no_mid' }
  /** A MID, but no statement line anywhere. */
  | { kind: 'no_statements'; mid: string }
  | {
      kind: 'figures';
      mid: string;
      periods: RecordResidualPeriod[];
      /** Lifetime net across every computed month, or null while incomplete. */
      lifetimeNetIncome: string | null;
      lifetimeDisclosable: boolean;
      periodsTotal: number;
      periodsComputed: number;
    };

/** Digits only — the same normalisation every residual table applies. */
function normaliseMid(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[^0-9]/g, '') : '';
}

export async function residualsForRecord(
  ctx: AuthContext,
  recordId: string,
): Promise<RecordResiduals> {
  /*
   * Checked here rather than letting the RPCs raise. A 42501 from five
   * functions would surface as an error page on a tab somebody has legitimate
   * View access to, which is a worse answer than the honest one.
   */
  if (!ctx.isAdmin) return { kind: 'admin_only' };

  /*
   * The record's own MID. Read through the service role because this is the
   * residuals module asking about a record it does not own, and the field-level
   * permission question has already been answered by the tab grant that let
   * this tab render at all.
   */
  const { data: rec, error: recError } = await supabaseAdmin()
    .from('records')
    .select('values')
    .eq('id', recordId)
    .is('deleted_at', null)
    .maybeSingle();

  if (recError) {
    console.error('[residuals] reading the record MID failed', recError);
    throw new Error(`That merchant could not be read: ${recError.message}`);
  }

  const mid = normaliseMid((rec as { values?: Record<string, unknown> } | null)?.values?.mid);
  if (mid === '') return { kind: 'no_mid' };

  /*
   * Which periods this MID appears in. A table read, so the service role is
   * right: it bypasses RLS, and `ctx.isAdmin` above is the gate.
   */
  const { data: lines, error: linesError } = await supabaseAdmin()
    .from('residual_lines')
    .select('period_id')
    .eq('mid', mid)
    .is('deleted_at', null);

  if (linesError) {
    console.error('[residuals] reading the merchant lines failed', linesError);
    throw new Error(`That merchant's statement lines could not be read: ${linesError.message}`);
  }

  const periodIds = [...new Set((lines ?? []).map((l) => (l as { period_id: string }).period_id))];
  if (periodIds.length === 0) return { kind: 'no_statements', mid };

  const { data: periodRows } = await supabaseAdmin()
    .from('residual_periods')
    .select('id, statement_month, status')
    .in('id', periodIds)
    .is('deleted_at', null)
    .order('statement_month', { ascending: false });

  const periodMeta = (periodRows ?? []) as {
    id: string;
    statement_month: string;
    status: string;
  }[];

  /*
   * The synopsis and the state, per period, through the REQUEST-SCOPED client —
   * both are `security definer` gated on auth.uid(), so the service role is
   * refused outright.
   *
   * One pair of calls per period. A merchant has as many periods as there are
   * months of statements, so this grows a dozen a year; the alternative is a
   * reader function that does not exist yet, and writing one to save round
   * trips on a drawer would be inventing a second answer to "what did this
   * merchant earn".
   */
  const caller = await createSupabaseServerClient();

  const periods = await Promise.all(
    periodMeta.map(async (p): Promise<RecordResidualPeriod> => {
      const [syn, states] = await Promise.all([
        caller.rpc('residual_synopsis', { p_period_id: p.id, p_mid: mid, p_lifetime: false }),
        caller.rpc('residual_merchant_states', { p_period_id: p.id, p_processor: null }),
      ]);

      if (syn.error) console.error('[residuals] record synopsis failed', p.statement_month, syn.error);
      if (states.error) console.error('[residuals] record state failed', p.statement_month, states.error);

      const s = ((syn.data ?? []) as Record<string, unknown>[]).find((r) => r.mid === mid);
      const st = ((states.data ?? []) as Record<string, unknown>[]).find((r) => r.mid === mid);

      return {
        periodId: p.id,
        statementMonth: p.statement_month,
        netIncome: (s?.net_income as string | null) ?? null,
        disclosable: s?.disclosable === true,
        rowsTotal: Number(s?.rows_total ?? 0),
        rowsComputed: Number(s?.rows_computed ?? 0),
        state: (st?.state as string | null) ?? null,
        awaitingReason: (st?.awaiting_reason as string | null) ?? null,
        mismatchCount: Number(st?.mismatch_count ?? 0),
        suppressedCount: Number(st?.suppressed_count ?? 0),
        signedOff: p.status === 'reconciled',
      };
    }),
  );

  /*
   * The lifetime figure comes from `residual_synopsis(..., p_lifetime => true)`
   * rather than from adding the months up here. Adding them would be the
   * client computing money, and it would also quietly produce a total across
   * only the months that happened to be disclosable — a sum missing one side
   * of the ledger, which is the thing the whole disclosure rule exists to
   * prevent.
   */
  const lifetime = await caller.rpc('residual_synopsis', {
    p_period_id: periods[0]?.periodId ?? null,
    p_mid: mid,
    p_lifetime: true,
  });

  if (lifetime.error) {
    console.error('[residuals] lifetime synopsis failed', lifetime.error);
  }

  const life = ((lifetime.data ?? []) as Record<string, unknown>[]).find((r) => r.mid === mid);

  return {
    kind: 'figures',
    mid,
    periods,
    lifetimeNetIncome: (life?.net_income as string | null) ?? null,
    lifetimeDisclosable: life?.disclosable === true,
    periodsTotal: Number(life?.periods_total ?? periods.length),
    periodsComputed: Number(life?.periods_computed ?? 0),
  };
}
