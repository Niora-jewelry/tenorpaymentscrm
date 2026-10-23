'use client';

/**
 * The strip across the top of Email: one chip per mailbox this person can
 * open, "All inboxes" first, and — for admins — a menu of the mailboxes other
 * people connected, grouped by who connected them.
 *
 * Picking a chip is nothing more than selecting that mailbox's Inbox: a
 * folder id already names its mailbox, so the URL (`?f=`) and everything that
 * reads it are unchanged. The left pane then shows only that mailbox's
 * folders (`FolderPane`).
 *
 * The client asked for exactly this (22 Oct 2026): "across the top there
 * should be a bar with all the mailboxes… depending on which mailbox I click
 * I'll see its folders on the left… other users' mailboxes in a drop-down."
 */
import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { CountPill, OutlineChip } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import type { MailboxView } from '@/lib/mail/viewTypes';
import { UserAvatar } from '../../[module]/UserAvatar';
import { HEALTH_HINT } from './FolderPane';
import { inboxOf, mailboxFor, type Selection } from './selection';
import { swatchFor } from './people';

export function MailboxBar({
  mailboxes,
  selection,
  onPickMailbox,
  onPickAll,
}: {
  mailboxes: MailboxView[];
  selection: Selection;
  onPickMailbox: (mailboxId: string) => void;
  onPickAll: () => void;
}) {
  const own = mailboxes.filter((m) => m.own);
  const team = mailboxes.filter((m) => !m.own);
  const active = mailboxFor(selection, mailboxes);
  const allUnread = own.reduce((n, m) => n + (inboxOf(m)?.unread ?? 0), 0);
  const activeTeam = active && !active.own ? active : null;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  /* Team mailboxes by the person who connected them; one with several
     connectors appears under each, so nobody's mailbox goes missing. */
  const groups = useMemo(() => {
    const byOwner = new Map<string, { id: string; name: string; boxes: MailboxView[] }>();
    for (const m of team) {
      const owners = m.owners?.length ? m.owners : [{ id: '', name: 'Unknown user' }];
      for (const o of owners) {
        const g = byOwner.get(o.id) ?? { id: o.id, name: o.name, boxes: [] };
        g.boxes.push(m);
        byOwner.set(o.id, g);
      }
    }
    return Array.from(byOwner.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [team]);

  if (!own.length && !team.length) return null;

  return (
    <div role="toolbar" aria-label="Mailboxes" className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-white px-3 py-2">
      {own.length ? (
        <Chip pressed={selection.kind === 'all'} onClick={onPickAll} title="Every own Inbox, together">
          <Icon name="inbox" size={13} className="shrink-0" />
          All inboxes
          {allUnread > 0 ? <CountPill n={allUnread} active={selection.kind === 'all'} /> : null}
        </Chip>
      ) : null}

      {own.map((m) => {
        const pressed = active?.id === m.id;
        const unread = inboxOf(m)?.unread ?? 0;
        const hint = HEALTH_HINT[m.health];
        return (
          <Chip key={m.id} pressed={pressed} onClick={() => onPickMailbox(m.id)} title={m.address}>
            <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: swatchFor(m.address).dot }} />
            <span className="max-w-[18ch] truncate">{m.displayName || m.address.split('@')[0]}</span>
            {m.kind === 'shared' ? <OutlineChip>Shared</OutlineChip> : null}
            {unread > 0 ? <CountPill n={unread} active={pressed} /> : null}
            {hint ? <span title={hint.label} aria-label={hint.label} className={`size-2 shrink-0 rounded-full ${hint.tone}`} /> : null}
          </Chip>
        );
      })}

      {team.length ? (
        <>
          {own.length ? <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" /> : null}
          <Chip
            ref={menuAnchor}
            pressed={Boolean(activeTeam)}
            onClick={() => setMenuOpen((o) => !o)}
            title="Mailboxes other people connected"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Icon name="users-round" size={13} className="shrink-0" />
            <span className="max-w-[22ch] truncate">{activeTeam ? activeTeam.displayName || activeTeam.address : 'Other mailboxes'}</span>
            <Icon name="chevron-down" size={12} className={`shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </Chip>
          <MenuSurface open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuAnchor} align="left" width={320} label="Other mailboxes">
            {groups.map((g) => (
              <div key={g.id || g.name} className="py-1">
                <p className="flex items-center gap-2 px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[.08em] text-ink-400">
                  {g.id ? <UserAvatar userId={g.id} name={g.name} size={16} /> : null}
                  {g.name}
                </p>
                {g.boxes.map((m) => {
                  const unread = inboxOf(m)?.unread ?? 0;
                  return (
                    <button
                      key={`${g.id}:${m.id}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onPickMailbox(m.id);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-canvas ${active?.id === m.id ? 'bg-canvas font-semibold text-ink-900' : 'text-ink-800'}`}
                    >
                      <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: swatchFor(m.address).dot }} />
                      <span className="min-w-0 flex-1 truncate">{m.address}</span>
                      {m.kind === 'shared' ? <OutlineChip>Shared</OutlineChip> : null}
                      {unread > 0 ? <CountPill n={unread} /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </MenuSurface>
        </>
      ) : null}
    </div>
  );
}

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

const Chip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; children: ReactNode }>(function Chip(
  { pressed, children, className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed}
      {...rest}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${
        pressed ? 'border-ink-900 bg-ink-900 text-white' : 'border-line bg-white text-ink-700 hover:border-ink-300 hover:text-ink-900'
      } ${className}`}
    >
      {children}
    </button>
  );
});
