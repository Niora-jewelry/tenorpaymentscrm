'use client';

/**
 * Automation locks and hides in the drawer: the icon on an item, what it says on
 * hover, and Unlock / Unhide / Re-lock / Re-hide for the people the action named.
 *
 * Everything here is what the server already decided this viewer may know (see
 * `restrictionsFor`): the fields a hide takes away never reach this page at all.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, Popover } from '@/proto/ui/kit';
import type { RestrictionMark, ViewerRestrictions } from '@/lib/records/restrictions';
import { liftRestrictionAction, reapplyRestrictionAction } from './restrictionActions';

type Ctx = { moduleSlug: string; recordId: string; restrictions: ViewerRestrictions };
const RestrictionsContext = createContext<Ctx | null>(null);

export function RestrictionsProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <RestrictionsContext.Provider value={value}>{children}</RestrictionsContext.Provider>;
}

export function useRestrictions(): ViewerRestrictions {
  return useContext(RestrictionsContext)?.restrictions ?? { effects: {}, marks: [], noDownload: [] };
}

/** May this viewer download what's under these items? */
export function useDownloadAllowed(items: string[]): boolean {
  const { noDownload } = useRestrictions();
  return !items.some((i) => noDownload.includes(i));
}

/** Is any of these items locked or hidden for this viewer? */
export function useEffectOn(items: string[]): 'lock' | 'hide' | null {
  const { effects } = useRestrictions();
  if (items.some((i) => effects[i] === 'hide')) return 'hide';
  return items.some((i) => effects[i] === 'lock') ? 'lock' : null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const sentence = (m: RestrictionMark) => `${m.kind === 'lock' ? 'Locked' : 'Hidden'} by Automation: ${m.automationName}, ${when(m.appliedAt)}`;

/**
 * The icon on one item. A lock is shown to everyone who can see the item; a hide
 * only reaches the people it doesn't hide it from. Someone who may lift it gets a
 * click: what it covers, and the button.
 */
export function RestrictionMarks({ item, size = 11 }: { item: string; size?: number }) {
  const ctx = useContext(RestrictionsContext);
  const marks = (ctx?.restrictions.marks ?? []).filter((m) => m.item === item && !m.lifted);
  if (!ctx || !marks.length) return null;
  // One icon per kind: two automations locking the same item are one lock to lift.
  const kinds = [...new Set(marks.map((m) => m.kind))];
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      {kinds.map((kind) => (
        <Mark key={kind} ctx={ctx} kind={kind} marks={marks.filter((m) => m.kind === kind)} size={size} />
      ))}
    </span>
  );
}

function Mark({ ctx, kind, marks, size }: { ctx: Ctx; kind: 'lock' | 'hide'; marks: RestrictionMark[]; size: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = marks.map(sentence).join('\n');
  // Set after hydration: the time is the viewer's own, which the server can't know.
  useEffect(() => {
    if (ref.current) ref.current.title = text;
  }, [text]);

  const icon = (
    <span
      ref={ref}
      role="img"
      aria-label={kind === 'lock' ? 'Locked by an automation' : 'Hidden by an automation'}
      className={`grid place-items-center rounded ${kind === 'lock' ? 'text-[#8a5a09]' : 'text-[#5b3fa8]'}`}
    >
      <Icon name={kind === 'lock' ? 'lock' : 'eye-off'} size={size} />
    </span>
  );
  if (!marks.some((m) => m.canLift)) return icon;
  return (
    <Popover width={290} trigger={() => icon}>
      {(close) => <LiftPanel ctx={ctx} kind={kind} marks={marks} close={close} />}
    </Popover>
  );
}

function LiftPanel({ ctx, kind, marks, close }: { ctx: Ctx; kind: 'lock' | 'hide'; marks: RestrictionMark[]; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = [...new Set(marks.flatMap((m) => m.batchItems))];
  const verb = kind === 'lock' ? 'Unlock' : 'Unhide';
  const lift = async () => {
    setBusy(true);
    setError(null);
    const result = await liftRestrictionAction({ moduleSlug: ctx.moduleSlug, recordId: ctx.recordId, item: marks[0]!.item, kind });
    setBusy(false);
    if (!result.ok) setError(result.message ?? `Could not ${verb.toLowerCase()} that.`);
    else close();
  };
  return (
    <div className="space-y-2 p-2 text-[12.5px] text-ink-700">
      {marks.map((m) => (
        <p key={m.batchId} className="text-ink-500">{sentence(m)}</p>
      ))}
      <p>
        {verb} {items.length === 1 ? 'this' : 'these'} for everyone on this record, in every module:
      </p>
      <ul className="list-disc space-y-0.5 pl-4 font-medium text-ink-900">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
      {error ? <p role="alert" className="text-[11.5px] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="primary" loading={busy} loadingLabel={`${verb}ing…`} onClick={() => void lift()}>
          {verb}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Above the tabs, for anyone who lifted something by hand or could have: put it
 * back exactly as the automation left it.
 */
export function ReapplyBar() {
  const ctx = useContext(RestrictionsContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  // The server sends lifted rows only to people who may put them back.
  const lifted = new Map<string, RestrictionMark>();
  for (const m of ctx.restrictions.marks) if (m.lifted && !lifted.has(m.batchId)) lifted.set(m.batchId, m);
  if (!lifted.size) return null;

  const reapply = async (m: RestrictionMark) => {
    setBusy(m.batchId);
    setError(null);
    const result = await reapplyRestrictionAction({ moduleSlug: ctx.moduleSlug, recordId: ctx.recordId, batchId: m.batchId });
    setBusy(null);
    if (!result.ok) setError(result.message ?? 'Could not put that back.');
  };

  return (
    <div className="mt-3 space-y-1.5">
      {[...lifted.values()].map((m) => (
        <div key={m.batchId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-canvas/60 px-3 py-1.5 text-[12.5px]">
          <Icon name={m.kind === 'lock' ? 'lock' : 'eye-off'} size={12} className="shrink-0 text-ink-400" />
          <span className="min-w-0 flex-1 text-ink-700">
            {m.kind === 'lock' ? 'Unlocked' : 'Unhidden'}: <span className="font-medium text-ink-900">{m.batchItems.join(', ')}</span>
            <span className="text-ink-400"> · from Automation: {m.automationName}</span>
          </span>
          <Button size="sm" variant="ghost" icon={m.kind === 'lock' ? 'lock' : 'eye-off'} loading={busy === m.batchId} loadingLabel="Putting back…" onClick={() => void reapply(m)}>
            {m.kind === 'lock' ? 'Re-lock' : 'Re-hide'}
          </Button>
        </div>
      ))}
      {error ? <p role="alert" className="text-[11.5px] text-danger">{error}</p> : null}
    </div>
  );
}
