/**
 * Source header -> `residual_lines` column.
 *
 * ── THE VOCABULARY IS CLOSED, AND IT IS CLOSED IN THE DATABASE ───────────
 * `TARGETS` below is the same fourteen names as the CHECK constraint on
 * `residual_column_mappings.target_column` and the same fourteen as the
 * `jsonb_to_recordset` type list inside `commit_residual_excel_import`. Three
 * copies, which is one more than ideal, and the reason the list carries this
 * comment: the DB copy is the authority. A target added here and not there is
 * a 23514 at config time, which is the failure we want. A target added there
 * and not here simply cannot be selected.
 *
 * `period_id` is deliberately not a target — the statement month is a decision
 * the operator makes once for the file, never a cell-by-cell mapping. Nor are
 * the engine's own outputs (total_income, total_buy_rate,
 * tapdash_net_after_split, additional_income_direct, net_income): letting a
 * vendor spreadsheet write those would put the file in charge of our
 * arithmetic.
 *
 * ── SUGGESTION IS A DEFAULT, NEVER AN ACTION ─────────────────────────────
 * `suggestMapping` proposes; the operator confirms. Nothing is ever imported
 * on the strength of a suggestion alone, because the cost of a wrong guess
 * here is a money column reading from the wrong source column, which looks
 * like a plausible number.
 */
import { readNumeric, readText, type CellValue, type ParsedSheet } from './xlsxParser';

export const TARGETS = [
  'mid',
  'merchant_name',
  'fee_category',
  'fee_item_name',
  'item_count',
  'amount',
  'buy_rate_per_item',
  'agent_income',
  'agent_expense',
  'net_revenue',
  'root_agent',
  'agent_owner',
  'agent',
  'branch',
] as const;

export type Target = (typeof TARGETS)[number];

/** Which targets are `numeric` in `residual_lines`, and so go through `readNumeric`. */
export const NUMERIC_TARGETS: ReadonlySet<Target> = new Set<Target>([
  'item_count',
  'amount',
  'buy_rate_per_item',
  'agent_income',
  'agent_expense',
  'net_revenue',
]);

/**
 * What each target is, in the operator's words.
 *
 * `mid` and `fee_item_name` are called out as required because the import is
 * useless without them and the reason is not obvious: `mid` is what every
 * other table keys on, and `fee_item_name` is what the engine matches a
 * calculation rule by. A file mapped without either imports rows the engine
 * will then skip.
 */
export const TARGET_LABEL: Record<Target, { label: string; hint: string }> = {
  mid: { label: 'MID', hint: 'Required. The statement merchant number — what every other table keys on.' },
  merchant_name: { label: 'Merchant name', hint: 'Carried verbatim. Not matched on.' },
  fee_category: { label: 'Fee category', hint: 'The report’s own grouping, e.g. “Authorization Trxns”.' },
  fee_item_name: {
    label: 'Fee item',
    hint: 'Required. Matched exactly against the calculation rules — a name with no rule is reported, not computed.',
  },
  item_count: { label: 'Item count', hint: 'How many. Multiplied by the merchant’s rate.' },
  amount: { label: 'Amount', hint: 'The report’s own amount for the line.' },
  buy_rate_per_item: {
    label: 'Buy rate per item',
    hint: 'Rounded to 2dp in the report — attribution only. The engine costs from the template schedule.',
  },
  agent_income: { label: 'Agent income', hint: 'What the report credited. Reconciled against, never calculated from.' },
  agent_expense: { label: 'Agent expense', hint: 'What the report charged.' },
  net_revenue: {
    label: 'Net revenue',
    hint: 'The report’s net. The engine reconciles its own pre-split net against this.',
  },
  root_agent: { label: 'Root agent', hint: 'Attribution only. Never a calculation input.' },
  agent_owner: { label: 'Agent owner', hint: 'Attribution only.' },
  agent: { label: 'Agent', hint: 'Attribution only.' },
  branch: { label: 'Branch', hint: 'Attribution only.' },
};

/** Without these two a row imports but cannot be computed. */
export const REQUIRED_TARGETS: readonly Target[] = ['mid', 'fee_item_name'];

/**
 * Targets whose source column on a fee report cannot be trusted as a value.
 *
 * Not forbidden — warned about. `buy_rate_per_item` is attribution, not a
 * calculation input: the engine takes the buy side from the processor's
 * template schedule at the merchant's tier, so a wrong figure here changes no
 * arithmetic. What it does is mislead a human comparing the two, which is
 * exactly what happened three times before this was written down.
 */
export const POISONED_TARGETS: Readonly<Record<string, string>> = {
  buy_rate_per_item:
    'The report’s Buy Rate Per Item column is rounded to 2dp for display — it shows 0.03 where the real rate is 0.025. Import it if you want the stated figure on the row, but do not read it as the rate: the true one is Agent Expense ÷ Count, and the engine uses the template schedule regardless.',
};

/**
 * A header reduced to something comparable.
 *
 * Used ONLY to suggest. Never stored, never used to look a saved mapping up —
 * see the note on verbatim headers in `xlsxParser.ts`.
 */
export function headerKey(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Known header spellings, keyed by `headerKey`.
 *
 * Seeded from the Sample Fee Item Report's own column names. A processor that
 * spells a column differently is handled by the operator mapping it once and
 * saving the template — that is what `residual_column_mappings` is for, and it
 * is why this table can stay short rather than trying to anticipate every
 * vendor.
 */
const ALIASES: Record<string, Target> = {
  mid: 'mid',
  'merchant number': 'mid',
  'merchant id': 'mid',
  'merchant nbr': 'mid',
  'merchant name': 'merchant_name',
  dba: 'merchant_name',
  'dba name': 'merchant_name',
  'fee category': 'fee_category',
  category: 'fee_category',
  'fee item': 'fee_item_name',
  'fee item name': 'fee_item_name',
  'item name': 'fee_item_name',
  description: 'fee_item_name',
  'item count': 'item_count',
  count: 'item_count',
  items: 'item_count',
  quantity: 'item_count',
  qty: 'item_count',
  amount: 'amount',
  'fee amount': 'amount',
  /*
   * ── `buy_rate_per_item` IS DELIBERATELY NOT ALIASED ───────────────────
   * The fee report's "Buy Rate Per Item" column is DISPLAY-ROUNDED to two
   * decimal places, and the handoff records that it "has produced three wrong
   * conclusions":
   *
   *   you read 0.03 in the report, compare it to a template 0.025, and record
   *   a variance that does not exist
   *
   * Every medium-tier merchant shows 0.03 and holds 0.025. The true rate is
   * `Agent Expense / Count`, and the module's standing rule is that "no
   * displayed number is a value — derive it".
   *
   * So nothing here proposes that column. It stays SELECTABLE, because an
   * operator who knows what they are doing may want the stated figure on the
   * row for reference, and `buy_rate_per_item` is not a calculation input —
   * the engine derives the buy side from the template schedule, never from
   * this column. But it is never suggested, and `POISONED_TARGETS` below makes
   * the screen say why if someone picks it.
   */
  'agent income': 'agent_income',
  income: 'agent_income',
  'agent expense': 'agent_expense',
  expense: 'agent_expense',
  'net revenue': 'net_revenue',
  net: 'net_revenue',
  'net income': 'net_revenue',
  'root agent': 'root_agent',
  'agent owner': 'agent_owner',
  agent: 'agent',
  branch: 'branch',
  office: 'branch',
};

export type HeaderSuggestion = {
  /** Verbatim, as the workbook holds it. The join key. */
  header: string;
  /** Column index in the sheet. */
  index: number;
  /** What a saved mapping says, if there is one. */
  saved: Target | null;
  /** What the alias table proposes, if anything. */
  suggested: Target | null;
};

/**
 * One suggestion per column.
 *
 * A saved mapping always wins over an alias, because it is a decision someone
 * already made about this processor's file. Two columns resolving to the same
 * target is possible here and is rejected by the caller — the DB's partial
 * unique index on (processor, target_column) would reject it too, but a
 * message about an index is not an explanation.
 */
export function suggestMapping(
  sheet: ParsedSheet,
  saved: ReadonlyMap<string, Target>,
): HeaderSuggestion[] {
  const claimed = new Set<Target>(saved.values());

  return sheet.headers.map((header, index) => {
    const savedTarget = saved.get(header) ?? null;
    let suggested: Target | null = null;

    if (!savedTarget) {
      const candidate = ALIASES[headerKey(header)] ?? null;
      /* Do not propose a target another column already holds; the operator
         resolves the collision rather than being handed one. */
      if (candidate && !claimed.has(candidate)) {
        suggested = candidate;
        claimed.add(candidate);
      }
    }

    return { header, index, saved: savedTarget, suggested };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Building the rows the RPC takes
 * ──────────────────────────────────────────────────────────────────────── */

/** One unreadable cell, named well enough to find in the file. */
export type RowError = {
  /** 1-based worksheet row, so it matches what Excel shows. */
  sheetRow: number;
  header: string;
  target: Target;
  raw: string;
};

export type BuiltRows = {
  /** Exactly the shape `commit_residual_excel_import` destructures. */
  rows: Record<string, string | null>[];
  errors: RowError[];
  /** Rows dropped for having no MID — the RPC would drop them anyway. */
  skippedNoMid: number;
};

/**
 * Applies a confirmed mapping to a parsed sheet.
 *
 * ── EVERY VALUE LEAVES AS A STRING OR NULL ───────────────────────────────
 * Including the numerics, which leave as decimal TEXT. `jsonb_to_recordset`
 * casts text to `numeric` happily and exactly; what it must never be handed is
 * a JSON number, because that number has already been a float. See
 * `readNumeric`.
 *
 * ── A ROW WITH AN UNREADABLE CELL IS STILL BUILT ─────────────────────────
 * The error is collected and the cell left null, so the operator sees ALL the
 * problems in one pass rather than one per attempt. The caller refuses to
 * commit while `errors` is non-empty — the import is all or nothing, so a
 * partial build is only ever a diagnostic.
 */
export function buildRows(
  sheet: ParsedSheet,
  mapping: ReadonlyMap<number, Target>,
): BuiltRows {
  const errors: RowError[] = [];
  const rows: Record<string, string | null>[] = [];
  let skippedNoMid = 0;

  sheet.rows.forEach((cells, i) => {
    /* The real worksheet row, recorded by the parser. Not derived from `i`:
       blank rows are dropped, so an index-derived number drifts. */
    const sheetRow = sheet.rowNumbers[i] ?? sheet.headerRow + 1 + i;
    const row: Record<string, string | null> = {};
    for (const t of TARGETS) row[t] = null;

    for (const [index, target] of mapping) {
      const cell: CellValue = cells[index] ?? null;

      if (NUMERIC_TARGETS.has(target)) {
        const read = readNumeric(cell);
        if (read.ok) row[target] = read.value;
        else {
          errors.push({ sheetRow, header: sheet.headers[index] ?? `column ${index + 1}`, target, raw: read.raw });
        }
      } else {
        row[target] = readText(cell);
      }
    }

    /*
     * The RPC's own `where r.mid is not null and btrim(r.mid) <> ''` would
     * drop these silently. Dropping them here instead means the count the
     * operator is shown before committing is the count that gets committed.
     */
    if (row.mid === null || row.mid === '') {
      skippedNoMid += 1;
      return;
    }

    rows.push(row);
  });

  return { rows, errors, skippedNoMid };
}

/* ────────────────────────────────────────────────────────────────────────
 * The statement month
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Months found in the sheet's date-looking columns.
 *
 * ── WHY THIS IS A CROSS-CHECK AND NOT THE ANSWER ─────────────────────────
 * The operator states the month; this only says what the file appears to
 * contain. `period_id` is not a mappable target, so there is no column the
 * module is entitled to treat as authoritative — reading one anyway would be
 * exactly the kind of guess that puts May's figures in June and looks right.
 *
 * What it is worth: one consistent month that disagrees with the operator's
 * choice is a warning worth showing, because importing the wrong month is
 * both easy and invisible afterwards.
 */
export function detectMonths(sheet: ParsedSheet): string[] {
  const months = new Set<string>();

  sheet.headers.forEach((header, index) => {
    if (!/date|month|period/i.test(header)) return;
    for (const cells of sheet.rows) {
      const v = cells[index];
      if (typeof v !== 'string') continue;
      /* normaliseCell already turned a date cell into YYYY-MM-DD. */
      const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(v.trim());
      if (m) months.add(`${m[1]}-${m[2]}-01`);
    }
  });

  return [...months].sort();
}
