/**
 * Importing a sheet of merchant rates — the field vocabulary, client-safe.
 *
 * ── WHY A BULK PATH EXISTS AT ALL ────────────────────────────────────────
 * The per-merchant editor is the right tool for one rate. It is the wrong tool
 * for the state the project is actually in: `monthly_fee_tapdash` is empty for
 * every merchant and rule #2 raises without it, so a first real month needs 34
 * merchants priced before it can compute once. The handoff makes this Step 3's
 * primary path and the editor its second.
 *
 * ── THE TWENTY KEYS ARE THE RPC'S, READ OFF ITS BODY ─────────────────────
 * `commit_residual_merchant_rates_import` reads exactly these from each array
 * element. A key it does not read is silently ignored, which is why the
 * builder below emits only these and nothing else — a typo that reaches the
 * RPC is a dropped rate, not an error.
 *
 * ── `risk_code` IS AN INTEGER, NOT A TIER NAME ───────────────────────────
 * It resolves through `residual_risk_tiers.statement_code`, and the RPC says
 * why in its own comment: "RISK TIER RESOLVES THROUGH
 * residual_risk_tiers.statement_code, never a hardcoded 1/2/3 map. That table
 * exists to own this vocabulary and R5c seeded it; a second copy of the
 * mapping here is how the two drift."
 *
 * So this file does not carry that map either. 1/2/3 appear below only as the
 * hint text an operator reads, and the resolution happens in SQL. Note that
 * `no_program` has NO statement code — the sheet cannot express it, and such a
 * merchant is priced through the editor.
 */
import { readNumeric, readText, type CellValue, type ParsedSheet } from './xlsxParser';

/** One column of the rates sheet. */
export type RateImportField = {
  key: string;
  label: string;
  /** 'rate' and 'money' go through `readNumeric`; the others stay text. */
  kind: 'rate' | 'money' | 'int' | 'text';
  hint?: string;
};

/**
 * Grouped as the operator reads them, which is also how the sheet is laid out.
 *
 * Order within a group is the RPC's own read order, so a reviewer can follow
 * this file against that one without re-sorting.
 */
export const RATE_IMPORT_GROUPS: { title: string; note?: string; fields: RateImportField[] }[] = [
  {
    title: 'Identity',
    fields: [
      {
        key: 'mid',
        label: 'MID',
        kind: 'text',
        hint: 'Required. Matched digits-only, so punctuation in the sheet is harmless.',
      },
      { key: 'merchant_name', label: 'Merchant name', kind: 'text', hint: 'Carried for reference.' },
      {
        key: 'risk_code',
        label: 'Risk code',
        kind: 'int',
        hint: 'Required. 1, 2 or 3 on the statement — resolved against the risk-tier table, not a map in the code. It selects the split percentage, so the wrong one is not a small error.',
      },
    ],
  },
  {
    title: 'Per-item fees',
    fields: [
      { key: 'vmd_auth_fee', label: 'VMD auth fee', kind: 'rate' },
      { key: 'pin_debit_auth_fee', label: 'PIN debit auth fee', kind: 'rate' },
      { key: 'avs_fee', label: 'AVS fee', kind: 'rate' },
      { key: 'batch_fee', label: 'Batch fee', kind: 'rate' },
      { key: 'vmd_transaction_fee', label: 'VMD transaction fee', kind: 'rate' },
      { key: 'chargeback_fee', label: 'Chargeback fee', kind: 'money' },
    ],
  },
  {
    title: 'Volume rates',
    note: 'A value at or above 0.10 is refused as percent-scaled — see the note below the grid.',
    fields: [
      { key: 'vmd_volume', label: 'VMD volume', kind: 'rate' },
      { key: 'amex_volume', label: 'Amex volume', kind: 'rate' },
      { key: 'pin_debit_volume', label: 'PIN debit volume', kind: 'rate' },
      { key: 'amex_template_volume_fee', label: 'Amex template volume fee', kind: 'rate' },
    ],
  },
  {
    title: 'Monthly charges',
    fields: [
      {
        key: 'monthly_fee_tapdash',
        label: 'Monthly fee (TapDash)',
        kind: 'money',
        hint: 'Rule #2 raises without it, for every merchant. This is the column the first real month is waiting on.',
      },
      {
        key: 'monthly_fee_maverick',
        label: 'Monthly fee (Maverick)',
        kind: 'money',
        hint: 'Only read for months before the changeover.',
      },
      { key: 'gateway_monthly_mav', label: 'Gateway monthly', kind: 'money' },
      { key: 'terminal_monthly_mav', label: 'Terminal monthly', kind: 'money' },
    ],
  },
  {
    title: 'Providers and notes',
    fields: [
      { key: 'gateway_provider_mav', label: 'Gateway provider', kind: 'text' },
      { key: 'terminal_provider_mav', label: 'Terminal provider', kind: 'text' },
      { key: 'notes', label: 'Notes', kind: 'text' },
    ],
  },
];

export const RATE_IMPORT_FIELDS: readonly RateImportField[] = RATE_IMPORT_GROUPS.flatMap(
  (g) => g.fields,
);

export const RATE_IMPORT_KEYS: readonly string[] = RATE_IMPORT_FIELDS.map((f) => f.key);

export const RATE_IMPORT_FIELD: Record<string, RateImportField> = Object.fromEntries(
  RATE_IMPORT_FIELDS.map((f) => [f.key, f] as const),
);

/** Without these the RPC cannot place a row at all. */
export const RATE_IMPORT_REQUIRED: readonly string[] = ['mid', 'risk_code'];

/**
 * The sheet this importer is for.
 *
 * Named so the screen can say it, and matched loosely because the real tab
 * name is truncated by Excel's 31-character limit — "Drawer tab Processor-TD
 * Merchan" is the whole name, cut mid-word, and a workbook re-saved by another
 * tool may differ in spacing or case.
 */
export const RATES_SHEET_HINT = 'Drawer tab Processor-TD Merchan';

export function looksLikeRatesSheet(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n.includes('processor') && (n.includes('td') || n.includes('merchan'));
}

/**
 * Header spellings seen on the rates sheet, keyed by normalised header.
 *
 * Suggestions only, confirmed on screen before anything is sent — the same
 * posture as the fee-report importer, and for the same reason: the cost of a
 * wrong guess is a money column reading from the wrong source column, which
 * looks like a plausible number.
 */
const ALIASES: Record<string, string> = {
  mid: 'mid',
  'merchant number': 'mid',
  'merchant id': 'mid',
  'merchant name': 'merchant_name',
  dba: 'merchant_name',
  'dba name': 'merchant_name',
  'risk code': 'risk_code',
  risk: 'risk_code',
  'risk level': 'risk_code',
  'vmd auth fee': 'vmd_auth_fee',
  'vmd auth': 'vmd_auth_fee',
  'auth fee': 'vmd_auth_fee',
  'pin debit auth fee': 'pin_debit_auth_fee',
  'pin debit auth': 'pin_debit_auth_fee',
  'avs fee': 'avs_fee',
  avs: 'avs_fee',
  'batch fee': 'batch_fee',
  batch: 'batch_fee',
  'vmd transaction fee': 'vmd_transaction_fee',
  'transaction fee': 'vmd_transaction_fee',
  'chargeback fee': 'chargeback_fee',
  chargeback: 'chargeback_fee',
  'vmd volume': 'vmd_volume',
  'amex volume': 'amex_volume',
  'pin debit volume': 'pin_debit_volume',
  'amex template volume fee': 'amex_template_volume_fee',
  'monthly fee tapdash': 'monthly_fee_tapdash',
  'td monthly fee': 'monthly_fee_tapdash',
  'tapdash monthly fee': 'monthly_fee_tapdash',
  'monthly fee maverick': 'monthly_fee_maverick',
  'maverick monthly fee': 'monthly_fee_maverick',
  'gateway monthly': 'gateway_monthly_mav',
  'gateway monthly mav': 'gateway_monthly_mav',
  'terminal monthly': 'terminal_monthly_mav',
  'terminal monthly mav': 'terminal_monthly_mav',
  'gateway provider': 'gateway_provider_mav',
  gateway: 'gateway_provider_mav',
  'terminal provider': 'terminal_provider_mav',
  terminal: 'terminal_provider_mav',
  notes: 'notes',
  note: 'notes',
};

function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type RateHeaderSuggestion = {
  /** Verbatim, as the workbook holds it. */
  header: string;
  index: number;
  suggested: string | null;
};

export function suggestRateMapping(sheet: ParsedSheet): RateHeaderSuggestion[] {
  const claimed = new Set<string>();
  return sheet.headers.map((header, index) => {
    const candidate = ALIASES[headerKey(header)] ?? null;
    let suggested: string | null = null;
    if (candidate && !claimed.has(candidate)) {
      suggested = candidate;
      claimed.add(candidate);
    }
    return { header, index, suggested };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Building the rows
 * ──────────────────────────────────────────────────────────────────────── */

export type RateRowError = {
  /** 1-based worksheet row, so it matches what Excel shows. */
  sheetRow: number;
  header: string;
  key: string;
  raw: string;
};

/* ────────────────────────────────────────────────────────────────────────
 * Three cell states, not two  (residuals.md §6.6)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What one rate cell on the pricing sheet is saying.
 *
 * The sheet distinguishes THREE things and the calc table needs all three kept
 * apart, because two of them look alike and mean opposite things:
 *
 *   a number   the rate
 *   "$ -"      a RECORDED DECISION — we do not charge this. Stored 0.000000.
 *   blank      an ABSENCE — no arrangement recorded. Stored NULL, fails loud.
 *
 * Collapsing `"$ -"` into blank is what this type exists to prevent. Measured
 * on August 2026: 38 of the month's line failures were fees the sheet had
 * explicitly declined with `"$ -"` and the importer had stored as NULL, so the
 * engine refused a charge that had in fact been decided. The opposite error is
 * worse still — defaulting a blank to zero asserts a rate nobody set, and §6.7
 * is explicit that `monthly_fee_tapdash` in particular is never auto-zeroed.
 */
export type RateCellState = 'number' | 'declined' | 'absent' | 'unreadable';

export type RateCellRead = {
  state: RateCellState;
  /** Decimal text for the RPC, or null. `declined` carries '0'. */
  value: string | null;
  /** Only for `unreadable`, for the error the operator sees. */
  raw?: string;
};

/**
 * Every spelling of "we do not charge this" the sheet uses.
 *
 * `readNumeric` cannot be reused for this and is deliberately left alone: it
 * reads the FEE REPORT, where a bare dash means no value, and it strips the
 * currency symbol only AFTER its dash test — so `"$ -"` reaches the end as an
 * empty string and comes back `ok: false`. Two source documents, two
 * conventions; one shared reader would have to be wrong for one of them.
 */
const DECLINED = /^\$?\s*[-—]\s*\$?$/;

/** Reads one cell of the pricing sheet under the §6.6 three-state rule. */
export function readRateCell(cell: CellValue): RateCellRead {
  if (cell === null || cell === undefined) return { state: 'absent', value: null };
  if (typeof cell === 'boolean') return { state: 'unreadable', value: null, raw: String(cell) };

  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return { state: 'unreadable', value: null, raw: String(cell) };
    return { state: 'number', value: String(cell) };
  }

  const trimmed = cell.trim();
  if (trimmed === '') return { state: 'absent', value: null };

  /* Checked before any symbol stripping, so "$ -" is caught as written. */
  if (DECLINED.test(trimmed)) return { state: 'declined', value: '0' };

  const read = readNumeric(cell);
  if (!read.ok) return { state: 'unreadable', value: null, raw: read.raw };
  /* Non-empty, not a dash, yet numerically nothing — not a reading to keep. */
  if (read.value === null) return { state: 'unreadable', value: null, raw: trimmed };
  return { state: 'number', value: read.value };
}

/**
 * Per-column tally of the three states.
 *
 * §6.6 requires the wizard to show these "as a prominent preview panel — not a
 * footnote — and the operator confirms before commit", because the
 * `"$ -"` → 0 reading is inferential and load-bearing. The spec also records
 * the trap it is there to stop: counting a column as "populated" when a cell
 * is a number OR `"$ -"` overstates real coverage badly —
 * `vmd_transaction_fee` reads 20 of 33 populated and is 4 of 33 numbers.
 */
export type RateColumnStates = {
  key: string;
  header: string;
  numbers: number;
  declined: number;
  absent: number;
};

export type BuiltRateRows = {
  /** Exactly what the RPC destructures. Every value a string or null. */
  rows: Record<string, string | null>[];
  errors: RateRowError[];
  /** Rows with no MID — the sheet's own totals and spacers. */
  skippedNoMid: number;
  /** One entry per mapped numeric column, in mapping order. */
  columnStates: RateColumnStates[];
};

/**
 * Applies a confirmed mapping to the rates sheet.
 *
 * ── EVERY VALUE LEAVES AS TEXT ───────────────────────────────────────────
 * Including `risk_code`, which the RPC casts with `(v_elem->>'risk_code')::int`.
 * The rates are `numeric(14,6)` on the other side and a rate is multiplied by
 * a count, so a sixth-decimal error from a float round trip is real money on a
 * busy merchant.
 *
 * ── THE PERCENT-SCALE TRAP IS NOT CHECKED HERE ───────────────────────────
 * The RPC refuses any rate at or above 0.10, on a threshold derived from the
 * data: "real volume rates span [0.001, 0.047619] and the same values
 * percent-scaled span [0.1, 4.7619], two disjoint populations with a 2.10x
 * gap". Re-implementing that here would be a second copy of a measured rule,
 * and the preview runs the real commit, so an operator sees the real refusal
 * before anything is written.
 */
export function buildRateRows(
  sheet: ParsedSheet,
  mapping: ReadonlyMap<number, string>,
): BuiltRateRows {
  const errors: RateRowError[] = [];
  const rows: Record<string, string | null>[] = [];
  let skippedNoMid = 0;

  /* Counted only over rows that survive the MID check, so the sheet's own
     footer cannot inflate the "absent" tally the operator is confirming. */
  const states = new Map<string, RateColumnStates>();

  sheet.rows.forEach((cells, i) => {
    const sheetRow = sheet.rowNumbers[i] ?? sheet.headerRow + 1 + i;
    const row: Record<string, string | null> = {};
    for (const k of RATE_IMPORT_KEYS) row[k] = null;

    /* Held until the MID check passes — see `states`. */
    const seen: { key: string; header: string; state: RateCellState }[] = [];

    for (const [index, key] of mapping) {
      const cell: CellValue = cells[index] ?? null;
      const field = RATE_IMPORT_FIELD[key];
      if (!field) continue;

      if (field.kind === 'text') {
        row[key] = readText(cell);
        continue;
      }

      if (field.kind === 'int') {
        const read = readNumeric(cell);
        if (!read.ok) {
          errors.push({ sheetRow, header: sheet.headers[index] ?? `column ${index + 1}`, key, raw: read.raw });
        } else if (read.value === null) {
          row[key] = null;
        } else if (!/^-?\d+$/.test(read.value)) {
          /* A risk code is 1, 2 or 3. "1.0" would cast, but a decimal here
             means the column is not what the operator thinks it is. */
          errors.push({
            sheetRow,
            header: sheet.headers[index] ?? `column ${index + 1}`,
            key,
            raw: read.value,
          });
        } else {
          row[key] = read.value;
        }
        continue;
      }

      /*
       * A rate column, where the three states of §6.6 apply. `"$ -"` becomes
       * '0' — the sheet declining the fee — and only a truly empty cell
       * becomes NULL.
       */
      const header = sheet.headers[index] ?? `column ${index + 1}`;
      const read = readRateCell(cell);
      if (read.state === 'unreadable') {
        errors.push({ sheetRow, header, key, raw: read.raw ?? '' });
        continue;
      }
      row[key] = read.value;
      seen.push({ key, header, state: read.state });
    }

    /*
     * The RPC normalises the MID to digits and would reject a blank one as an
     * error rather than skipping it, so the sheet's own total and spacer rows
     * are dropped here — otherwise a perfectly good file is refused for
     * containing a footer.
     */
    const digits = (row.mid ?? '').replace(/[^0-9]/g, '');
    if (digits === '') {
      skippedNoMid += 1;
      return;
    }
    row.mid = digits;

    for (const { key, header, state } of seen) {
      let tally = states.get(key);
      if (!tally) {
        tally = { key, header, numbers: 0, declined: 0, absent: 0 };
        states.set(key, tally);
      }
      if (state === 'number') tally.numbers += 1;
      else if (state === 'declined') tally.declined += 1;
      else tally.absent += 1;
    }

    rows.push(row);
  });

  return { rows, errors, skippedNoMid, columnStates: [...states.values()] };
}

/* ────────────────────────────────────────────────────────────────────────
 * The RPCs' results
 * ──────────────────────────────────────────────────────────────────────── */

/** A standing version the import would close that a computed month depends on. */
export type LockedVersion = {
  mid: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type RateImportResult = {
  effectiveFrom: string;
  rowsRead: number;
  inserted: number;
  /** Rows whose rates already match — no successor opened. */
  unchanged: number;
  /** Standing versions closed so a successor could open. */
  closed: number;
  /**
   * Locked versions this import would close. Legal, and consequential.
   *
   * The RPC's own words: "Closing a locked version is LEGAL — that is how a
   * used merchant is repriced... It is surfaced because it is consequential,
   * not because it is forbidden: superseding a version that a signed-off month
   * depends on changes what future recomputes of LATER months will read."
   *
   * Computed on committed state before the dry run, so it reports what the
   * operator would be doing rather than what the discarded subtransaction did.
   */
  lockedVersions: LockedVersion[];
  /** True for a preview. */
  dryRun: boolean;
};

/**
 * Splits the RPC's bounded rejection into its parts.
 *
 * ── THE SEPARATOR IS PART OF THE CONTRACT ────────────────────────────────
 * Not incidental formatting. The RPC says so:
 *
 *   "Summary first, then at most c_max_shown problems joined with ' | '. The
 *    client splits on that separator to render them in a scrollable list, so
 *    the shape is part of the contract, not incidental formatting."
 *
 * So this function exists to honour that rather than printing one long line,
 * and it degrades to a single item for any message that does not carry the
 * separator — a different error reaching here renders as itself.
 */
export function splitRejection(message: string): { summary: string; problems: string[] } {
  const colon = message.indexOf('): ');
  if (colon === -1) return { summary: message, problems: [] };

  const summary = message.slice(0, colon + 1);
  const rest = message.slice(colon + 3);
  const problems = rest
    .split(' | ')
    .map((p) => p.trim())
    .filter((p) => p !== '');

  return { summary, problems };
}
