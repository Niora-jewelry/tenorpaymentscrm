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
import type { Field, FieldType, FieldValue, GridRow, PercentSplit, AddressValue } from '../schema';
import { choicesFor, choiceKey, choiceLabel } from '../fields';
import { formatCurrency, formatDate, formatDateTime, MONTH_NAMES } from './tokens';
import { StatusPill, OutlineChip, AvatarStack, Button, IconButton, NumberInput } from './kit';
import { PersonAvatar, resolvePerson, usePeople, usePeopleById } from './people';
import { Icon } from './icons';

/* -------------------------------------------------------------------------- */
/* Value shape helpers                                                         */
/* -------------------------------------------------------------------------- */

export function isNumeric(type: Field['type']): boolean {
  return type === 'currency' || type === 'number' || type === 'percentage';
}

/** Field types with a real picker control (nothing to type, only something to
 * pick) — shown live when empty instead of a click-to-reveal placeholder. */
const LIVE_PICKER_TYPES = new Set<FieldType>(['date', 'dropdown', 'status', 'checkbox']);

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
  return `${a.street}\u0000${a.city}\u0000${a.state}\u0000${a.zip}\u0000${a.country}`;
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
      city: typeof o.city === 'string' ? o.city : '',
      state: typeof o.state === 'string' ? o.state : '',
      zip: typeof o.zip === 'string' ? o.zip : '',
      country: typeof o.country === 'string' ? o.country : '',
    };
  }
  if (typeof v === 'string' && v) return { street: v, city: '', state: '', zip: '', country: '' };
  return { street: '', city: '', state: '', zip: '', country: '' };
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
  const line = [a.street, cityStateZip].filter(Boolean).join(', ');
  return line || a.country || '';
}

function splitTotal(split: PercentSplit): number {
  return Object.values(split).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** "Business 60% · Gov 15% · Individual 25%" — the split is keyed by choice
 * key, so the options are needed to turn `business` back into "Business". */
function splitSummary(split: PercentSplit, options: import('../schema').Choice[] = []): string {
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
    case 'dropdown':
      return <OutlineChip>{choiceLabel(choicesFor(field, moduleSlug ?? ''), value)}</OutlineChip>;
    case 'address':
      return <span className="truncate">{formatAddress(asAddress(value))}</span>;
    case 'percent_split': {
      const split = asSplit(value);
      return (
        <span className="tabular text-[12.5px]">
          {split ? splitSummary(split, field.choices ?? []) : '—'}
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

  const empty = isEmpty(value);
  // An empty field with a real picker control (a date, a dropdown of known
  // choices, a checkbox) shows that control directly rather than a plain
  // "Add value" placeholder behind an extra click — there's nothing to type,
  // only something to pick, so showing the picker IS the affordance. Free-
  // text-shaped fields (text, currency, …) keep the click-to-edit "Add
  // value" placeholder, since a naked text input for every empty field
  // in a dense grid would be far noisier than a small dashed chip.
  const livePickerEmpty = !readOnly && empty && LIVE_PICKER_TYPES.has(field.type);

  /* --- read-only presentation ------------------------------------------- */
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
              {field.required ? 'Required' : 'Add value'}
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
    case 'long_text':
      return (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          defaultValue={String(value ?? '')}
          rows={3}
          className={inputClass}
          // Enter is a newline here. Escape still abandons, and Ctrl/Cmd+Enter
          // is the conventional "I am done" for a multi-line box.
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit(e.currentTarget.value);
            }
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      );

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
      return (
        <div className="rounded-md border border-line bg-white p-2 field-editing">
          <div className="flex flex-wrap gap-1.5">
            {opts.map((o) => {
              const on = current.has(o.stored);
              return (
                <button
                  key={o.stored}
                  type="button"
                  onClick={() => {
                    const next = new Set(current);
                    if (on) next.delete(o.stored);
                    else next.add(o.stored);
                    onChange([...next]);
                  }}
                  className={`rounded-full border px-2 py-[3px] text-[12px] font-semibold transition-colors duration-150 ${
                    on
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-line bg-white text-ink-500 hover:border-ink-400'
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
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
       * becomes 742) and cannot express "must be 8 or 9 digits". Digits only,
       * length checked against the field's own rule.
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
          onBlur={(e) => commit(e.currentTarget.value)}
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

    default:
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="text"
          defaultValue={String(value ?? '')}
          className={inputClass}
          onKeyDown={keyCommit}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      );
  }
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
  grantsVisibility,
  viewerId,
  viewerIsAdmin,
  onChange,
}: {
  ids: string[];
  readOnly: boolean;
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
  // A suspended account is never offered. An unknown id is not either — it is
  // already on the list, and there is nothing to offer.
  const addable = people.filter((p) => !chosen.has(p.id) && !p.suspended);

  const remove = (id: string) => onChange(ids.filter((x) => x !== id));
  const add = (id: string) => {
    if (!id || chosen.has(id)) return;
    onChange([...ids, id]);
  };

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
    <div className="space-y-1.5 py-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((p) => {
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
            <span
              key={p.id}
              className={`inline-flex items-center gap-1.5 rounded-full border py-[3px] pl-[3px] pr-1.5 text-[12.5px] ${
                p.unknown || p.suspended
                  ? 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
                  : 'border-line bg-white text-ink-700'
              }`}
            >
              <PersonAvatar person={p} size={18} />
              <span className="max-w-[160px] truncate font-medium">{p.name}</span>
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
                className="ml-0.5 grid size-4 place-items-center rounded-full text-ink-400 transition-colors hover:bg-canvas hover:text-bad"
              >
                <Icon name="x" size={10} strokeWidth={2.5} />
              </button>
            </span>
          );
        })}

        {selected.length === 0 ? (
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
        {addable.length ? (
          <span
            className={`relative inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-[3px] text-[12.5px] font-medium transition-colors ${
              grantsVisibility
                ? 'border-warn/60 text-warn hover:border-warn hover:bg-warn-bg/40'
                : 'border-line text-brand-700 hover:border-brand-600 hover:bg-brand-50'
            }`}
          >
            <Icon name="plus" size={11} strokeWidth={2.4} />
            Add team member
            <select
              aria-label="Add a team member"
              value=""
              onChange={(e) => {
                add(e.currentTarget.value);
                e.currentTarget.value = '';
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="">Add team member…</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {/* The email is what makes two people with the same (or no)
                      display name distinguishable — picking the wrong one here
                      grants the wrong person sight of the record. */}
                  {p.email && p.email !== p.name ? `${p.name} — ${p.email}` : p.name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="text-[11px] text-ink-400">Everyone available is already assigned.</span>
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

  if (readOnly) {
    return (
      <div className="px-2 py-1.5 text-[13.5px] text-ink-400">
        {value ? splitSummary(split, field.choices ?? []) : '—'}
      </div>
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

  return (
    <div className="rounded-lg border border-line bg-white p-2">
      <div className="space-y-1">
        {parts.map((p) => (
          <div key={p.stored} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-700">{p.label}</span>
            <div className="flex items-center gap-1">
              <NumberInput
                min={0}
                max={100}
                align="right"
                value={split[p.stored] ?? 0}
                onLiveChange={(n) => set(p.stored, n ?? 0)}
                className="w-16 rounded-md border border-line px-2 py-1 text-[13px] outline-none transition-colors focus-field"
              />
              <span className="w-3 text-[12px] text-ink-400">%</span>
            </div>
            {/* A bar makes the proportions readable without doing arithmetic. */}
            <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-canvas sm:block">
              <span
                className="block h-full rounded-full bg-brand-600 transition-[width] duration-200"
                style={{ width: `${Math.min(100, split[p.stored] ?? 0)}%` }}
              />
            </span>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
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
        {!balanced ? (
          <button
            type="button"
            onClick={balance}
            className="text-[12px] font-semibold text-brand-700 hover:underline"
          >
            Balance to 100%
          </button>
        ) : null}
      </div>
    </div>
  );
}

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

  if (readOnly) {
    const empty = !value.street && !value.city && !value.state && !value.zip;
    return (
      <div className="px-2 py-1.5 text-[13.5px] leading-relaxed text-ink-400">
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

  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-white p-2">
      <input
        type="text"
        placeholder="Street address"
        value={local.street}
        onChange={(e) => set({ street: e.currentTarget.value })}
        className="w-full rounded-md border border-line px-2 py-1.5 text-[13.5px] outline-none transition-colors focus-field"
      />
      <div className="flex gap-1.5">
        <input
          type="text"
          placeholder="City"
          value={local.city}
          onChange={(e) => set({ city: e.currentTarget.value })}
          className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-[13.5px] outline-none transition-colors focus-field"
        />
        <select
          value={local.state}
          onChange={(e) => set({ state: e.target.value })}
          className="w-[68px] shrink-0 rounded-md border border-line px-1 py-1.5 text-[13.5px] outline-none transition-colors focus-field"
        >
          <option value="">State</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>{s.code}</option>
          ))}
        </select>
        <input
          type="text"
          inputMode="numeric"
          placeholder="ZIP"
          value={local.zip}
          onChange={(e) => set({ zip: e.currentTarget.value })}
          className={`w-[84px] shrink-0 rounded-md border px-2 py-1.5 text-[13.5px] outline-none transition-colors focus-field ${
            zipValid ? 'border-line' : 'border-bad/50'
          }`}
        />
      </div>
      {!zipValid ? <p className="text-[11px] text-bad">ZIP should be 5 digits, or 5+4 (12345-6789).</p> : null}
      <p className="text-[11px] text-ink-400">{local.country || 'United States'} — USA only, for now</p>
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
          {String(value)}
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
      return <OutlineChip>{choiceLabel(options, value)}</OutlineChip>;
    case 'long_text':
      return <span className="block whitespace-pre-wrap leading-relaxed">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}
