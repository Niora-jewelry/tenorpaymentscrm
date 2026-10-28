'use client';

/**
 * Two small controls the Updates, Cases and tab-notes panels share
 * (Permissions spec: "Updates, cases and tab notes"):
 *
 *   ShareItem   "See all + grant": give one item to a person or a user type,
 *               and see / remove who it was given to. Only people who can
 *               already open the record are offered — the database refuses
 *               anyone else anyway.
 *   HideReply   On your own reply: hide it from specific people.
 *
 * The record's data arrives once through `ItemAccessProvider`.
 */
import { createContext, useContext, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { PersonAvatar, usePeopleById } from '@/proto/ui/people';
import { grantItemAccessAction, revokeItemAccessAction, setReplyHiddenAction } from './actions';

type ItemKind = 'case' | 'update' | 'note';
type ReplyKind = 'update' | 'case_reply';

export type ItemAccessProps = {
  grants: { id: string; kind: ItemKind; itemId: string; userId: string | null; userType: string | null }[];
  hiddenByMe: Record<string, string[]>;
  canGrant: Record<ItemKind, boolean>;
  openers: string[];
  viewerId: string;
};

const USER_TYPES: { key: string; label: string }[] = [
  { key: 'super_admin', label: 'Super admin' },
  { key: 'admin', label: 'Admin' },
  { key: 'underwriter', label: 'Underwriter' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'customer_service', label: 'Customer service' },
  { key: 'sales_agent', label: 'Sales agent' },
];

const Ctx = createContext<ItemAccessProps | null>(null);

export function ItemAccessProvider({ value, children }: { value: ItemAccessProps; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const chip =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold transition-colors';

export function ShareItem({ kind, itemId }: { kind: ItemKind; itemId: string }) {
  const access = useContext(Ctx);
  const router = useRouter();
  const byId = usePeopleById();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const mine = useMemo(() => (access?.grants ?? []).filter((g) => g.kind === kind && g.itemId === itemId), [access, kind, itemId]);
  if (!access || !access.canGrant[kind]) return null;

  const granted = new Set(mine.map((g) => g.userId).filter(Boolean));
  const grantedTypes = new Set(mine.map((g) => g.userType).filter(Boolean));
  const people = access.openers.filter((id) => id !== access.viewerId && !granted.has(id));

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'That did not work.');
      else router.refresh();
    });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Give someone access to this one item"
        onClick={() => setOpen((o) => !o)}
        className={`${chip} ${mine.length ? 'bg-brand-50 text-brand-700 hover:bg-brand-100' : 'text-ink-400 hover:bg-canvas hover:text-ink-700'}`}
      >
        <Icon name="users-round" size={11} />
        {mine.length ? `Shared · ${mine.length}` : 'Share'}
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={300} role="dialog" label="Share this item">
        <div className="px-2 pb-1 pt-1">
          <p className="text-[12px] font-semibold text-ink-800">Give access to this one item</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-400">
            For people who would not otherwise see it. Only people who can open this record are listed.
          </p>
        </div>
        {mine.length ? (
          <ul className="mt-1 border-t border-line-faint px-1 pt-1">
            {mine.map((g) => {
              const person = g.userId ? byId.get(g.userId) : null;
              return (
                <li key={g.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] text-ink-800">
                  {person ? <PersonAvatar person={{ ...person, unknown: false }} size={18} /> : <Icon name="users" size={13} className="text-ink-400" />}
                  <span className="min-w-0 flex-1 truncate">
                    {person ? person.name : `Everyone who is ${USER_TYPES.find((t) => t.key === g.userType)?.label ?? g.userType}`}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove this access"
                    disabled={pending}
                    onClick={() => run(() => revokeItemAccessAction(g.id))}
                    className="grid size-5 place-items-center rounded text-ink-400 hover:bg-bad-bg hover:text-bad"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="mt-1 grid gap-1.5 border-t border-line-faint px-2 pb-1 pt-2">
          <select
            aria-label="Give access to a person"
            value=""
            disabled={pending || people.length === 0}
            onChange={(e) => e.target.value && run(() => grantItemAccessAction({ kind, itemId, userId: e.target.value }))}
            className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[12.5px] outline-none focus-field"
          >
            <option value="">{people.length ? 'Add a person…' : 'Everyone who can open it already has access'}</option>
            {people.map((id) => (
              <option key={id} value={id}>{byId.get(id)?.name ?? 'Someone'}</option>
            ))}
          </select>
          <select
            aria-label="Give access to a user type"
            value=""
            disabled={pending}
            onChange={(e) => e.target.value && run(() => grantItemAccessAction({ kind, itemId, userType: e.target.value }))}
            className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[12.5px] outline-none focus-field"
          >
            <option value="">Add a user type…</option>
            {USER_TYPES.filter((t) => !grantedTypes.has(t.key)).map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          {error ? <p role="alert" className="text-[11.5px] text-bad">{error}</p> : null}
        </div>
      </MenuSurface>
    </>
  );
}

export function HideReply({ kind, replyId, authorId }: { kind: ReplyKind; replyId: string; authorId: string }) {
  const access = useContext(Ctx);
  const router = useRouter();
  const byId = usePeopleById();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = access?.hiddenByMe[`${kind}:${replyId}`] ?? [];
  const [picked, setPicked] = useState<string[]>(saved);

  if (!access || authorId !== access.viewerId) return null;
  const people = access.openers.filter((id) => id !== access.viewerId);

  const save = () =>
    start(async () => {
      setError(null);
      const r = await setReplyHiddenAction({ kind, replyId, userIds: picked });
      if (!r.ok) setError(r.message ?? 'That did not work.');
      else {
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Hide this reply from specific people"
        onClick={() => {
          setPicked(saved);
          setOpen((o) => !o);
        }}
        className={`${chip} ${saved.length ? 'bg-warn-bg text-warn' : 'text-ink-400 hover:bg-canvas hover:text-ink-700'}`}
      >
        <Icon name="eye-off" size={11} />
        {saved.length ? `Hidden from ${saved.length}` : 'Hide from…'}
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={280} role="dialog" label="Hide this reply">
        <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-snug text-ink-400">
          Ticked people won&rsquo;t see this reply. Everyone else who sees the item still does.
        </p>
        <ul className="max-h-[260px] overflow-y-auto">
          {people.map((id) => {
            const person = byId.get(id);
            const on = picked.includes(id);
            return (
              <li key={id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-ink-800 hover:bg-canvas">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setPicked((p) => (on ? p.filter((x) => x !== id) : [...p, id]))}
                    className="size-3.5 accent-[#1d4ed8]"
                  />
                  {person ? <PersonAvatar person={{ ...person, unknown: false }} size={18} /> : null}
                  <span className="min-w-0 flex-1 truncate">{person?.name ?? 'Someone'}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {error ? <p role="alert" className="px-2 text-[11.5px] text-bad">{error}</p> : null}
        <div className="mt-1 flex justify-end gap-2 border-t border-line-faint px-2 pt-1.5">
          <button type="button" onClick={() => setOpen(false)} className="rounded px-1.5 py-1 text-[12px] font-semibold text-ink-500 hover:bg-canvas">
            Cancel
          </button>
          <button type="button" disabled={pending} onClick={save} className="rounded px-1.5 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-50">
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </MenuSurface>
    </>
  );
}
