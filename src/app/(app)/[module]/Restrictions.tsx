'use client';

/**
 * Automation locks and hides in the drawer: the icon on an item, what it says on
 * hover, and Unlock / Unhide / Re-lock / Re-hide for the people the action named.
 *
 * Everything here is what the server already decided this viewer may know (see
 * `restrictionsFor`): the fields a hide takes away never reach this page at all.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
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
  return <LiftPopup ctx={ctx} kind={kind} marks={marks} icon={icon} />;
}

const POPUP_WIDTH = 300;
const EDGE = 12;

/**
 * Over the page rather than inside the item: a tab's icon sits in a strip that
 * scrolls sideways, and a field's can be at the drawer's edge, either of which
 * would cut a panel off. Placed from the icon, and kept on screen.
 */
function LiftPopup({ ctx, kind, marks, icon }: { ctx: Ctx; kind: 'lock' | 'hide'; marks: RestrictionMark[]; icon: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const close = () => setAt(null);

  const open = () => {
    const r = trigger.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - EDGE - 6;
    const above = r.top - EDGE - 6;
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - POPUP_WIDTH - EDGE));
    setAt(below >= 280 || below >= above
      ? { left, top: r.bottom + 6, maxHeight: below }
      : { left, bottom: window.innerHeight - r.top + 6, maxHeight: above });
  };

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setAt(null);
    };
    // Caught on the way down, so Escape closes this and not the drawer under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAt(null);
    };
    // It is placed once, so it goes when what it points at moves.
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) setAt(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={Boolean(at)}
        aria-label={kind === 'lock' ? 'Choose what to unlock' : 'Choose what to unhide'}
        onClick={() => (at ? close() : open())}
        className="block rounded p-0.5 hover:bg-canvas"
      >
        {icon}
      </button>
      {at
        ? createPortal(
            <div
              ref={panel}
              role="dialog"
              aria-label={kind === 'lock' ? 'Unlock' : 'Unhide'}
              style={{ position: 'fixed', zIndex: 200, width: POPUP_WIDTH, left: at.left, top: at.top, bottom: at.bottom, maxHeight: at.maxHeight }}
              className="overflow-y-auto rounded-xl border border-line bg-white shadow-[0_8px_28px_rgba(8,32,47,.18)]"
            >
              <LiftPanel ctx={ctx} kind={kind} marks={marks} close={close} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function LiftPanel({ ctx, kind, marks, close }: { ctx: Ctx; kind: 'lock' | 'hide'; marks: RestrictionMark[]; close: () => void }) {
  const clicked = marks[0]!.item;
  // What the same automation covered, for the viewer to choose from: named, and theirs to lift.
  const batches = new Set(marks.map((m) => m.batchId));
  const choices = new Map<string, string>();
  for (const m of ctx.restrictions.marks) {
    if (!m.lifted && m.kind === kind && m.canLift && m.label && batches.has(m.batchId)) choices.set(m.item, m.label);
  }
  const [chosen, setChosen] = useState(() => new Set([clicked]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verb = kind === 'lock' ? 'Unlock' : 'Unhide';
  const toggle = (item: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(item);
      else next.delete(item);
      return next;
    });
  const allChosen = chosen.size === choices.size;
  const lift = async () => {
    setBusy(true);
    setError(null);
    const result = await liftRestrictionAction({ moduleSlug: ctx.moduleSlug, recordId: ctx.recordId, items: [...chosen], kind });
    setBusy(false);
    if (!result.ok) setError(result.message ?? `Could not ${verb.toLowerCase()} that.`);
    else close();
  };
  return (
    <div className="space-y-2 p-2 text-[12.5px] text-ink-700">
      {marks.map((m) => (
        <p key={m.batchId} className="text-ink-500">{sentence(m)}</p>
      ))}
      <p>Choose what to {verb.toLowerCase()}, for everyone on this record, in every module:</p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {[...choices].map(([item, label]) => (
          <li key={item}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-medium text-ink-900 hover:bg-canvas">
              <input type="checkbox" className="size-3.5 accent-[#1d4ed8]" checked={chosen.has(item)} onChange={(e) => toggle(item, e.target.checked)} />
              <span className="min-w-0 truncate">{label}</span>
            </label>
          </li>
        ))}
      </ul>
      {choices.size > 1 ? (
        <button
          type="button"
          onClick={() => setChosen(allChosen ? new Set() : new Set(choices.keys()))}
          className="text-[12px] font-semibold text-brand-700 hover:underline"
        >
          {allChosen ? 'Clear all' : 'Select all'}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-[11.5px] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="primary" disabled={!chosen.size} loading={busy} loadingLabel={`${verb}ing…`} onClick={() => void lift()}>
          {chosen.size > 1 ? `${verb} ${chosen.size}` : verb}
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
  const lifted = new Map<string, { mark: RestrictionMark; names: string[] }>();
  for (const m of ctx.restrictions.marks) {
    if (!m.lifted) continue;
    const entry = lifted.get(m.batchId) ?? { mark: m, names: [] };
    if (m.label && !entry.names.includes(m.label)) entry.names.push(m.label);
    lifted.set(m.batchId, entry);
  }
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
      {[...lifted.values()].map(({ mark: m, names }) => (
        <div key={m.batchId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-canvas/60 px-3 py-1.5 text-[12.5px]">
          <Icon name={m.kind === 'lock' ? 'lock' : 'eye-off'} size={12} className="shrink-0 text-ink-400" />
          <span className="min-w-0 flex-1 text-ink-700">
            {m.kind === 'lock' ? 'Unlocked' : 'Unhidden'}: <span className="font-medium text-ink-900">{names.join(', ')}</span>
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
