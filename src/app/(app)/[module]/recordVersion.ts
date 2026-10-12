'use client';

/**
 * The client-side owner of a record's compare-and-swap token, and the queue
 * that keeps writes to one record from racing each other.
 *
 * ═══ THE TWO BUGS THIS EXISTS TO FIX ══════════════════════════════════════
 *
 * `set_record_value` (migration 16) compares-and-swaps on `records.updated_at`
 * — ONE token for the whole record, not one per field. Every write must send
 * the exact token the row currently holds, and every successful write replaces
 * it. `RealFieldGrid` kept that token in component state, which broke it in two
 * separate, silent ways. Both presented identically to the user: the value was
 * typed, it appeared, and then it snapped back with "Someone else changed
 * this a moment ago" — with no-one else involved.
 *
 * ── 1. Two edits in flight at once ────────────────────────────────────────
 * `handleChange` read `updatedAt` from state at CALL time and then started an
 * async action. Editing a second field before the first response landed meant
 * both calls captured the SAME token, because state had not been updated yet.
 * The first write consumed it; the second arrived with a token the row no
 * longer had and lost the CAS. Filling a form out briskly — the single most
 * ordinary thing to do in this drawer — was enough to trigger it, and the edit
 * that lost was silently discarded.
 *
 * The queue below makes writes to one record strictly sequential, and each one
 * reads the token at the moment it actually STARTS rather than when it was
 * scheduled. The second write therefore uses the token the first one produced.
 *
 * ── 2. The token was thrown away on unmount ───────────────────────────────
 * `RealFieldGrid` seeded its state from the server-rendered `initialUpdatedAt`.
 * Switching to a non-field tab (Cases, Files, Updates) unmounts it, and coming
 * back re-seeds from that ORIGINAL server value — which every edit made since
 * has superseded. Because `setValueAction` deliberately skips `revalidatePath`
 * (see its own comment: a ~1.9s cost on the most frequent interaction in the
 * app), no fresh server render ever corrected it. So the first edit after a
 * round trip through another tab always lost the CAS.
 *
 * Keeping the token in a module-level store instead of component state means
 * unmounting a tab cannot lose it. The store outlives every component that
 * reads it, for as long as the page is open.
 *
 * ═══ WHY NEWEST-WINS IS THE RIGHT SEEDING RULE ════════════════════════════
 * `seed()` is called by every render with whatever the server just supplied.
 * It keeps the LATER of the two timestamps:
 *
 *   - Our own token is ahead when we have written since the last server render
 *     — the normal case, precisely because the write path skips revalidation.
 *   - The server's is ahead after a real navigation or refresh, including when
 *     the row moved on because someone else edited it.
 *
 * Taking the later of the two is correct in both directions. Blindly trusting
 * the server would reintroduce bug 2; blindly keeping ours would make a genuine
 * outside edit unrecoverable without a hard reload.
 *
 * A stale token is never a correctness risk in the dangerous direction: the
 * database rejects the write. The cost of getting this wrong is a false
 * conflict, not a lost overwrite — which is exactly why it stayed invisible.
 */

type RecordVersion = {
  /** The most recent `updated_at` we believe the row holds. */
  token: string;
  /** Every token the server has handed US, so a conflict caused by our own
   *  earlier write can be told apart from a genuine third-party edit. */
  ownTokens: Set<string>;
  /** Tail of the write chain for this record. Writes append to it. */
  queue: Promise<unknown>;
};

const versions = new Map<string, RecordVersion>();

/** Bounded so a long session opening hundreds of records cannot grow this
 *  without limit. Records are evicted oldest-first; an evicted record simply
 *  re-seeds from the server on its next render, which is the correct fallback. */
const MAX_TRACKED_RECORDS = 200;

function entry(recordId: string, initialToken: string): RecordVersion {
  let v = versions.get(recordId);
  if (!v) {
    if (versions.size >= MAX_TRACKED_RECORDS) {
      const oldest = versions.keys().next().value;
      if (oldest !== undefined) versions.delete(oldest);
    }
    v = { token: initialToken, ownTokens: new Set([initialToken]), queue: Promise.resolve() };
    versions.set(recordId, v);
  }
  return v;
}

/** Timestamps come from Postgres as ISO strings. Parsed rather than compared
 *  as text because the two sources can differ in fractional-second digits or
 *  offset spelling for the same instant. An unparseable value loses, so a
 *  malformed token can never displace a good one. */
function isNewer(candidate: string, current: string): boolean {
  const a = Date.parse(candidate);
  const b = Date.parse(current);
  if (Number.isNaN(a)) return false;
  if (Number.isNaN(b)) return true;
  return a > b;
}

/**
 * Register what the server just rendered. Safe to call on every render — it
 * only ever moves the token forward.
 */
export function seedRecordVersion(recordId: string, serverUpdatedAt: string): void {
  const v = entry(recordId, serverUpdatedAt);
  if (isNewer(serverUpdatedAt, v.token)) {
    v.token = serverUpdatedAt;
    v.ownTokens.add(serverUpdatedAt);
  }
}

/** The token a write should send right now. */
export function currentToken(recordId: string, fallback: string): string {
  return entry(recordId, fallback).token;
}

/** Record a token the server returned from a successful write. */
export function commitToken(recordId: string, updatedAt: string): void {
  const v = entry(recordId, updatedAt);
  v.ownTokens.add(updatedAt);
  if (isNewer(updatedAt, v.token)) v.token = updatedAt;
}

/**
 * Was this conflicting token produced by one of OUR OWN writes?
 *
 * If so the conflict is bookkeeping, not a real disagreement — nobody else
 * touched the record, our token was simply behind — and the caller may safely
 * retry against it. If not, someone else genuinely wrote first and the user has
 * to be told (§13.4: "the loser is told, both values shown").
 */
export function isOwnToken(recordId: string, token: string): boolean {
  return versions.get(recordId)?.ownTokens.has(token) ?? false;
}

/**
 * Runs `task` after every write already queued for this record has settled.
 *
 * `.catch(() => {})` on the tail is deliberate: a rejected write must not
 * poison the chain and silently swallow every later edit to the same record.
 * The caller still sees its own rejection — this only stops it propagating to
 * the NEXT queued write.
 */
export function enqueueWrite<T>(recordId: string, fallbackToken: string, task: () => Promise<T>): Promise<T> {
  const v = entry(recordId, fallbackToken);
  const run = v.queue.then(task, task);
  v.queue = run.catch(() => {});
  return run;
}

/**
 * Test-only reset. The store is module-level state by design — that is what
 * makes it survive a remount — so a test file needs a way to start from
 * nothing between cases. Not exported through any barrel and never called by
 * application code.
 */
export function __resetRecordVersionsForTest(): void {
  versions.clear();
  buffers.clear();
  liveValues.clear();
  valueListeners.clear();
  revisionByRecord.clear();
}

/* ==========================================================================
 * Coalescing writes
 * ========================================================================== */

/**
 * A field edit waiting to be sent.
 *
 * `encoded` is what goes on the wire; `previous` is what the cell held before
 * the optimistic change, so a failure can put it back.
 */
export type PendingEdit = {
  fieldKey: string;
  encoded: string | null;
  previous: unknown;
};

type Buffer = {
  /** Keyed by field, so editing the same field twice before a flush sends only
   *  the LAST value — and only one history row, which is what a person editing
   *  a cell twice in two seconds actually did. */
  edits: Map<string, PendingEdit>;
  timer: ReturnType<typeof setTimeout> | null;
};

const buffers = new Map<string, Buffer>();

/**
 * How long to wait for more edits before sending.
 *
 * The unit of work is a FIELD COMMIT, not a keystroke: text fields commit on
 * blur, pickers on selection. So this is only ever collecting the gap between
 * "tab out of one field" and "tab out of the next", which for someone filling a
 * form is well under a second.
 *
 * 350ms is long enough to gather a fast run of fields into one request, and
 * short enough that a single edit followed by a pause still feels immediate —
 * the round trip it saves is several times longer than the wait it adds.
 */
const COALESCE_MS = 350;

function buffer(recordId: string): Buffer {
  let b = buffers.get(recordId);
  if (!b) {
    b = { edits: new Map(), timer: null };
    buffers.set(recordId, b);
  }
  return b;
}

/**
 * Queue one field edit. `flush` is called with everything gathered.
 *
 * The flush runs through `enqueueWrite`, so batches to one record still go one
 * at a time — the compare-and-swap needs the previous batch's token before the
 * next can start. What changed is how MUCH each round trip carries.
 */
export function queueEdit(
  recordId: string,
  fallbackToken: string,
  edit: PendingEdit,
  flush: (edits: PendingEdit[]) => Promise<void>,
): boolean {
  const b = buffer(recordId);
  // Whether this field was ALREADY waiting decides the caller's in-flight
  // counter. Editing one field twice before a flush must not count as two
  // saves: the batch carries one entry for it, so the counter would be
  // decremented once and drift upward for the rest of the session, leaving
  // "Saving…" on screen forever.
  const isNew = !b.edits.has(edit.fieldKey);
  // The FIRST `previous` is the one worth keeping — it is the value the cell
  // held before this burst of editing began, which is what a rollback must
  // restore. A later edit's `previous` is an optimistic value that was never
  // saved.
  const existing = b.edits.get(edit.fieldKey);
  b.edits.set(edit.fieldKey, existing ? { ...edit, previous: existing.previous } : edit);

  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    b.timer = null;
    const batch = Array.from(b.edits.values());
    b.edits.clear();
    if (!batch.length) return;
    void enqueueWrite(recordId, fallbackToken, () => flush(batch));
  }, COALESCE_MS);

  return isNew;
}

/**
 * Send whatever is buffered right now, without waiting out the window.
 *
 * Called when the drawer is closing: a batch still sitting in the timer when
 * the component goes away would be silently dropped, and the user would have
 * seen it as saved.
 */
export function flushPendingEdits(
  recordId: string,
  fallbackToken: string,
  flush: (edits: PendingEdit[]) => Promise<void>,
): void {
  const b = buffers.get(recordId);
  if (!b || !b.edits.size) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  const batch = Array.from(b.edits.values());
  b.edits.clear();
  void enqueueWrite(recordId, fallbackToken, () => flush(batch));
}

/* ==========================================================================
 * The values a record is CURRENTLY showing
 * ========================================================================== */

/**
 * One record's field values as this page has them right now, shared by every
 * surface that renders them.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 * The client: "pricing model not syncing with header field".
 *
 * A field can appear twice in one drawer — once in the field grid and again
 * in the header strip above it (Pricing Model, Current Status, MID, MCC code
 * and the rest are all configured into both). Each kept its own React state,
 * so editing one left the other showing the old value.
 *
 * Nothing corrected it either, because `setValueAction` deliberately skips
 * `revalidatePath` — a ~1.9s cost on the most frequent interaction in the
 * app. So the stale copy stayed stale until a navigation or a reload, and
 * the record looked as though it disagreed with itself.
 *
 * This is the same shape of problem, and the same answer, as the token store
 * above it: the thing being shared is per-RECORD, not per-component, so it
 * lives outside the components. A save publishes here; every surface
 * subscribes and re-reads.
 *
 * Deliberately NOT a React context. The header strip and the field grid are
 * rendered by a server component with other server-rendered content between
 * them, so there is no client component that wraps both to hang a provider
 * from. A module-level store with `useSyncExternalStore` needs no common
 * ancestor and survives a tab remount, exactly as the token store does.
 */
const liveValues = new Map<string, Map<string, unknown>>();
const valueListeners = new Map<string, Set<() => void>>();

/** Announce a value this page has just set, optimistically or confirmed. */
export function publishValue(recordId: string, fieldKey: string, value: unknown): void {
  let m = liveValues.get(recordId);
  if (!m) {
    m = new Map();
    liveValues.set(recordId, m);
  }
  m.set(fieldKey, value);
  bumpRevision(recordId);
  for (const fn of valueListeners.get(recordId) ?? []) fn();
}

/**
 * What this page last set for a field, if anything.
 *
 * Returns a wrapper rather than the bare value so that "set to empty" can be
 * told apart from "never set" — clearing a field is a real edit and must win
 * over the server's older non-empty value.
 */
export function publishedValue(recordId: string, fieldKey: string): { has: boolean; value: unknown } {
  const m = liveValues.get(recordId);
  if (!m || !m.has(fieldKey)) return { has: false, value: undefined };
  return { has: true, value: m.get(fieldKey) };
}

/** Drop this page's overlay for a record, e.g. once a fresh server render has
 *  arrived carrying everything it knew. */
export function clearPublishedValues(recordId: string): void {
  if (!liveValues.delete(recordId)) return;
  bumpRevision(recordId);
  for (const fn of valueListeners.get(recordId) ?? []) fn();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeToValues(recordId: string, onChange: () => void): () => void {
  let set = valueListeners.get(recordId);
  if (!set) {
    set = new Set();
    valueListeners.set(recordId, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) valueListeners.delete(recordId);
  };
}

/** A counter that changes whenever anything about this record's values does.
 *  `useSyncExternalStore` needs a snapshot that is `Object.is`-stable between
 *  changes; the Map itself is mutated in place and so would never compare
 *  unequal. */
let valueRevision = 0;
const revisionByRecord = new Map<string, number>();

export function valuesSnapshot(recordId: string): number {
  return revisionByRecord.get(recordId) ?? 0;
}

/* Bump the revision from inside the two mutators above. Declared after them
   for readability; hoisting makes the call sites legal. */
function bumpRevision(recordId: string): void {
  revisionByRecord.set(recordId, ++valueRevision);
}
