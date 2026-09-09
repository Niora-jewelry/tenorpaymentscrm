/**
 * Input schemas for a display module's own Server Actions — the records half of
 * what `adminSchemas.ts` does for the Admin Panel.
 *
 * Same posture, same reason (CLAUDE.md §6): parse at the server boundary, let
 * the parsed type BE the input type. This file exists because `createRecord`
 * grew a second argument that is a permission — the list of people who land on
 * the new record's team, and therefore the list of people who can read it — and
 * `createRecordAction` was still reading its one field with a raw
 * `String(formData.get(...))`.
 *
 * Not merged into `adminSchemas.ts`: that module is imported by Admin-only
 * client components for its runtime lists (`FIELD_TYPES`, `SWATCHES`), and a
 * records-side schema has no business travelling with them.
 */
import { z } from 'zod';

const uuid = z.string().uuid('Invalid id.');

/**
 * `dealName` carries the client's own uniqueness rule only as far as "not
 * blank". The actual guarantee is the partial unique index on
 * `lower(btrim(deal_name))`, which also holds against direct SQL — a copy here
 * could only check what one stale screen believed.
 *
 * `memberIds` is ADDITIVE and the creator is not in it: `createRecord` puts
 * itself at the head of the list unconditionally, because the AFTER INSERT
 * trigger that grants visibility reads this value and the creator has to be able
 * to see the row it just wrote. A request that names the creator anyway is not
 * an error — it is deduplicated.
 *
 * The cap is a sanity bound on a public endpoint, not a client rule: nothing in
 * the specification limits a record's team, and 200 is far past any real one.
 */
export const createRecordSchema = z.object({
  dealName: z.string().trim().min(1, 'Deal Name is required.').max(200, 'Deal Name must be 200 characters or fewer.'),
  memberIds: z.array(uuid).max(200, 'That is more people than one record can be assigned to.').default([]),
});

export type CreateRecordInput = z.infer<typeof createRecordSchema>;
