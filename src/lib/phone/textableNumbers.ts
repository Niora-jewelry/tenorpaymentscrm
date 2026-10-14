/**
 * Which numbers on a record can a text actually be sent to?
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 * The drawer's text box took its destination from `replyTarget()`: the last
 * message or call on the record, and nothing else. So a merchant who had
 * never phoned or texted first could not be texted at all — the box said
 * "No phone number on this record yet" while their number sat in plain sight
 * two tabs away. Reply-only is a reasonable thing to have built; it is not a
 * reasonable thing to ship to a business whose whole use is reaching out.
 *
 * ── WHY ONLY SYNC-ENABLED FIELDS ─────────────────────────────────────────
 * Inbound texts land on a record by matching the sender against phone fields
 * marked `sync` — that is what `resolve_record_by_phone` looks at, and only
 * that. Texting FROM a field that is not sync'd would send fine and then drop
 * the reply onto no record at all: the rep sees their own message in the
 * thread, the merchant answers, and the answer is nowhere. A one-way
 * conversation is worse than a blocked one, because nobody is told.
 *
 * So the rule here is the same rule the inbound side already uses. Today that
 * means a contact's or an owner's phone, and not Fax or Affiliate main phone
 * — which is also what the empty-state text has always said, and is why the
 * fix is to find those numbers rather than to relax the rule.
 *
 * ── PERMISSIONS NEED NO MENTION HERE ─────────────────────────────────────
 * This reads the tab payload the drawer was given, and a field the viewer may
 * not see never reaches it — absent from the query, not hidden in the client.
 * A number this function cannot see is a number that viewer cannot text.
 */
import type { Field as ProtoField } from '@/proto/schema';

/** One number a text can be sent to, with enough context to choose between them. */
export type TextableNumber = {
  e164: string;
  /** "James Kowalski" where the group names its instances, else the field label. */
  who: string;
  /** "Contact", "Owner" — where it came from, for when two people share a record. */
  source: string;
};

type RepeatSchemaEntry = { key: string; label: string; type: ProtoField['type']; sync?: boolean };

export type TextableSource = {
  /** Top-level fields on this subtab. */
  fields: ProtoField[];
  /** Repeat groups, each with its schema and the instances held on the record. */
  groups: {
    key: string;
    label: string;
    schema: RepeatSchemaEntry[];
    values: Record<string, unknown>[];
  }[];
};

/** A name for an instance, from whichever of its sub-fields looks like one. */
function instanceName(instance: Record<string, unknown>, fallback: string): string {
  for (const key of ['name', 'full_name', 'contact_name', 'owner_name']) {
    const v = instance[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}

/**
 * Every number on this record a text may be sent to, in the order they appear.
 *
 * Deduplicated by number: one person listed as both a contact and an owner is
 * one destination, not a choice between two identical-looking rows.
 */
export function textableNumbers(
  sources: TextableSource[],
  values: Record<string, unknown>,
): TextableNumber[] {
  const out: TextableNumber[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown, who: string, source: string) => {
    if (typeof raw !== 'string') return;
    const e164 = raw.trim();
    // Already stored normalised by the write path; anything else is not a
    // number this can safely text, so it is left out rather than guessed at.
    if (!/^\+[1-9]\d{7,14}$/.test(e164) || seen.has(e164)) return;
    seen.add(e164);
    out.push({ e164, who, source });
  };

  for (const { fields, groups } of sources) {
    for (const field of fields) {
      if (field.type !== 'phone' || !field.sync || field.repeatGroup) continue;
      add(values[field.id], field.label, field.label);
    }

    for (const group of groups) {
      const phoneKeys = group.schema.filter((s) => s.type === 'phone' && s.sync).map((s) => s.key);
      if (phoneKeys.length === 0) continue;
      group.values.forEach((instance, i) => {
        for (const key of phoneKeys) {
          add(instance[key], instanceName(instance, `${group.label} ${i + 1}`), group.label);
        }
      });
    }
  }

  return out;
}
