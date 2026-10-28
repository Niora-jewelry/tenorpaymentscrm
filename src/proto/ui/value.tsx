'use client';

/**
 * PROTOTYPE — the field type registry.
 *
 * One place that knows how each field type renders in a table cell and in the
 * drawer. Every other component asks this file; none of them switch on a type
 * themselves. That is what makes "add a field type" a change in one file
 * rather than a change everywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { MenuSurface } from './MenuSurface';
import type { Field, FieldType, FieldValue, GridRow, PercentSplit, AddressValue } from '../schema';
import { choicesFor, choiceKey, choiceLabel } from '../fields';
import { formatCurrency, formatDate, formatDateTime, MONTH_NAMES, MONTHS_NONE, toggleMonth } from './tokens';
import { StatusPill, OutlineChip, AvatarStack, Button, IconButton, NumberInput } from './kit';
import { PersonAvatar, resolvePerson, usePeople, usePeopleById } from './people';
import { useFieldLinks, formatPhone, websiteHref, isValidEmail } from './fieldLinks';
import { Icon } from './icons';

/* -------------------------------------------------------------------------- */
/* Value shape helpers                                                         */
/* -------------------------------------------------------------------------- */

export function isNumeric(type: Field['type']): boolean {
  return type === 'currency' || type === 'number' || type === 'percentage';
}

/** Field types with a real picker control (nothing to type, only something to
 * pick) — shown live when empty instead of a click-to-reveal placeholder.
 *
 * Not `date` and not `dropdown` any more (UI spec §4). A date shows one display
 * format whether filled or not and opens its picker on click — an empty date
 * showing a bare mm/dd/yyyy box beside a filled one reading "13 Jun 2025" was
 * the "two date styles" the spec calls out. A dropdown is ALWAYS the same
 * select control, empty or filled, rather than a grey chip once it has a value
 * — the "two dropdown styles". */
const LIVE_PICKER_TYPES = new Set<FieldType>(['checkbox']);

export function isEmpty(v: FieldValue): boolean {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** A must-total-100% value, or null if this record has none yet. */
export function asSplit(v: FieldValue): PercentSplit | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as PercentSplit;
  return null;
}

/**
 * A team-member field's ids, or an empty list.
 *
 * Tolerant on READ and strict on WRITE, on purpose. The value is an array of
 * user ids in the database and the trigger that maintains `record_team_members`
 * refuses anything else (migration 40) — but this field had a plain text editor
 * before that migration, so a record could hold a bare string. Rendering that as
 * an empty team is honest; crashing the whole drawer on it is not.
 */
export function asTeamMembers(v: FieldValue): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * A multi-select / months value as a list of choice keys.
 *
 * ⚠️ Both renderers below used to cast straight to `string[]` and call
 * `.slice`/`.map` on it. A scalar sitting in one of these fields therefore
 * crashed the render with "…is not a function" — and the bulk-edit dialog
 * wrote exactly that, because its choice picker stores ONE key and `months`
 * has no `field_choices` rows at all so it fell through to a free-text box.
 * The crash landed in the records table, which has no boundary above it, and
 * the bad value was already persisted: every later visit to that module
 * crashed again, unrecoverable from the UI.
 *
 * The dialog no longer writes a scalar, but the renderer must not depend on
 * that — this data is years old in places and is edited by more than one
 * screen. A lone string is read as a single selection, which is what it
 * plainly means, rather than being dropped.
 */
export function asChoiceArray(v: FieldValue): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** A stable identity for an address, for change detection. `AddressValue` is
 * five known strings, so joining them is exact — there is no nesting to miss
 * and no key order to depend on. */
function addressKey(a: AddressValue): string {
  return `${a.street}\u0000${a.street2}\u0000${a.city}\u0000${a.state}\u0000${a.zip}\u0000${a.country}`;
}

/*
 * The separator above is written `\u0000`, NOT a raw NUL byte.
 *
 * It used to be raw, and that made Git classify this entire file as
 * BINARY. The consequence shows up in the log: the drawer header-strip
 * commit records this file as "Bin 60792 -> 62311 bytes, 0 insertions,
 * 0 deletions" — a 1.5KB change to the most important rendering file in
 * the CRM, with no reviewable diff, no line blame and nothing for bisect
 * to point at.
 *
 * The escape is the identical character at runtime. Only the tooling
 * changes its mind.
 */
/** Grid rows, or an empty list. */
export function asGrid(v: FieldValue): GridRow[] {
  if (Array.isArray(v) && v.every((r) => r !== null && typeof r === 'object')) {
    return v as GridRow[];
  }
  return [];
}

/** Tolerates a legacy freeform string (the field's old single-textarea shape,
 * pre-restructure) by treating it as the street line, so no old data is
 * silently dropped when this field type's control changes underneath it. */
export function asAddress(v: FieldValue): AddressValue {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return {
      street: typeof o.street === 'string' ? o.street : '',
      street2: typeof o.street2 === 'string' ? o.street2 : '',
      city: typeof o.city === 'string' ? o.city : '',
      state: typeof o.state === 'string' ? o.state : '',
      zip: typeof o.zip === 'string' ? o.zip : '',
      country: typeof o.country === 'string' ? o.country : '',
    };
  }
  if (typeof v === 'string' && v) return { street: v, street2: '', city: '', state: '', zip: '', country: '' };
  return { street: '', street2: '', city: '', state: '', zip: '', country: '' };
}

/** USPS state/territory codes — a fixed, small, always-correct list; no
 * dataset or dependency needed for this part of the address. */
export const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
  { code: 'AS', name: 'American Samoa' }, { code: 'GU', name: 'Guam' },
  { code: 'MP', name: 'Northern Mariana Islands' }, { code: 'PR', name: 'Puerto Rico' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
];

/** 5-digit or ZIP+4. */
const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

/** "123 Main St, Austin, TX 73301" — country omitted (implicit, USA-only for
 * now, would just repeat on every row) unless it's the only part filled in. */
export function formatAddress(a: AddressValue): string {
  const cityStateZip = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const line = [a.street, a.street2, cityStateZip].filter(Boolean).join(', ');
  return line || a.country || '';
}

/** "Austin, TX" — how an address reads in ONE list column (UI spec §6). */
export function addressCityState(a: AddressValue): string {
  return [a.city, a.state].filter(Boolean).join(', ');
}

/** The largest part of a must-total-100% value — how it reads in one list
 *  column (UI spec §6: "the largest part, e.g. Business 100%"). */
export function splitLargest(
  split: PercentSplit,
  options: import('../schema').Choice[] = [],
): { label: string; pct: number } | null {
  let best: [string, number] | null = null;
  for (const [k, v] of Object.entries(split)) {
    const n = Number(v) || 0;
    if (n > 0 && (!best || n > best[1])) best = [k, n];
  }
  return best ? { label: choiceLabel(options, best[0]), pct: best[1] } : null;
}

function splitTotal(split: PercentSplit): number {
  return Object.values(split).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** "Business 60% · Gov 15% · Individual 25%" — the split is keyed by choice
 * key, so the options are needed to turn `business` back into "Business". */
export function splitSummary(split: PercentSplit, options: import('../schema').Choice[] = []): string {
  return Object.entries(split)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${choiceLabel(options, k)} ${v}%`)
    .join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Table cell                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One value in the record drawer's header strip.
 *
 * A thin shell over `CellValue`, overriding only where a TABLE CELL's rendering
 * is wrong in a header. Everything else delegates, so adding a field type stays
 * a change in one place.
 *
 * ⚠️ `sensitive` IS THE REASON THIS EXISTS. `CellValue` has no sensitive branch
 * at all — masking lives only in `FieldRenderer`. The admin header-field picker
 * happily offers EIN, account number and routing number, so putting one in the
 * strip printed it in clear three inches above the same field sitting behind a
 * Reveal button. It is masked here, with no reveal: the header is a summary,
 * and the drawer's own field is where an audited reveal belongs.
 */
export function HeaderValue({
  field,
  value,
  moduleSlug,
}: {
  field: Field;
  value: FieldValue;
  moduleSlug?: string;
}) {
  if (field.sensitive && value != null && value !== '') {
    return (
      <span className="font-mono text-[13px] tabular text-ink-500" title="Hidden — open the field below to reveal it">
        {'•'.repeat(8)}
      </span>
    );
  }

  // `CellValue` renders `false` as an em-dash, which in a header is
  // indistinguishable from "no value" — and for a checkbox the absence of a
  // tick IS the answer.
  if (field.type === 'checkbox') {
    return <span className="text-[13.5px] font-medium">{value ? 'Yes' : 'No'}</span>;
  }

  return <CellValue field={field} value={value} moduleSlug={moduleSlug} />;
}

export function CellValue({
  field,
  value,
  moduleSlug,
}: {
  field: Field;
  value: FieldValue;
  /** Only matters for fields whose choices differ per module. */
  moduleSlug?: string;
}) {
  if (isEmpty(value)) return <span className="text-ink-400/70">—</span>;

  if (field.type === 'auto') return <AutoValue field={field} value={value} />;

  switch (field.type) {
    // A record stores a choice's KEY, so both of these resolve key → label
    // rather than printing the stored value. Print it raw only when nothing
    // resolves — see `choiceLabel`.
    case 'status': {
      const options = choicesFor(field, moduleSlug ?? '');
      const choice = options.find((c) => choiceKey(c) === String(value));
      return <StatusPill label={choiceLabel(options, value)} swatch={choice?.swatch} />;
    }
    case 'team_member':
      return <AvatarStack ids={value as string[]} />;
    case 'currency':
      return <span className="tabular">{formatCurrency(Number(value))}</span>;
    case 'percentage':
      return <span className="tabular">{Number(value).toFixed(2)}%</span>;
    case 'number':
      return <span className="tabular">{String(value)}</span>;
    // A digit string, never a quantity — no thousands separators, and the
    // leading zero that a numeric column would have eaten is still here.
    case 'identifier':
      return <span className="font-mono text-[12.5px] tabular">{String(value)}</span>;
    case 'date':
      return <span className="tabular">{formatDate(String(value))}</span>;
    case 'datetime':
      return <span className="tabular">{formatDateTime(String(value))}</span>;
    case 'checkbox':
      return value ? (
        <Icon name="check" size={14} strokeWidth={2.5} className="text-[#0b7466]" />
      ) : (
        <span className="text-ink-400/70">—</span>
      );
    case 'email':
      return <span className="text-brand-700">{String(value)}</span>;
    case 'url':
      return (
        <span className="text-brand-700">{String(value).replace(/^https?:\/\/(www\.)?/, '')}</span>
      );
    // `months` stores month names, which are their own identity — there are no
    // `field_choices` rows behind it, so `choiceLabel` on an empty option list
    // correctly returns the stored name unchanged.
    case 'multi_select':
    case 'months': {
      const options = choicesFor(field, moduleSlug ?? '');
      const picked = asChoiceArray(value);
      return (
        <span className="flex flex-wrap gap-1">
          {picked.slice(0, 3).map((v) => (
            <OutlineChip key={v}>{choiceLabel(options, v)}</OutlineChip>
          ))}
          {picked.length > 3 ? (
            <span className="text-[12px] text-ink-400">+{picked.length - 3}</span>
          ) : null}
        </span>
      );
    }
    /* One Dropdown style everywhere (UI spec §4): the chosen option as text.
       Status is the type that is a coloured pill. */
    case 'dropdown':
      return <span className="truncate">{choiceLabel(choicesFor(field, moduleSlug ?? ''), value)}</span>;
    case 'phone':
      return <span className="tabular">{formatPhone(String(value))}</span>;
    /* A full-row type squeezed into one column (UI spec §6): "City, State",
       with the whole address on hover. */
    case 'address': {
      const a = asAddress(value);
      return <span className="truncate" title={formatAddress(a)}>{addressCityState(a) || formatAddress(a)}</span>;
    }
    /* …and the largest part, with the full breakdown on hover. */
    case 'percent_split': {
      const split = asSplit(value);
      const top = split ? splitLargest(split, field.choices ?? []) : null;
      if (!split || !top) return <span className="text-ink-400/70">—</span>;
      return (
        <span className="tabular text-[12.5px]" title={splitSummary(split, field.choices ?? [])}>
          {top.label} {top.pct}%
        </span>
      );
    }
    case 'grid': {
      const rows = asGrid(value);
      return (
        <span className="text-[12.5px] text-ink-500 tabular">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </span>
      );
    }
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}

/* -------------------------------------------------------------------------- */
/* Sensitive values — masked until revealed                                    */
/* -------------------------------------------------------------------------- */

function Masked({ value, label }: { value: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-[13px] tabular">
        {shown ? value : '•'.repeat(Math.min(value.length, 11))}
      </span>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-700 transition-colors hover:text-brand-800"
      >
        <Icon name={shown ? 'eye-off' : 'eye'} size={12} />
        {shown ? 'Hide' : 'Reveal'}
      </button>
      {shown ? (
        <span className="text-[11.5px] text-ink-400">{label} — this reveal is audit-logged</span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer field — view and edit                                                */
/* -------------------------------------------------------------------------- */

export function FieldRenderer({
  field,
  value,
  grant,
  moduleSlug,
  grantsVisibility,
  viewerId,
  viewerIsAdmin,
  autoEdit,
  compact,
  card,
  onCancel,
  onChange,
}: {
  field: Field;
  value: FieldValue;
  grant: 'view' | 'edit';
  /** Needed only because some fields carry different choices per module. */
  moduleSlug?: string;
  /**
   * `team_member` only: does THIS field decide who can see the record?
   *
   * Three fields carry that type and exactly one of them does — the caller
   * compares against `VISIBILITY_FIELD_KEY`. Saying "only these people can see
   * this record" on `relationship_manager`, which is informational and grants
   * nothing, would be the more dangerous half of a wrong answer.
   */
  grantsVisibility?: boolean;
  /**
   * Who is looking, when that is known. Read by exactly one control:
   * `team_member`, where taking YOURSELF off the list is the one edit in the
   * whole drawer that can remove the record from your own view — when the field
   * is the one that grants visibility. Optional because the prototype's own
   * surfaces have no signed-in user.
   */
  viewerId?: string;
  /** An admin sees every record regardless of the team, so the warning above
   * does not apply to them and is not shown. */
  viewerIsAdmin?: boolean;
  /** `team_member` only — see the prop of the same name on its control. Set
   *  by a dashboard cell, which cannot give the control room to wrap. */
  compact?: boolean;
  /**
   * Rendered inside a fixed-height field card (the drawer's 4-column grid and
   * Vital Info, UI spec §3). Every standard field takes exactly one column
   * and every box in a row is the same height, so a team list shows as one
   * line — avatars and names — and opens its checklist on click, instead of
   * wrapping chips onto as many rows as there are people.
   */
  card?: boolean;
  /**
   * Open straight into the editor, already focused.
   *
   * For a caller that has ALREADY expressed the intent to edit — the dashboard
   * table's pencil, where the click that got you here was itself the "edit
   * this" gesture. Without it the renderer opens in read mode and the user has
   * to click the value a second time, which is the same click they just made.
   *
   * The drawer leaves this off: there, the field grid is the resting state of
   * the record and every cell opening as an input would be fifty focus targets
   * competing for one caret.
   */
  autoEdit?: boolean;
  /** Told when the editor closes without committing — Escape, or a blur that
   *  changed nothing. Lets an owning cell drop back to its display state. */
  onCancel?: () => void;
  onChange: (v: FieldValue) => void;
}) {
  // "This is different statuses per module" — resolved here, once.
  const options = choicesFor(field, moduleSlug ?? '');

  /** The stored key, when this module's list does not contain it. See the long
   *  note on the `<select>` below for why it has to stay visible. */
  const orphanOption =
    (field.type === 'status' || field.type === 'dropdown')
    && value != null
    && String(value) !== ''
    && !options.some((c) => choiceKey(c) === String(value))
      ? String(value)
      : null;
  const [editing, setEditing] = useState(Boolean(autoEdit));
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);

  /*
   * ── TAB SHOULD LAND YOU IN A FIELD READY TO TYPE ──────────────────────
   * The closed cell is a <button>, so Tab has always been able to reach it —
   * but it only opened on CLICK. Tabbing to a field and typing did nothing,
   * and the field had to be clicked after being tabbed to, which defeats
   * tabbing through a form at all. On a tab of thirty mostly-empty fields
   * that is the difference between typing and clicking thirty times.
   *
   * So focus opens it, which is what the existing `editing` effect was
   * already built for: it focuses the input and selects its contents.
   */
  const displayRef = useRef<HTMLButtonElement>(null);
  /*
   * Closing the editor returns focus to this button, which would re-open it
   * instantly and trap the keyboard in one cell. The flag is set by whichever
   * close ran and consumed by the focus it causes, so a LATER deliberate
   * focus still opens the field.
   */
  const skipNextFocus = useRef(false);

  const closeAndRestoreFocus = () => {
    skipNextFocus.current = true;
    /* After the editor unmounts, not before — otherwise the input steals it
       straight back. */
    requestAnimationFrame(() => displayRef.current?.focus());
  };

  const openOnFocus = () => {
    if (readOnly) return;
    if (skipNextFocus.current) {
      skipNextFocus.current = false;
      return;
    }
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    // A date opens straight into its picker: clicking "13 Jun 2025" (or "Add
    // date") is the request for a calendar, not for a box to type digits
    // into. `showPicker` needs a user gesture and throws without one — a
    // focus that arrived by Tab — in which case the input is simply focused.
    if (el instanceof HTMLInputElement && el.type === 'date') {
      try {
        el.showPicker?.();
      } catch {
        /* keyboard focus: the input is open and focused, which is enough */
      }
      return;
    }
    // Select what is already there, so typing REPLACES the old value rather
    // than appending to it. A cell opened to change "Restaurant" to "Retail"
    // should not need the old word deleted first.
    if (el && 'select' in el && typeof el.select === 'function') el.select();
  }, [editing]);

  const commit = (v: FieldValue) => {
    onChange(v);
    setEditing(false);
    closeAndRestoreFocus();
    setSaved(true);
    setTimeout(() => setSaved(false), 720);
  };

  const cancel = () => {
    setEditing(false);
    closeAndRestoreFocus();
    onCancel?.();
  };

  /**
   * Enter commits, Escape abandons — for the single-line controls only.
   *
   * Not applied to `long_text`, where Enter is a newline and taking it away
   * would make a multi-line field impossible to use. That one commits on blur,
   * as it always has.
   */
  const keyCommit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const readOnly = grant !== 'edit';

  /*
   * These two types are always live rather than click-to-edit: both are
   * multi-part controls where a read-only summary followed by an edit click
   * would just be an extra step before every change.
   */
  /* Auto-populated (locked): the database fills it and nobody edits it, admin
     included — so there is no edit state at all, whatever the grant. */
  if (field.type === 'auto') {
    return (
      <div className="flex min-h-[30px] items-center px-1 py-1 text-[13.5px] text-ink-700">
        {isEmpty(value) ? <span className="text-ink-400/70">—</span> : <AutoValue field={field} value={value} />}
      </div>
    );
  }

  if (field.type === 'percent_split') {
    return <PercentSplitControl field={field} value={asSplit(value)} readOnly={readOnly} onChange={onChange} />;
  }
  if (field.type === 'grid') {
    return <GridControl field={field} rows={asGrid(value)} readOnly={readOnly} onChange={onChange} />;
  }
  // Address is structured (street/city/state/zip/country), not one freeform
  // string — a read-only summary followed by an edit click to reach FIVE
  // separate inputs would be worse than just showing them, same reasoning as
  // percent_split/grid above.
  if (field.type === 'address') {
    return <AddressControl value={asAddress(value)} readOnly={readOnly} onChange={onChange} />;
  }
  // Same reasoning again, and one more: this field decides who can SEE the
  // record. A click-to-edit summary that has to be clicked before it will even
  // tell you there is an "add" control is the wrong shape for the one control
  // where not noticing something is a permission mistake.
  if (field.type === 'team_member') {
    return (
      <TeamMemberControl
        ids={asTeamMembers(value)}
        readOnly={readOnly}
        compact={compact || card}
        showNames={card}
        // Three fields share this type and only one of them grants anything —
        // see `grantsVisibility` on the control. The caller decides, because
        // this component is also the prototype's, which has no such concept.
        grantsVisibility={grantsVisibility}
        viewerId={viewerId}
        viewerIsAdmin={viewerIsAdmin}
        onChange={onChange}
      />
    );
  }

  /* One Dropdown style, empty or filled (UI spec §4). Always the live select,
     controlled, so a refused save that rolls the value back also rolls the
     control back — a `defaultValue` select would keep showing the pick the
     database did not accept. */
  /* An EMPTY status offers the same select, so the two pickers look alike
     until a status is set — then it is the coloured pill the spec asks for. */
  if (!readOnly && (field.type === 'dropdown' || (field.type === 'status' && isEmpty(value) && !editing))) {
    return (
      <DropdownSelect
        label={field.label}
        value={value == null ? '' : String(value)}
        options={options}
        orphan={orphanOption}
        required={Boolean(field.required)}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (field.type === 'long_text') {
    return (
      <LongTextControl
        label={field.label}
        value={value == null ? '' : String(value)}
        readOnly={readOnly}
        required={Boolean(field.required)}
        autoEdit={autoEdit}
        onCancel={onCancel}
        onCommit={(v) => onChange(v)}
      />
    );
  }

  /* Email, Phone and Website are links first (UI spec §4: "click to
     compose", "click to call/text", "opens in new tab"), so their value is not
     the edit button any more — a separate pencil is. Same split the masked
     field below makes, for the same reason: an <a> cannot sit in a <button>. */
  if (!editing && !isEmpty(value) && !field.sensitive && (field.type === 'email' || field.type === 'phone' || field.type === 'url')) {
    return (
      <LinkValue
        type={field.type}
        text={String(value)}
        label={field.label}
        readOnly={readOnly}
        editRef={displayRef}
        onEdit={() => setEditing(true)}
        onEditFocus={openOnFocus}
        saved={saved}
      />
    );
  }

  const empty = isEmpty(value);
  // An empty field with a real picker control (a status, a checkbox) shows
  // that control directly rather than a plain
  // "Add value" placeholder behind an extra click — there's nothing to type,
  // only something to pick, so showing the picker IS the affordance. Free-
  // text-shaped fields (text, currency, …) keep the click-to-edit "Add
  // value" placeholder, since a naked text input for every empty field
  // in a dense grid would be far noisier than a small dashed chip.
  const livePickerEmpty = !readOnly && empty && LIVE_PICKER_TYPES.has(field.type);

  /* --- read-only presentation ------------------------------------------- */

  /*
   * ⚠️ A MASKED VALUE MUST NOT SIT INSIDE THE CLICK-TO-EDIT BUTTON.
   *
   * It did. `Masked` carries its own Reveal <button>, and it was rendered as
   * the label of the display <button> below — a button inside a button. That
   * is invalid HTML (React reports it as a hydration error: "<button> cannot
   * contain a nested <button>"), and it was also a real behavioural bug: a
   * click on Reveal bubbled to the outer button and opened the editor, so
   * revealing an SSN to read it threw the field into edit mode with the value
   * selected.
   *
   * So a sensitive field that has a value gets a plain container: the masked
   * value with its Reveal, and a separate, explicit Edit control beside it.
   * Tabbing still reaches the field — the Edit control carries the same
   * focus-to-open behaviour the display button does.
   */
  if ((readOnly || (!editing && !livePickerEmpty)) && field.sensitive && !empty) {
    return (
      <div
        className={`flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-[13.5px] leading-snug ${
          readOnly ? 'text-ink-400' : 'text-ink-900'
        } ${saved ? 'animate-saved' : ''}`}
      >
        <Masked value={String(value)} label={field.label} />
        {readOnly ? null : (
          <button
            ref={displayRef}
            type="button"
            onClick={() => setEditing(true)}
            onFocus={openOnFocus}
            aria-label={`Edit ${field.label}`}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-ink-500 transition-colors hover:bg-brand-50 hover:text-brand-700"
          >
            <Icon name="pencil" size={11} />
            Edit
          </button>
        )}
      </div>
    );
  }

  if (readOnly || (!editing && !livePickerEmpty)) {
    return (
      <button
        ref={displayRef}
        type="button"
        disabled={readOnly}
        onClick={() => setEditing(true)}
        onFocus={openOnFocus}
        className={`group w-full rounded-md px-1 py-1 text-left text-[13.5px] leading-snug transition-colors duration-150 ${
          readOnly
            ? // Muted, no hover, no cursor change. Never a lock icon — absence is quieter.
              'cursor-default text-ink-400'
            : 'font-medium text-ink-900 hover:bg-brand-50'
        } ${saved ? 'animate-saved' : ''}`}
      >
        {empty ? (
          readOnly ? (
            <span className="text-ink-400/70">—</span>
          ) : (
            /*
             * A full-width, input-shaped box rather than the small inline chip
             * this used to be.
             *
             * The chip was quiet, which was the intent, but on a tab of mostly
             * empty fields it left the grid looking like a page of labels with
             * nothing to fill in — a real complaint, and a fair one on a form
             * whose whole job is data entry. Matching the height and padding of
             * the real input below also means the cell does not resize when it
             * is clicked into, so a column of fields stops twitching as you tab
             * through it.
             */
            <span
              className={`flex w-full items-center rounded-md border border-dashed px-2 py-1.5 text-[13px] transition-colors group-hover:border-brand-600/50 group-hover:bg-brand-50/40 group-hover:text-brand-700 ${
                field.required ? 'border-warn/60 bg-warn-bg/30 text-warn' : 'border-line text-ink-400'
              }`}
            >
              {field.type === 'date' ? (
                <Icon name="calendar" size={13} className="mr-1.5 shrink-0 opacity-70" />
              ) : null}
              {field.required ? 'Required' : field.type === 'date' ? 'Add date' : 'Add value'}
            </span>
          )
        ) : field.sensitive ? (
          <Masked value={String(value)} label={field.label} />
        ) : (
          <ValueDisplay field={field} value={value} options={options} />
        )}
      </button>
    );
  }

  /* --- edit ------------------------------------------------------------- */
  /*
   * ── ONE FOCUS INDICATOR, AND IT IS THE UNDERLINE ───────────────────────
   * This was `border-brand-600` plus `ring-2 ring-brand-600/20` — a solid blue
   * border with a translucent blue halo outside it, which on a small number
   * box reads as a thick blue rectangle wrapped around three characters.
   * Replacing it with `field-editing` was worse rather than better: that
   * variant paints its line unconditionally, so every open editor carried a
   * blue underline AND the surrounding drawer cell drew a second one under it.
   * Two lines, two pixels apart, for one field.
   *
   * `focus-field` draws nothing until the control actually has focus, and
   * the cell it sits in no longer draws its own. The border stays neutral so
   * the field looks like a field; the underline says which one is live.
   */
  const inputClass =
    'w-full rounded-md border border-line bg-white px-2 py-1.5 text-[14px] text-ink-900 outline-none transition-[border-color,box-shadow] focus-field';

  switch (field.type) {
    /* Status only — an editable Dropdown never reaches here (DropdownSelect
       above), and Long text has its own overlay control. */
    case 'dropdown':
    case 'status':
      return (
        /*
         * ⚠️ A STORED KEY THAT IS NOT IN THIS MODULE'S LIST STILL HAS TO SHOW.
         *
         * `current_status` is configured PER MODULE — Leads offers
         * new_lead…closed, Deals offers application_sent…declined — while the
         * value itself is one field on one record. So a record that is in both
         * necessarily holds a key that one of them cannot resolve.
         *
         * A `<select>` whose `defaultValue` matches no `<option>` silently
         * falls back to the first one, which here is the empty "—". The control
         * then claimed the record had no status at all, and any pick looked
         * like an ordinary edit rather than an overwrite of a value the user
         * was never shown. `orphanOption` below puts the real value back in the
         * list, marked, so the truth is on screen before anything is changed.
         */
        <select
          ref={ref as React.RefObject<HTMLSelectElement>}
          defaultValue={String(value ?? '')}
          className={inputClass}
          onChange={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
          onBlur={cancel}
        >
          <option value="">—</option>
          {orphanOption ? (
            <option value={orphanOption}>{orphanOption} (not an option here)</option>
          ) : null}
          {/* The option's value is the choice KEY — that is what gets stored
              and what `defaultValue` above has to match for the current
              selection to show at all. The label is only ever displayed. */}
          {options.map((c) => (
            <option key={choiceKey(c)} value={choiceKey(c)}>
              {c.value}
            </option>
          ))}
        </select>
      );

    case 'checkbox':
      return (
        <label className="flex items-center gap-2 px-2 py-1.5 text-[14px]">
          <input
            type="checkbox"
            defaultChecked={Boolean(value)}
            className="size-4 accent-[#1d4ed8]"
            onChange={(e) => commit(e.currentTarget.checked)}
          />
          {value ? 'Yes' : 'No'}
        </label>
      );

    case 'multi_select':
    case 'months': {
      // Months are their own identity (there are no choice rows behind them);
      // a multi_select stores an array of choice KEYS, labelled here only.
      const opts =
        field.type === 'months'
          ? MONTH_NAMES.map((m) => ({ stored: m, label: m }))
          : options.map((c) => ({ stored: choiceKey(c), label: c.value }));
      const current = new Set((Array.isArray(value) ? (value as string[]) : []) ?? []);
      const isMonths = field.type === 'months';
      const chip = (stored: string, label: string, on: boolean, onPick: () => void, tone: 'brand' | 'ink' = 'brand') => (
        <button
          key={stored}
          type="button"
          aria-pressed={on}
          onClick={onPick}
          className={`rounded-full border px-2 py-[3px] text-[12px] font-semibold transition-colors duration-150 ${
            on
              ? tone === 'ink'
                ? 'border-ink-900 bg-ink-900 text-white'
                : 'border-brand-600 bg-brand-600 text-white'
              : 'border-line bg-white text-ink-500 hover:border-ink-400'
          }`}
        >
          {label}
        </button>
      );
      return (
        <div className="rounded-md border border-line bg-white p-2 field-editing">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* "No" = not seasonal. Exclusive: it clears the months and a month
                clears it, so the stored array never says both. Set apart from
                the months by a divider and a darker fill. */}
            {isMonths ? (
              <>
                {chip(MONTHS_NONE, 'No', current.has(MONTHS_NONE), () => onChange(toggleMonth([...current], MONTHS_NONE)), 'ink')}
                <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
              </>
            ) : null}
            {opts.map((o) =>
              chip(o.stored, o.label, current.has(o.stored), () => {
                if (isMonths) return onChange(toggleMonth([...current], o.stored));
                const next = new Set(current);
                if (next.has(o.stored)) next.delete(o.stored);
                else next.add(o.stored);
                onChange([...next]);
              }),
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Done
          </Button>
        </div>
      );
    }

    case 'identifier': {
      /*
       * Text, not number. The sheet types MID, MCC, EIN, SSN, account and
       * routing as "Number", which silently drops a leading zero (MCC 0742
       * becomes 742) and cannot express "four digits". Digits only, length
       * checked against the field's own rule — and a field with no rule (MID)
       * takes any length.
       */
      const rule = field.digits;
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="text"
          inputMode="numeric"
          defaultValue={String(value ?? '')}
          className={`${inputClass} font-mono tabular`}
          onKeyDown={keyCommit}
          onChange={(e) => {
            e.currentTarget.value = e.currentTarget.value.replace(/\D/g, '');
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.replace(/\D/g, '');
            if (rule && v && !rule.includes(v.length)) {
              e.currentTarget.setCustomValidity(
                `Needs ${rule.join(' or ')} digits — this has ${v.length}.`,
              );
              e.currentTarget.reportValidity();
              return;
            }
            e.currentTarget.setCustomValidity('');
            commit(v === '' ? null : v);
          }}
        />
      );
    }

    case 'date':
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="date"
          defaultValue={String(value ?? '')}
          className={inputClass}
          onKeyDown={keyCommit}
          /*
           * A day picked in the calendar is the whole edit — it saves then,
           * not on some later blur the user never makes. Typed digits fire
           * this too, one segment at a time, and the year passes through
           * "0002", "0020", "0202" on its way to "2024"; a value counts as
           * finished only once its year is a real one.
           */
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900 && v !== String(value ?? '')) {
              // Marked on the node, so the blur that follows cannot save twice.
              e.currentTarget.dataset.saved = '1';
              commit(v);
            }
          }}
          onBlur={(e) => {
            if (e.currentTarget.dataset.saved) return;
            commit(e.currentTarget.value);
          }}
        />
      );

    case 'currency':
    case 'number':
    case 'percentage': {
      // The unit, shown inside the input while it is being edited. Without it a
      // currency field is an anonymous number box, and the person filling it in
      // has only the column heading to tell them whether it wants dollars,
      // cents or a percentage. The symbol sits inside the border so it reads as
      // part of the field rather than as a separate label.
      const unit = field.type === 'currency' ? '$' : field.type === 'percentage' ? '%' : null;
      const input = (
        <NumberInput
          inputRef={ref as React.RefObject<HTMLInputElement>}
          defaultValue={value == null ? '' : String(value)}
          // Percentages cannot exceed 100; nothing else here has a ceiling.
          max={field.type === 'percentage' ? 100 : undefined}
          className={`${inputClass} ${unit ? (field.type === 'currency' ? 'pl-6' : 'pr-7') : ''}`}
          onEscape={cancel}
          onCommit={commit}
        />
      );
      if (!unit) return input;
      return (
        <span className="relative block">
          {input}
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-y-0 flex items-center text-[13px] font-medium text-ink-400 ${
              field.type === 'currency' ? 'left-2.5' : 'right-3'
            }`}
          >
            {unit}
          </span>
        </span>
      );
    }

    /* Validated (UI spec §4). A malformed address is refused on the spot
       rather than saved — every "click to compose" downstream depends on it. */
    case 'email':
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="email"
          inputMode="email"
          autoComplete="off"
          defaultValue={String(value ?? '')}
          className={inputClass}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          }}
          onInput={(e) => e.currentTarget.setCustomValidity('')}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && !isValidEmail(v)) {
              e.currentTarget.setCustomValidity('Enter an email address like name@company.com.');
              e.currentTarget.reportValidity();
              return;
            }
            commit(v);
          }}
        />
      );

    case 'phone':
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          defaultValue={String(value ?? '')}
          className={`${inputClass} tabular`}
          onKeyDown={keyCommit}
          onBlur={(e) => commit(e.currentTarget.value.trim())}
        />
      );

    default:
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="text"
          inputMode={field.type === 'url' ? 'url' : undefined}
          defaultValue={String(value ?? '')}
          className={inputClass}
          onKeyDown={keyCommit}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Dropdown — the one style (UI spec §4)                                       */
/* -------------------------------------------------------------------------- */

function DropdownSelect({
  label,
  value,
  options,
  orphan,
  required,
  onChange,
}: {
  label: string;
  value: string;
  options: import('../schema').Choice[];
  /** The stored key when this module's list lacks it — kept visible, marked. */
  orphan: string | null;
  required: boolean;
  onChange: (v: string) => void;
}) {
  const empty = value === '';
  return (
    <span className="relative block">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={`w-full cursor-pointer appearance-none truncate rounded-md border bg-white py-1.5 pl-2 pr-7 text-[13.5px] outline-none transition-colors hover:border-ink-300 focus-field ${
          empty
            ? required
              ? 'border-warn/60 bg-warn-bg/30 text-warn'
              : 'border-line text-ink-400'
            : 'border-line font-medium text-ink-900'
        }`}
      >
        <option value="">{required ? 'Required — choose…' : 'Choose…'}</option>
        {orphan ? <option value={orphan}>{orphan} (not an option here)</option> : null}
        {options.map((c) => (
          <option key={choiceKey(c)} value={choiceKey(c)}>
            {c.value}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ink-400">
        <Icon name="chevron-down" size={13} />
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Long text — one line in the grid, a larger box over it to read or edit      */
/* -------------------------------------------------------------------------- */

function LongTextControl({
  label,
  value,
  readOnly,
  required,
  autoEdit,
  onCancel,
  onCommit,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  required: boolean;
  autoEdit?: boolean;
  onCancel?: () => void;
  onCommit: (v: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  // autoEdit is the caller's "open me" gesture (the dashboard pencil), so the
  // box starts open rather than opening in an effect after the first paint.
  const [open, setOpen] = useState(Boolean(autoEdit && !readOnly));
  const [draft, setDraft] = useState(value);
  const [width, setWidth] = useState(380);
  /* Escape must CANCEL, and MenuSurface reports Escape and an outside click
     through the same onClose. Its key listener is on `document` in the capture
     phase, so the only listener guaranteed to run first is one on `window`. */
  const escaped = useRef(false);
  const empty = value.trim() === '';

  const openBox = () => {
    if (readOnly && empty) return;
    setDraft(value);
    setWidth(Math.max(380, (anchor.current?.offsetWidth ?? 0) + 8));
    escaped.current = false;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escaped.current = true;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    if (readOnly) return;
    if (escaped.current) {
      onCancel?.();
      return;
    }
    if (draft !== value) onCommit(draft);
    else onCancel?.();
  };

  const firstLine = value.split(/\r?\n/).find((l) => l.trim()) ?? value;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={readOnly && empty}
        onClick={openBox}
        title={!empty ? value : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`group w-full rounded-md px-1 py-1 text-left text-[13.5px] leading-snug transition-colors duration-150 ${
          readOnly ? 'cursor-default text-ink-400 enabled:cursor-pointer' : 'font-medium text-ink-900 hover:bg-brand-50'
        }`}
      >
        {empty ? (
          readOnly ? (
            <span className="text-ink-400/70">—</span>
          ) : (
            <span
              className={`flex w-full items-center rounded-md border border-dashed px-2 py-1.5 text-[13px] transition-colors group-hover:border-brand-600/50 group-hover:bg-brand-50/40 group-hover:text-brand-700 ${
                required ? 'border-warn/60 bg-warn-bg/30 text-warn' : 'border-line text-ink-400'
              }`}
            >
              {required ? 'Required' : 'Add value'}
            </span>
          )
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{firstLine}</span>
            <Icon name="file-text" size={11} className="shrink-0 text-ink-300 transition-colors group-hover:text-brand-600" />
          </span>
        )}
      </button>
      <MenuSurface open={open} onClose={close} anchorRef={anchor} cover width={width} role="dialog" label={label} padded={false}>
        <div className="p-2">
          <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-500">{label}</div>
          {readOnly ? (
            <p className="max-h-[340px] overflow-y-auto whitespace-pre-wrap rounded-md bg-canvas/60 px-2.5 py-2 text-[13.5px] leading-relaxed text-ink-800">
              {value}
            </p>
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              rows={8}
              className="block w-full resize-y rounded-md border border-line bg-white px-2.5 py-2 text-[13.5px] leading-relaxed text-ink-900 outline-none focus-field"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  close();
                }
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line-faint px-3 py-1.5 text-[11.5px] text-ink-400">
          <span>{readOnly ? 'View only' : 'Ctrl+Enter or click outside to save · Esc to cancel'}</span>
          <button
            type="button"
            onClick={close}
            className="rounded px-1.5 py-0.5 font-semibold text-brand-700 transition-colors hover:bg-brand-50"
          >
            {readOnly ? 'Close' : 'Save'}
          </button>
        </div>
      </MenuSurface>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Email / Phone / Website — a link, with its own edit control                 */
/* -------------------------------------------------------------------------- */

function LinkValue({
  type,
  text,
  label,
  readOnly,
  editRef,
  onEdit,
  onEditFocus,
  saved,
}: {
  type: 'email' | 'phone' | 'url';
  text: string;
  label: string;
  readOnly: boolean;
  editRef: React.RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onEditFocus: () => void;
  saved: boolean;
}) {
  const links = useFieldLinks();
  const linkClass =
    'inline-flex min-w-0 items-center gap-1.5 rounded text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30';

  let main: React.ReactNode;
  let extra: React.ReactNode = null;
  if (type === 'email') {
    main = (
      <a href={links.emailHref(text)} className={linkClass} title={`Write to ${text}`}>
        <Icon name="mail" size={13} className="shrink-0 opacity-70" />
        <span className="truncate">{text}</span>
      </a>
    );
  } else if (type === 'url') {
    main = (
      <a href={websiteHref(text)} target="_blank" rel="noopener noreferrer" className={linkClass} title={`Open ${text} in a new tab`}>
        <Icon name="external-link" size={13} className="shrink-0 opacity-70" />
        <span className="truncate">{text.replace(/^https?:\/\/(www\.)?/i, '')}</span>
      </a>
    );
  } else {
    const shown = formatPhone(text);
    main = (
      <a
        href={`tel:${text.replace(/[^\d+]/g, '')}`}
        onClick={links.call ? (e) => { e.preventDefault(); links.call!(text); } : undefined}
        className={`${linkClass} tabular`}
        title={`Call ${shown}`}
      >
        <Icon name="phone" size={13} className="shrink-0 opacity-70" />
        <span className="truncate">{shown}</span>
      </a>
    );
    extra = (
      <a
        href={links.textHref ? links.textHref(text) : `sms:${text.replace(/[^\d+]/g, '')}`}
        aria-label={`Text ${shown}`}
        title={`Text ${shown}`}
        className="grid size-6 shrink-0 place-items-center rounded text-ink-400 transition-colors hover:bg-brand-50 hover:text-brand-700"
      >
        <Icon name="message-square" size={12} />
      </a>
    );
  }

  return (
    <div className={`flex w-full min-w-0 items-center gap-1 px-1 py-1 text-[13.5px] font-medium leading-snug ${saved ? 'animate-saved' : ''}`}>
      {main}
      <span className="ml-auto flex shrink-0 items-center">
        {extra}
        {readOnly ? null : (
          <button
            ref={editRef}
            type="button"
            onClick={onEdit}
            onFocus={onEditFocus}
            aria-label={`Edit ${label}`}
            title={`Edit ${label}`}
            className="grid size-6 place-items-center rounded text-ink-300 transition-colors hover:bg-brand-50 hover:text-brand-700"
          >
            <Icon name="pencil" size={11} />
          </button>
        )}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Team member control — the one field that grants record visibility           */
/* -------------------------------------------------------------------------- */

/**
 * Add and remove the people who can see this record.
 *
 * ── WHY THIS IS NOT JUST ANOTHER MULTI-SELECT ────────────────────────────
 * `team_members_assigned` is the ONLY field that grants record visibility
 * (migration 6: `sync_record_team_members` derives `record_team_members` from
 * this value and nothing else, and `can_see_record()` reads that table). Every
 * other picker in this file changes what a record SAYS. This one changes who can
 * read it. So it differs from `multi_select` in three deliberate ways:
 *
 *   1. **The value is a list of ids, never labels.** Options come from the live
 *      people directory (`people.tsx`), not from `field_choices` — which is why
 *      `CHOICE_FIELD_TYPES` in `adminSchemas.ts` excludes this type.
 *   2. **A paused account cannot be added.** It is still shown if already
 *      assigned — removing it silently on render would be a permission change
 *      nobody asked for — but it is marked, and it is not in the add list.
 *   3. **Taking yourself off asks first.** It is a legitimate action (hand a
 *      record over and stop watching it), and it is also the one edit in the
 *      drawer that can make the record vanish from under you mid-edit. A
 *      non-admin gets an inline confirm rather than a one-click trapdoor.
 *
 * Stored as a plain `string[]`; `RealFieldGrid` JSON-encodes it and
 * `decodeFieldValue` parses it back, the same round trip every object-valued
 * field type takes.
 */
function TeamMemberControl({
  ids,
  readOnly,
  compact,
  showNames,
  grantsVisibility,
  viewerId,
  viewerIsAdmin,
  onChange,
}: {
  ids: string[];
  readOnly: boolean;
  /** With `compact`: print the names after the avatars (a field card has
   *  the width for them; a table cell does not). */
  showNames?: boolean;
  /**
   * Render as ONE line that never grows: an avatar stack that opens the
   * panel, and no chips.
   *
   * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
   * A dashboard cell is 40px tall and a fixed width. The full control wraps
   * its chips onto as many rows as it needs, which is right in a drawer and
   * impossible in a cell: with three people assigned, opening the editor
   * pushed three stacked chips plus the trigger out of the row and straight
   * over the records underneath it. Reported with a screenshot of exactly
   * that.
   *
   * Nothing is lost by collapsing it, because everything the chips offered
   * now lives in the panel: the panel is a checklist of the whole roster
   * with the assigned people ticked, so adding, removing and seeing who is
   * on are all there. The chips were the only part that needed the height.
   */
  compact?: boolean;
  /** See `FieldRenderer`'s prop of the same name. False for the two
   * `team_member` fields that are informational — everything below that talks
   * about who can SEE the record is suppressed rather than reworded, because
   * there is nothing true to say in its place. */
  grantsVisibility?: boolean;
  viewerId?: string;
  viewerIsAdmin?: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const people = usePeople();
  const byId = usePeopleById();
  const [confirmingSelf, setConfirmingSelf] = useState(false);

  const selected = ids.map((id) => resolvePerson(id, byId));
  const chosen = new Set(ids);

  /* The picker. A ref for the trigger because `MenuSurface` positions
     against it rather than living inside it — see the comment at the call. */
  const addRef = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  const remove = (id: string) => onChange(ids.filter((x) => x !== id));
  const add = (id: string) => {
    if (!id || chosen.has(id)) return;
    onChange([...ids, id]);
  };

  /*
   * ── THE WHOLE ROSTER, NOT ONLY THE UNASSIGNED ───────────────────────────
   * The menu used to list `addable` and close after one pick, so assigning
   * three people meant opening it three times, and the only way to take
   * somebody off was to find their chip. The panel is a multi-select now, so
   * it has to show who is already on as well — a checklist that omits the
   * ticked rows is not a checklist.
   *
   * A suspended account is still never offered; an unknown id is not either,
   * since it is already on the list and there is nothing to offer.
   */
  const roster = people.filter((p) => !p.suspended);
  const q = query.trim().toLowerCase();
  const shown = q
    ? roster.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q),
      )
    : roster;

  const names = selected.map((p) => p.name).join(', ');

  if (readOnly && compact && showNames) {
    return selected.length ? (
      <div className="flex min-w-0 items-center gap-1.5 px-1 py-1" title={names}>
        <span className="flex shrink-0 -space-x-1.5">
          {selected.slice(0, 3).map((pp) => (
            <PersonAvatar key={pp.id} person={pp} size={18} />
          ))}
        </span>
        <span className="min-w-0 truncate text-[13px] text-ink-500">{names}</span>
      </div>
    ) : (
      <span className="px-1 text-ink-400/70">—</span>
    );
  }

  if (readOnly) {
    return selected.length ? (
      <div className="flex flex-wrap items-center gap-1.5 py-1">
        {selected.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1.5 text-[13px] text-ink-700">
            <PersonAvatar person={p} size={18} />
            <span className="truncate">{p.name}</span>
          </span>
        ))}
      </div>
    ) : (
      <span className="text-ink-400/70">—</span>
    );
  }

  return (
    <div className={compact ? 'flex min-w-0 items-center' : 'space-y-1.5 py-1'}>
      <div
        className={
          compact
            ? 'flex min-w-0 items-center gap-1'
            : 'flex flex-wrap items-center gap-1.5'
        }
      >
        {/* Compact shows no chips — except the one asking "Remove yourself?",
            which the checklist hands back here and which must be seen. */}
        {(compact ? (confirmingSelf ? selected.filter((p) => p.id === viewerId) : []) : selected).map((p) => {
          const isSelf = Boolean(viewerId) && p.id === viewerId;
          // Only worth confirming where it actually costs something: this
          // field grants the visibility, and an admin keeps it regardless.
          const needsConfirm = isSelf && !viewerIsAdmin && Boolean(grantsVisibility);

          if (needsConfirm && confirmingSelf) {
            return (
              <span
                key={p.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#f7e0af] bg-[#fdf1d8] px-2 py-[3px] text-[11.5px] font-semibold text-[#8a5a09]"
              >
                <Icon name="alert-triangle" size={11} />
                Remove yourself? You lose this record.
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingSelf(false);
                    remove(p.id);
                  }}
                  className="rounded px-1 underline underline-offset-2 hover:opacity-75"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingSelf(false)}
                  className="rounded px-1 hover:opacity-75"
                >
                  Cancel
                </button>
              </span>
            );
          }

          return (
            /*
               ⚠️ `min-w-0 max-w-full` ON THE CHIP, AND THE NAME SHRINKS.
               The name had a fixed `max-w-[160px]`, which is wider than the
               168px header-strip track once the avatar, the gap and the
               remove button are added. The chip therefore overflowed and was
               cut off by the cell — reported as the assigned people being
               unreadable and their remove buttons missing, with three chips
               stacked and each sliced down the right-hand edge.
               A fixed cap cannot be right in three containers of different
               widths. Shrinking to whatever is available can: the avatar and
               the remove button hold their size, and the name takes the rest
               and truncates. */
            <span
              key={p.id}
              className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-[3px] pl-[3px] pr-1.5 text-[12.5px] ${
                p.unknown || p.suspended
                  ? 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
                  : 'border-line bg-white text-ink-700'
              }`}
            >
              <span className="shrink-0">
                <PersonAvatar person={p} size={18} />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              {p.suspended ? (
                /* A badge, not a bare word. Sitting as plain text beside the
                   name it read like part of the name — "test@gmail.com
                   paused" — which is exactly how it was reported. */
                <span className="rounded-full bg-[#f7e0af]/70 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[.04em]">
                  paused
                </span>
              ) : null}
              {isSelf ? <span className="text-[11px] text-ink-400">you</span> : null}
              <button
                type="button"
                aria-label={`Remove ${p.name} from the team`}
                title={
                  needsConfirm
                    ? 'Remove yourself — this record stops being visible to you'
                    : `Remove ${p.name}`
                }
                onClick={() => (needsConfirm ? setConfirmingSelf(true) : remove(p.id))}
                className="ml-0.5 grid size-4 shrink-0 place-items-center rounded-full text-ink-400 transition-colors hover:bg-canvas hover:text-bad"
              >
                <Icon name="x" size={10} strokeWidth={2.5} />
              </button>
            </span>
          );
        })}

        {selected.length === 0 && !compact ? (
          <span
            className={`inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-px text-[12.5px] ${
              grantsVisibility ? 'border-warn/50 text-warn' : 'border-line text-ink-400'
            }`}
          >
            {grantsVisibility ? 'Nobody but an admin can see this record' : 'Nobody assigned'}
          </span>
        ) : null}

        {/*
          ── THE ADD CONTROL BELONGS ON THE SAME ROW AS THE PEOPLE ─────────
          It was a full-width `<select>` on its own line underneath, which
          made one small act — add a person — look like a form, and pushed
          the chips and the thing that adds to them into two separate
          blocks. Inline, chip-shaped and dashed, it reads as the next
          empty slot in the same list, which is the same affordance the
          file row uses for "add a file".

          Still a native select: it keeps the keyboard and screen-reader
          behaviour for free, and the list can be long. The chip look is the
          wrapper's; the select sits transparently on top of it so the whole
          chip is the hit area.
        */}
        {roster.length ? (
          /*
            -- A MULTI-SELECT PANEL, AFTER THREE WRONG ANSWERS --------------
            This control has to work in three containers of very different
            widths: a drawer field (wide), a 168px header-strip track, and a
            dashboard table cell. A native <select> could not:

              - laid over a chip at `opacity-0`, its dropdown sized itself to
                the ~150px chip and truncated every name, and telling two
                people apart is this control's entire job, because picking
                wrong shows the record to the wrong person;
              - given a real `min-w` instead, the control itself then
                overflowed the header track and the table cell, pushing into
                the next column and the row below.

            Both were reported, and they are the same problem from two
            directions: a menu laid out INSIDE the cell is bounded by the
            cell. `MenuSurface` portals to the body and positions against the
            trigger, so the trigger can stay chip-sized while the list is as
            wide as the names need, and no ancestor's overflow can clip it.

            The third report was about the panel that fixed those: it listed
            only unassigned people and CLOSED after each pick, so putting two
            people on a record meant opening it twice, and with two already
            assigned the row of chips plus the trigger no longer fit. So it is
            a checklist now. It stays open, every tick is saved as it is made,
            and people already on the record are shown ticked rather than
            hidden, which is also the only place the full roster and the
            current team are visible at the same time.
          */
          <>
            <button
              ref={addRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={adding}
              onClick={() => {
                setQuery('');
                setAdding((v) => !v);
              }}
              className={
                compact
                  ? `group/team flex min-w-0 items-center gap-1.5 rounded-md px-1 transition-colors ${
                      showNames ? 'w-full py-1 hover:bg-brand-50' : 'py-0.5 hover:bg-canvas'
                    }`
                  : `inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2 py-[3px] text-[12.5px] font-medium transition-colors ${
                      grantsVisibility
                        ? 'border-warn/60 text-warn hover:border-warn hover:bg-warn-bg/40'
                        : 'border-line text-brand-700 hover:border-brand-600 hover:bg-brand-50'
                    }`
              }
            >
              {compact ? (
                <>
                  {selected.length ? (
                    /* Overlapped, and capped at three. The cell is a fixed
                       width; a stack that grows with the team is the same
                       overflow in a quieter form. */
                    <span className="flex shrink-0 -space-x-1.5">
                      {selected.slice(0, 3).map((pp) => (
                        <PersonAvatar key={pp.id} person={pp} size={18} />
                      ))}
                    </span>
                  ) : (
                    <span className={`truncate text-[12.5px] ${grantsVisibility ? 'text-warn' : 'text-ink-400'}`}>
                      {grantsVisibility ? 'Only admins can see this' : 'Nobody assigned'}
                    </span>
                  )}
                  {selected.length > 3 ? (
                    <span className="shrink-0 text-[11.5px] text-ink-400">+{selected.length - 3}</span>
                  ) : null}
                  {showNames && selected.length ? (
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink-800" title={names}>
                      {names}
                    </span>
                  ) : null}
                  <span
                    aria-hidden
                    className={`shrink-0 text-ink-300 transition-opacity ${
                      showNames ? 'ml-auto' : 'opacity-0 group-hover/team:opacity-100 group-focus-visible/team:opacity-100'
                    }`}
                  >
                    <Icon name="chevron-down" size={11} />
                  </span>
                </>
              ) : (
                <>
                  <Icon name="plus" size={11} strokeWidth={2.4} />
                  {selected.length ? 'Edit team' : 'Add team member'}
                </>
              )}
            </button>
            <MenuSurface
              open={adding}
              onClose={() => setAdding(false)}
              anchorRef={addRef}
              align="left"
              width={320}
              label="Choose team members"
            >
              {/* Search earns its place once the roster passes a handful:
                  picking the wrong person here is what hands a record to
                  someone who should not have it, so finding the right one
                  must not depend on scrolling carefully. */}
              {roster.length > 6 ? (
                <div className="px-1.5 pb-1 pt-0.5">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search people..."
                    aria-label="Search people"
                    className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
                  />
                </div>
              ) : null}

              <div className="max-h-[300px] overflow-y-auto py-0.5">
                {shown.map((p) => {
                  const on = chosen.has(p.id);
                  const isSelf = Boolean(viewerId) && p.id === viewerId;
                  /* Same rule as the chip: only worth confirming where it
                     actually costs something, which is where this field
                     grants the visibility and the viewer is not an admin. */
                  const needsConfirm = on && isSelf && !viewerIsAdmin && Boolean(grantsVisibility);

                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={() => {
                        /* Taking yourself off is the one change that can lose
                           you the record, so it is handed back to the chip's
                           existing confirm rather than happening on one click
                           inside a list you are halfway through reading. */
                        if (needsConfirm) {
                          setConfirmingSelf(true);
                          setAdding(false);
                          return;
                        }
                        if (on) remove(p.id);
                        else add(p.id);
                      }}
                      title={
                        needsConfirm
                          ? 'Remove yourself - this record stops being visible to you'
                          : undefined
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-canvas"
                    >
                      {/* A drawn box rather than a real checkbox: the row is
                          the hit area, and a nested input would take the
                          click and need its own keyboard handling. The button
                          carries `menuitemcheckbox`, so the state is
                          announced either way. */}
                      <span
                        aria-hidden
                        className={`grid size-[15px] shrink-0 place-items-center rounded border transition-colors ${
                          on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white'
                        }`}
                      >
                        {on ? <Icon name="check" size={10} strokeWidth={3} /> : null}
                      </span>
                      {/* Known by construction - `roster` is built from the
                          people list, so it can never hold an unresolved id. */}
                      <span className="shrink-0">
                        <PersonAvatar person={{ ...p, unknown: false }} size={18} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink-900">
                          {p.name}
                          {isSelf ? (
                            <span className="ml-1 text-[11px] font-normal text-ink-400">you</span>
                          ) : null}
                        </span>
                        {/* The email is what makes two people with the same
                            (or no) display name distinguishable. It gets its
                            own line rather than being truncated onto the end
                            of the name, which is what the old menu did. */}
                        {p.email && p.email !== p.name ? (
                          <span className="block truncate text-[11px] text-ink-400">{p.email}</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}

                {shown.length === 0 ? (
                  <p className="px-2.5 py-3 text-center text-[12px] text-ink-400">
                    Nobody matches that search.
                  </p>
                ) : null}
              </div>

              {/* States what the panel has already done. Every tick saved as
                  it was made, so there is deliberately nothing here that
                  commits, and Done only closes. */}
              <div className="flex items-center justify-between gap-2 border-t border-line-faint px-2.5 py-1.5 text-[11.5px] text-ink-400">
                <span>{selected.length === 0 ? 'Nobody assigned' : `${selected.length} assigned`}</span>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="rounded px-1.5 py-0.5 font-semibold text-brand-700 transition-colors hover:bg-brand-50"
                >
                  Done
                </button>
              </div>
            </MenuSurface>
          </>
        ) : (
          <span className="text-[11px] text-ink-400">No active accounts to assign.</span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Must-total-100% control                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The spreadsheet marks four fields "Multiple Choice (must total 100%)":
 * Customer type, Customer profile, Sales method, Payment codes.
 *
 * The rule is the reason the type exists, so the control enforces it visibly:
 * a running total that turns amber the moment it stops being 100, and a one-click
 * balance that puts the difference on the last non-zero part. It does NOT block
 * typing — an underwriter half way through entering three numbers is briefly at
 * 60%, and a control that fought them there would be unusable.
 */
function PercentSplitControl({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: Field;
  value: PercentSplit | null;
  readOnly: boolean;
  onChange: (v: FieldValue) => void;
}) {
  // The split object is KEYED BY CHOICE KEY, like every other choice-backed
  // value — `{ business: 60, gov: 15, individual: 25 }`, not by the labels,
  // which an admin can rename at any time in the choices editor.
  const parts = (field.choices ?? []).map((c) => ({ stored: choiceKey(c), label: c.value }));
  const split: PercentSplit = value ?? Object.fromEntries(parts.map((p) => [p.stored, 0]));
  const total = splitTotal(split);
  const balanced = total === 100;

  /* One bar for the whole value, a segment per part: the proportions read at a
     glance across the full row without any arithmetic. */
  const bar = (
    <div aria-hidden className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-canvas">
      {parts.map((p, i) => {
        const n = Math.min(100, Number(split[p.stored]) || 0);
        return n > 0 ? (
          <span
            key={p.stored}
            title={`${p.label} ${n}%`}
            className="h-full transition-[width] duration-200 first:rounded-l-full last:rounded-r-full"
            style={{ width: `${n}%`, background: SPLIT_TONES[i % SPLIT_TONES.length] }}
          />
        ) : null;
      })}
    </div>
  );

  if (readOnly) {
    return value ? (
      <div className="px-1 py-1">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13.5px] text-ink-500">
          {parts.map((p, i) => (
            <span key={p.stored} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: SPLIT_TONES[i % SPLIT_TONES.length] }} />
              {p.label}
              <span className="font-medium tabular text-ink-800">{Number(split[p.stored]) || 0}%</span>
            </span>
          ))}
          <span className="ml-auto text-[12px] tabular text-ink-400">{total}% of 100%</span>
        </div>
        {bar}
      </div>
    ) : (
      <div className="px-1 py-1 text-[13.5px] text-ink-400/70">—</div>
    );
  }

  const set = (key: string, n: number) => {
    // NumberInput has already refused negatives and anything over 100; this is
    // the second clamp, because the value is about to be stored.
    const next = { ...split, [key]: Math.max(0, Math.min(100, Math.round(n) || 0)) };
    onChange(next);
  };

  const balance = () => {
    const diff = 100 - total;
    const used = parts.filter((p) => (split[p.stored] ?? 0) > 0);
    const target = (used[used.length - 1] ?? parts[0])?.stored;
    if (!target) return;
    onChange({ ...split, [target]: Math.max(0, (split[target] ?? 0) + diff) });
  };

  /*
   * UI spec §3: a full-row type — every part side by side across the row, the
   * running "x% of 100%" at the right end. Wraps onto a second line only when
   * the drawer is too narrow to hold them all.
   */
  return (
    <div className="px-1 py-1">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {parts.map((p, i) => (
          <label key={p.stored} className="inline-flex items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: SPLIT_TONES[i % SPLIT_TONES.length] }} />
            <span className="whitespace-nowrap text-[13px] text-ink-700">{p.label}</span>
            <span className="relative">
              <NumberInput
                min={0}
                max={100}
                align="right"
                value={split[p.stored] ?? 0}
                onLiveChange={(n) => set(p.stored, n ?? 0)}
                className="w-[72px] rounded-md border border-line bg-white py-1.5 pl-2 pr-6 text-[13.5px] outline-none transition-colors hover:border-ink-300 focus-field"
              />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[12px] text-ink-400">
                %
              </span>
            </span>
          </label>
        ))}

        <span className="ml-auto flex items-center gap-2.5">
        {!balanced ? (
          <button
            type="button"
            onClick={balance}
            className="text-[12px] font-semibold text-brand-700 hover:underline"
          >
            Balance to 100%
          </button>
        ) : null}
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold tabular ${
            balanced
              ? 'border-[#c2e9e1] bg-[#e0f5f1] text-[#0b7466]'
              : 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
          }`}
        >
          <Icon name={balanced ? 'check' : 'alert-triangle'} size={11} strokeWidth={2.2} />
          {total}% of 100%
        </span>
        </span>
      </div>
      {bar}
    </div>
  );
}

/** Segment colours for a must-total-100% bar: the brand blue stepping out,
 *  then teal and amber — distinct side by side, calm on a white card. */
const SPLIT_TONES = ['#1d4ed8', '#60a5fa', '#0b7466', '#5ec8b8', '#b7791f', '#94a3b8'];

/* -------------------------------------------------------------------------- */
/* Address control — structured street/city/state/zip/country                 */
/* -------------------------------------------------------------------------- */

function AddressControl({
  value,
  readOnly,
  onChange,
}: {
  value: AddressValue;
  readOnly: boolean;
  onChange: (v: FieldValue) => void;
}) {
  // Local, accumulated state rather than merging each edit against the
  // `value` PROP: the prop only reflects the server's last CONFIRMED write,
  // and this record's compare-and-swap save (`set_record_value`'s
  // `expected_updated_at`) is per-RECORD, not per-field — editing street
  // then immediately tabbing to city would otherwise send city's commit with
  // an `expectedUpdatedAt` already stale from street's own save landing a
  // moment earlier, so the server would refuse the second write. Debouncing
  // one commit of the fully-merged object, after a short pause, means a
  // normal "fill out the four fields" pass sends exactly one save.
  /*
   * ⚠️ Compared by VALUE, not by reference.
   *
   * This is the standard "reset state when a prop changes" pattern, and it was
   * broken here by the one thing that pattern depends on: a stable prop
   * identity. The caller renders `<AddressControl value={asAddress(value)} …>`,
   * and `asAddress` builds a NEW object literal on every call — so
   * `value !== snapshot` was true on EVERY render, and the reset fired every
   * time, throwing away whatever had been typed since the last commit.
   *
   * The parent re-renders often (`setValues` and `setSaving` in
   * `RealFieldGrid`), so in practice characters typed in the moment after a
   * debounced save resolved were wiped out of the input, while the pending
   * 500ms timer still committed the pre-wipe object — the field appeared to
   * fight the keyboard and then to undo itself. Serialising the five known
   * string fields is exact for this shape and costs nothing at this size.
   */
  const valueKey = addressKey(value);
  const [local, setLocal] = useState(value);
  const [snapshot, setSnapshot] = useState(valueKey);
  if (valueKey !== snapshot) {
    setSnapshot(valueKey);
    setLocal(value);
  }

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);

  /* Address 2 is collapsed behind "+ Address 2" until it is wanted, and stays
     open once it holds something (UI spec §3). */
  const [line2Open, setLine2Open] = useState(Boolean(value.street2));
  const showLine2 = line2Open || Boolean(local.street2);

  if (readOnly) {
    const empty = !value.street && !value.street2 && !value.city && !value.state && !value.zip;
    return (
      <div className="px-1 py-1 text-[13.5px] leading-relaxed text-ink-400">
        {empty ? '—' : formatAddress(value)}
      </div>
    );
  }

  const set = (patch: Partial<AddressValue>) => {
    const next = { ...local, ...patch };
    // Country defaults in on the first real edit, not on mount — an address
    // no field of which has ever been touched should still read as empty.
    const withCountry = Object.values(next).some(Boolean) ? { ...next, country: next.country || 'United States' } : next;
    setLocal(withCountry);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => onChange(withCountry), 500);
  };

  const zipValid = !local.zip || US_ZIP_PATTERN.test(local.zip);

  const box =
    'min-w-0 rounded-md border bg-white px-2 py-1.5 text-[13.5px] outline-none transition-colors hover:border-ink-300 focus-field';

  /*
   * UI spec §3: Address 1 · Address 2 · City · State · Zip, left to right
   * across the full row. Flex with growth ratios rather than fixed tracks, so
   * a narrow drawer wraps the row instead of crushing the street line.
   */
  return (
    <div className="px-1 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="Address 1"
          placeholder="Address 1"
          autoComplete="off"
          value={local.street}
          onChange={(e) => set({ street: e.currentTarget.value })}
          className={`${box} flex-[2_1_220px] border-line`}
        />
        {showLine2 ? (
          <input
            type="text"
            aria-label="Address 2"
            placeholder="Address 2 — suite, unit, floor"
            autoComplete="off"
            autoFocus={line2Open && !local.street2}
            value={local.street2}
            onChange={(e) => set({ street2: e.currentTarget.value })}
            className={`${box} flex-[1.4_1_170px] border-line`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setLine2Open(true)}
            className="inline-flex h-[34px] shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-brand-700 transition-colors hover:bg-brand-50"
          >
            <Icon name="plus" size={11} strokeWidth={2.4} />
            Address 2
          </button>
        )}
        <input
          type="text"
          aria-label="City"
          placeholder="City"
          autoComplete="off"
          value={local.city}
          onChange={(e) => set({ city: e.currentTarget.value })}
          className={`${box} flex-[1.2_1_140px] border-line`}
        />
        <select
          aria-label="State"
          title={`${local.country || 'United States'} — USA only, for now`}
          value={local.state}
          onChange={(e) => set({ state: e.target.value })}
          className={`${box} w-[84px] shrink-0 cursor-pointer border-line px-1.5 ${local.state ? '' : 'text-ink-400'}`}
        >
          <option value="">State</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>{s.code}</option>
          ))}
        </select>
        <input
          type="text"
          inputMode="numeric"
          aria-label="ZIP"
          aria-invalid={!zipValid || undefined}
          placeholder="ZIP"
          autoComplete="off"
          value={local.zip}
          onChange={(e) => set({ zip: e.currentTarget.value })}
          className={`${box} w-[104px] shrink-0 tabular ${zipValid ? 'border-line' : 'border-bad/50'}`}
        />
      </div>
      {!zipValid ? <p className="mt-1 text-[11px] text-bad">ZIP should be 5 digits, or 5+4 (12345-6789).</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grid control — the "excel-type sheet" fields                                */
/* -------------------------------------------------------------------------- */

/**
 * The 19 Aug amendment typed grid columns: One Time Charges' "Charge amount"
 * is `currency`, its "Date" is `date`. Each cell renders by its column's own
 * type — the same registry every ordinary field already goes through — rather
 * than being four free-text boxes with a label sitting next to them.
 *
 * Values are still stored as strings in the row object (a currency cell holds
 * "124.50", not a formatted display string), so a text input with the right
 * `type`/`inputMode` and alignment is enough; there is no separate value shape
 * for grid cells to keep in sync with the field-level renderers.
 */
function GridControl({
  field,
  rows,
  readOnly,
  onChange,
}: {
  field: Field;
  rows: GridRow[];
  readOnly: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const cols = field.columns ?? [];

  const setCell = (i: number, label: string, v: string) => {
    onChange(rows.map((r, k) => (k === i ? { ...r, [label]: v } : r)));
  };
  const addRow = () => onChange([...rows, Object.fromEntries(cols.map((c) => [c.label, '']))]);
  const removeRow = (i: number) => onChange(rows.filter((_, k) => k !== i));

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-white">
      <div
        className="grid gap-px border-b border-line-soft bg-canvas"
        style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0,1fr)) 34px` }}
      >
        {cols.map((c) => (
          <span
            key={c.label}
            className={`truncate bg-canvas px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-ink-500 ${
              c.type === 'currency' ? 'text-right' : ''
            }`}
            title={c.label}
          >
            {c.label}
          </span>
        ))}
        <span className="bg-canvas" />
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-5 text-center text-[12.5px] text-ink-400">
          No rows yet. Use <span className="font-semibold text-ink-500">Add a row</span> below.
        </p>
      ) : (
        rows.map((row, i) => (
          /*
           * `bg-line-soft` behind a `gap-px` grid is what DRAWS the column
           * dividers: the gap lets the parent's colour show through as a 1px
           * rule, and each cell paints itself white on top. Without it the row
           * was a run of transparent inputs with no boundaries at all, so an
           * empty grid read as a blank area rather than as cells waiting to be
           * filled — which is exactly how it looked on screen.
           */
          <div
            key={i}
            className="grid items-stretch gap-px border-b border-line-soft bg-line-soft last:border-0"
            style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0,1fr)) 34px` }}
          >
            {cols.map((c) => (
              <GridCell
                key={c.label}
                column={c}
                value={row[c.label] ?? ''}
                readOnly={readOnly}
                onChange={(v) => setCell(i, c.label, v)}
              />
            ))}
            <span className="flex items-center justify-center bg-white">
              {readOnly ? null : (
                <IconButton icon="trash" title="Remove this row" tone="danger" size={26} onClick={() => removeRow(i)} />
              )}
            </span>
          </div>
        ))
      )}

      {!readOnly ? (
        <div className="border-t border-line-soft p-1.5">
          <Button size="sm" variant="ghost" icon="plus" onClick={addRow}>
            Add a row
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A money cell: formatted at rest, a plain number input while being edited.
 *
 * The bare `NumberInput` this replaced showed `15` in a column headed CHARGE
 * AMOUNT, which does not read as money at all — the same value renders as
 * `$15.00` everywhere else in the app, and a grid that disagrees with the rest
 * of the UI about what a number means is worse than one that is merely plain.
 *
 * Formatting only at rest is the point: `$15.00` cannot be typed into, and an
 * input that reformats under the cursor fights the person using it. Focus swaps
 * to the raw number, blur swaps back. `formatCurrency` is the same function the
 * drawer and the dashboard already use, so all three agree by construction.
 */
function CurrencyGridCell({
  value,
  readOnly,
  base,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  base: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const n = value === '' ? null : Number(value);
  const showFormatted = !editing && n != null && Number.isFinite(n);

  if (readOnly || showFormatted) {
    return (
      <button
        type="button"
        disabled={readOnly}
        onClick={() => setEditing(true)}
        /*
         * Focus swaps to the raw number, as the header above says it does —
         * it just never did, because only a click opened it. Tabbing into a
         * money column left a formatted value that could not be typed into.
         *
         * No re-open guard is needed here, unlike the drawer cell: closing
         * happens on the INPUT's commit, so focus is on the input when it
         * unmounts and never returns to this button.
         */
        onFocus={() => setEditing(true)}
        className={`${base} tabular text-right ${readOnly ? '' : 'cursor-text'}`}
      >
        {n == null || !Number.isFinite(n) ? '' : formatCurrency(n)}
      </button>
    );
  }

  return (
    <NumberInput
      value={value}
      align="right"
      // Autofocus only when the swap came from a click, never on first paint —
      // otherwise the first money column would steal focus as the tab opens.
      inputRef={(el) => { if (editing && el) el.focus(); }}
      placeholder="0.00"
      onLiveChange={(v) => onChange(v == null ? '' : String(v))}
      onCommit={() => setEditing(false)}
      className={`${base} tabular text-right`}
    />
  );
}

/** One cell inside a grid row, rendered by its column's type. */
function GridCell({
  column,
  value,
  readOnly,
  onChange,
}: {
  column: { label: string; type: FieldType };
  value: string;
  readOnly: boolean;
  onChange: (v: string) => void;
}) {
  /*
   * `bg-white`, not `bg-transparent`. The cell has to PAINT itself for the
   * parent row's 1px gaps to read as dividers, and an input with no background
   * and no border is invisible when empty — the Charges grid looked like an
   * empty box with a stray date picker in it.
   *
   * `h-full` so every cell fills the row height and the dividers run the full
   * way down, and an inset focus ring rather than an outline so focus does not
   * overlap the neighbouring cell.
   */
  const base = `h-full w-full bg-white px-2.5 py-2 text-[13px] outline-none transition-colors ${
    readOnly
      ? 'cursor-default text-ink-400'
      : 'text-ink-700 placeholder:text-ink-300 hover:bg-brand-50/40 focus:bg-white focus:shadow-[inset_0_0_0_2px_var(--color-brand-600)]'
  }`;

  if (column.type === 'currency') {
    return (
      <CurrencyGridCell value={value} readOnly={readOnly} base={base} onChange={onChange} />
    );
  }

  if (column.type === 'date') {
    return (
      <input
        type="date"
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={`${base} tabular disabled:bg-white`}
      />
    );
  }

  return (
    <input
      value={value}
      readOnly={readOnly}
      // The column name as placeholder, so an empty row still says what each
      // cell is for once the header has scrolled out of view on a long grid.
      placeholder={readOnly ? undefined : column.label}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={base}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer value display                                                        */
/* -------------------------------------------------------------------------- */

function ValueDisplay({
  field,
  value,
  options,
}: {
  field: Field;
  value: FieldValue;
  options: import('../schema').Choice[];
}) {
  switch (field.type) {
    case 'status': {
      const choice = options.find((c) => choiceKey(c) === String(value));
      /*
       * No matching choice means the record holds a key this module does not
       * offer — nearly always a per-module choice list differing from the one
       * the value was set under. It rendered as a plain pill showing the raw
       * key, which reads as an option someone typed in lower case rather than
       * as a value that does not belong here. Dashed and dimmed, with the
       * reason in the tooltip, so it is legible AS an anomaly.
       */
      if (!choice && value != null && String(value) !== '') {
        return (
          <span
            title={`"${String(value)}" is not one of this module's options for ${field.label}.`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-dashed border-line px-2 py-[2.5px] text-[11.5px] font-medium text-ink-400"
          >
            <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-ink-300" />
            <span className="truncate">{String(value)}</span>
          </span>
        );
      }
      return <StatusPill label={choiceLabel(options, value)} swatch={choice?.swatch} size="md" />;
    }
    case 'team_member':
      return <AvatarStack ids={value as string[]} max={4} />;
    case 'currency':
      return <span className="tabular font-medium">{formatCurrency(Number(value))}</span>;
    case 'percentage':
      return <span className="tabular font-medium">{Number(value).toFixed(2)}%</span>;
    case 'date':
      return <span className="tabular">{formatDate(String(value))}</span>;
    case 'datetime':
      return <span className="tabular">{formatDateTime(String(value))}</span>;
    case 'checkbox':
      return value ? (
        <StatusPill label="Yes" swatch="teal" dot={false} />
      ) : (
        <span className="text-ink-400">No</span>
      );
    case 'email':
      return (
        <span className="inline-flex items-center gap-1.5 text-brand-700 underline-offset-2 hover:underline">
          <Icon name="mail" size={13} className="opacity-70" />
          {String(value)}
        </span>
      );
    case 'url':
      return (
        <span className="inline-flex items-center gap-1.5 text-brand-700 underline-offset-2 hover:underline">
          <Icon name="external-link" size={13} className="opacity-70" />
          {String(value)}
        </span>
      );
    case 'identifier':
      return <span className="font-mono text-[13px] tabular">{String(value)}</span>;
    case 'phone':
      return (
        <span className="inline-flex items-center gap-1.5 tabular">
          <Icon name="phone" size={13} className="text-ink-400" />
          {formatPhone(String(value))}
        </span>
      );
    case 'multi_select':
    case 'months':
      return (
        <span className="flex flex-wrap gap-1">
          {asChoiceArray(value).map((v) => (
            <OutlineChip key={v}>{choiceLabel(options, v)}</OutlineChip>
          ))}
        </span>
      );
    case 'dropdown':
      return <span className="block truncate">{choiceLabel(options, value)}</span>;
    case 'long_text':
      return <span className="block truncate">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

/* -------------------------------------------------------------------------- */
/* Auto-populated (locked) — shown by where the value comes from               */
/* -------------------------------------------------------------------------- */

/**
 * A person for Record creator, a date for Created, plain text for a lookup.
 * Keyed by SOURCE, not by field — an admin can add another auto field with
 * any of these sources and it renders correctly with no change here.
 */
function AutoValue({ field, value }: { field: Field; value: FieldValue }) {
  const byId = usePeopleById();
  if (field.autoSource === 'record_creator') {
    const person = resolvePerson(String(value), byId);
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={person.email ?? person.name}>
        <PersonAvatar person={person} size={18} />
        <span className="truncate">{person.name}</span>
      </span>
    );
  }
  if (field.autoSource === 'created_at') {
    return <span className="tabular">{formatDate(String(value))}</span>;
  }
  return <span className="truncate" title={String(value)}>{String(value)}</span>;
}
