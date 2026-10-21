'use client';

/**
 * Left pane: All inboxes, then each mailbox as a collapsible section with its
 * Outlook folder tree. Subfolder collapse state is remembered per browser.
 *
 * The selected folder is a raised white tile on the pane's canvas — the same
 * "lifted" language as the rest of the CRM's surfaces — rather than a tinted
 * band, so it reads at a glance even in a 200-folder tree.
 */
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Dialog, Popover } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { FolderView, Health, MailboxView } from '@/lib/mail/viewTypes';
import { FOLDER_ICON, folderBadge, swatchFor } from './people';
import type { Selection } from './selection';


const COLLAPSE_KEY = 'tapdash.mail.collapsed';
const COLLAPSE_EVENT = 'tapdash:mail-collapsed';

// Which folders are collapsed is a per-browser convenience in localStorage,
// read through useSyncExternalStore: the server renders everything expanded,
// the browser then applies what it remembers, with no hydration mismatch.
function readCollapsed(): string {
  try {
    return localStorage.getItem(COLLAPSE_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}
function subscribeCollapsed(cb: () => void) {
  window.addEventListener(COLLAPSE_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}
function parseCollapsed(raw: string): Set<string> {
  try {
    const v = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const HEALTH_HINT: Partial<Record<Health, { tone: string; label: string }>> = {
  setting_up: { tone: 'bg-brand-500', label: 'Setting up — first sync in progress' },
  throttled: { tone: 'bg-[#c07714]', label: 'Outlook is busy; syncing shortly' },
  needs_reconnect: { tone: 'bg-[#c07714]', label: 'Needs reconnect' },
  needs_permission: { tone: 'bg-[#c07714]', label: 'Needs one more permission' },
  stalled: { tone: 'bg-[#d33b41]', label: 'Stopped syncing' },
};

export type FolderOp =
  | { op: 'create'; mailboxId: string; parentId: string | null; name: string }
  | { op: 'rename'; mailboxId: string; folderId: string; name: string }
  | { op: 'delete'; mailboxId: string; folderId: string };

type DialogState =
  | { kind: 'create'; mailboxId: string; parentId: string | null; under: string }
  | { kind: 'rename'; folder: FolderView }
  | { kind: 'delete'; folder: FolderView; inBin: boolean };

export function FolderPane({
  mailboxes,
  selection,
  onSelect,
  canEdit,
  onFolderOp,
  onNewMail,
  scheduledCount = 0,
}: {
  onNewMail?: () => void;
  scheduledCount?: number;
  mailboxes: MailboxView[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Edit grant: folder menus appear. */
  canEdit: boolean;
  onFolderOp: (op: FolderOp) => void;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const menus: Menus | null = canEdit
    ? {
        create: (mailboxId, parent, mailboxName) =>
          setDialog({ kind: 'create', mailboxId, parentId: parent?.id ?? null, under: parent?.name ?? mailboxName }),
        rename: (folder) => setDialog({ kind: 'rename', folder }),
        remove: (folder, box) => {
          // Already inside Deleted Items? Then deleting is for good.
          const byId = new Map(box.folders.map((f) => [f.id, f]));
          let cur = folder.parentId ? byId.get(folder.parentId) : undefined;
          let inBin = false;
          for (let i = 0; cur && i < 32; i += 1) {
            if (cur.wellKnown === 'deleteditems') inBin = true;
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          }
          setDialog({ kind: 'delete', folder, inBin });
        },
      }
    : null;
  const raw = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => '[]');
  const collapsed = useMemo(() => parseCollapsed(raw), [raw]);
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    } catch {
      // private mode: the collapse just isn't remembered
    }
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  };

  const own = mailboxes.filter((m) => m.own);
  const team = mailboxes.filter((m) => !m.own);
  const allUnread = useMemo(
    () => own.reduce((n, m) => n + (m.folders.find((f) => f.wellKnown === 'inbox')?.unread ?? 0), 0),
    [own],
  );

  return (
    <nav aria-label="Mail folders" className="flex min-h-0 flex-col border-r border-line bg-canvas">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h1 className="text-[15px] font-semibold tracking-[-.01em] text-ink-900">Email</h1>
        <Link
          href="/email/settings"
          title="Email settings"
          aria-label="Email settings"
          className="grid size-7 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
        >
          <Icon name="cog" size={15} />
        </Link>
      </div>

      {onNewMail ? (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onNewMail}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim"
          >
            <Icon name="pencil" size={14} />
            New mail
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {own.length > 1 ? (
          <Row
            icon="inbox"
            label="All inboxes"
            badge={allUnread}
            active={selection.kind === 'all'}
            onClick={() => onSelect({ kind: 'all' })}
            depth={0}
          />
        ) : null}

        {scheduledCount > 0 || selection.kind === 'scheduled' ? (
          <Row
            icon="clock"
            label="Scheduled"
            badge={scheduledCount}
            badgeMuted
            active={selection.kind === 'scheduled'}
            onClick={() => onSelect({ kind: 'scheduled' })}
            depth={0}
          />
        ) : null}

        {own.map((m) => (
          <MailboxSection
            key={m.id}
            mailbox={m}
            selection={selection}
            onSelect={onSelect}
            collapsed={collapsed}
            toggle={toggle}
            menus={menus}
          />
        ))}

        {team.length ? (
          <>
            <p className="mt-5 flex items-center gap-1.5 px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[.12em] text-ink-400">
              <Icon name="users-round" size={12} />
              Team mailboxes
            </p>
            {team.map((m) => (
              <MailboxSection
                key={m.id}
                mailbox={m}
                selection={selection}
                onSelect={onSelect}
                collapsed={collapsed}
                toggle={toggle}
                startCollapsed
                menus={menus}
              />
            ))}
          </>
        ) : null}
      </div>

      {dialog?.kind === 'create' || dialog?.kind === 'rename' ? (
        <FolderNameDialog
          key={dialog.kind === 'rename' ? dialog.folder.id : `${dialog.mailboxId}:${dialog.parentId}`}
          title={dialog.kind === 'create' ? `New folder in ${dialog.under}` : `Rename ${dialog.folder.name}`}
          initial={dialog.kind === 'rename' ? dialog.folder.name : ''}
          confirm={dialog.kind === 'create' ? 'Create folder' : 'Rename'}
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            onFolderOp(
              dialog.kind === 'create'
                ? { op: 'create', mailboxId: dialog.mailboxId, parentId: dialog.parentId, name }
                : { op: 'rename', mailboxId: dialog.folder.mailboxId, folderId: dialog.folder.id, name },
            )
          }
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <Dialog
          title={dialog.inBin ? `Delete ${dialog.folder.name} for good?` : `Delete ${dialog.folder.name}?`}
          tone="danger"
          confirmLabel={dialog.inBin ? 'Delete for good' : 'Move to Deleted Items'}
          onConfirm={() => onFolderOp({ op: 'delete', mailboxId: dialog.folder.mailboxId, folderId: dialog.folder.id })}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog.inBin
              ? 'The folder and everything in it are removed from Outlook. This can’t be undone.'
              : 'The folder and its mail move to Deleted Items, the same as deleting it in Outlook. You can still restore it from there.'}
          </p>
        </Dialog>
      ) : null}

      <div className="border-t border-line px-3 py-2.5">
        <Link
          href="/email/settings"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink-500 transition-colors hover:bg-white hover:text-ink-900"
        >
          <Icon name="plus" size={14} />
          Connect a mailbox
        </Link>
      </div>
    </nav>
  );
}

function MailboxSection({
  mailbox,
  selection,
  onSelect,
  collapsed,
  toggle,
  startCollapsed = false,
  menus,
}: {
  mailbox: MailboxView;
  selection: Selection;
  onSelect: (s: Selection) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  startCollapsed?: boolean;
  menus: Menus | null;
}) {
  // Team mailboxes start closed; the stored set records the OPPOSITE of the default for them.
  const key = `mb:${mailbox.id}`;
  const closed = startCollapsed ? !collapsed.has(key) : collapsed.has(key);
  const hint = HEALTH_HINT[mailbox.health];
  const dot = swatchFor(mailbox.address).dot;
  const title = mailbox.displayName || mailbox.address.split('@')[0];

  // A folder is hidden when any ancestor is collapsed.
  const hidden = new Set<string>();
  for (const f of mailbox.folders) {
    if (f.parentId && (hidden.has(f.parentId) || collapsed.has(f.parentId))) hidden.add(f.id);
  }

  return (
    <section className="group/mb relative mt-3 first:mt-1">
      {menus ? (
        <button
          type="button"
          onClick={() => menus.create(mailbox.id, null, title)}
          title={`New folder in ${title}`}
          aria-label={`New folder in ${title}`}
          className="absolute right-1 top-1.5 z-[1] grid size-6 place-items-center rounded-md bg-canvas text-ink-400 opacity-0 transition-opacity hover:bg-white hover:text-ink-900 focus:opacity-100 group-hover/mb:opacity-100"
        >
          <Icon name="plus" size={13} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => toggle(key)}
        aria-expanded={!closed}
        className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/70"
        title={mailbox.address}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`shrink-0 text-ink-400 transition-transform duration-150 ${closed ? '' : 'rotate-90'}`}
        />
        <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: dot }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-ink-800">{title}</span>
          <span className="block truncate text-[11px] text-ink-400">{mailbox.address}</span>
        </span>
        {mailbox.kind === 'shared' ? (
          <span className="shrink-0 rounded-md border border-line bg-white px-1.5 py-px text-[10px] font-semibold uppercase tracking-[.06em] text-ink-500">
            Shared
          </span>
        ) : null}
        {hint ? (
          <span title={hint.label} aria-label={hint.label} className={`size-2 shrink-0 rounded-full ${hint.tone}`} />
        ) : null}
      </button>

      {closed ? null : mailbox.folders.length === 0 ? (
        <p className="px-3 py-2 pl-9 text-[12px] text-ink-400">
          {mailbox.health === 'setting_up' ? 'Fetching folders from Outlook…' : 'No folders yet.'}
        </p>
      ) : (
        <ul className="mt-0.5">
          {mailbox.folders.map((f) =>
            hidden.has(f.id) ? null : (
              <li key={f.id}>
                <FolderRow
                  folder={f}
                  active={selection.kind === 'folder' && selection.folderId === f.id}
                  open={!collapsed.has(f.id)}
                  onToggle={() => toggle(f.id)}
                  onSelect={() => onSelect({ kind: 'folder', folderId: f.id })}
                  menu={
                    menus ? (
                      <FolderMenu
                        folder={f}
                        onNew={() => menus.create(mailbox.id, f, title)}
                        onRename={() => menus.rename(f)}
                        onDelete={() => menus.remove(f, mailbox)}
                      />
                    ) : null
                  }
                />
              </li>
            ),
          )}
          {mailbox.folders.length && mailbox.health !== 'setting_up' ? (
            <li>
              <Link
                href={`/email/rules/${mailbox.id}`}
                className="mt-0.5 flex items-center gap-2 rounded-lg py-1.5 pl-9 pr-2.5 text-[12.5px] text-ink-400 transition-colors hover:bg-white/70 hover:text-ink-800"
              >
                <Icon name="sliders" size={13} className="shrink-0" />
                Rules
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

type Menus = {
  create: (mailboxId: string, parent: FolderView | null, mailboxName: string) => void;
  rename: (folder: FolderView) => void;
  remove: (folder: FolderView, box: MailboxView) => void;
};

function FolderMenu({ folder, onNew, onRename, onDelete }: { folder: FolderView; onNew: () => void; onRename: () => void; onDelete: () => void }) {
  const system = Boolean(folder.wellKnown);
  const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]';
  const run = (close: () => void, fn: () => void) => {
    close();
    fn();
  };
  return (
    <Popover
      width={210}
      align="right"
      trigger={() => (
        <span title={`Folder actions: ${folder.name}`} className="grid size-6 place-items-center rounded-md text-ink-400 hover:bg-canvas hover:text-ink-900">
          <Icon name="more-horizontal" size={14} />
          <span className="sr-only">Folder actions: {folder.name}</span>
        </span>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={`${folder.name} actions`}>
          <button type="button" role="menuitem" className={`${item} text-ink-700 hover:bg-canvas`} onClick={() => run(close, onNew)}>
            <Icon name="plus" size={14} className="text-ink-400" /> New subfolder
          </button>
          {system ? (
            <p className="px-2 pb-1 pt-1.5 text-[11.5px] leading-snug text-ink-400">Outlook system folders can’t be renamed or deleted.</p>
          ) : (
            <>
              <button type="button" role="menuitem" className={`${item} text-ink-700 hover:bg-canvas`} onClick={() => run(close, onRename)}>
                <Icon name="pencil" size={14} className="text-ink-400" /> Rename
              </button>
              <button type="button" role="menuitem" className={`${item} text-[#b02a30] hover:bg-[#fce9ea]`} onClick={() => run(close, onDelete)}>
                <Icon name="trash" size={14} /> Delete folder
              </button>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

const BAD_NAME = /[\\/]/;

function FolderNameDialog({
  title,
  initial,
  confirm,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  confirm: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const clean = name.trim();
  const problem = !clean ? null : clean.length > 255 ? 'Up to 255 characters.' : BAD_NAME.test(clean) ? 'Can’t contain / or \\.' : null;
  return (
    <Dialog
      title={title}
      confirmLabel={confirm}
      onConfirm={() => {
        if (clean && !problem && clean !== initial) onSubmit(clean);
      }}
      onClose={onClose}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={255}
        placeholder="Folder name"
        aria-label="Folder name"
        aria-invalid={Boolean(problem)}
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus:border-brand-600"
      />
      {problem ? <p className="text-[12px] text-[#b02a30]">{problem}</p> : null}
    </Dialog>
  );
}

function FolderRow({
  folder,
  active,
  open,
  onToggle,
  onSelect,
  menu,
}: {
  folder: FolderView;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
  menu: React.ReactNode;
}) {
  return (
    <Row
      menu={menu}
      icon={folder.wellKnown ? (FOLDER_ICON[folder.wellKnown] ?? 'folder') : 'folder'}
      label={folder.name}
      badge={folderBadge(folder)}
      badgeMuted={folder.wellKnown === 'drafts' || folder.wellKnown === 'deleteditems' || folder.wellKnown === 'junkemail'}
      active={active}
      onClick={onSelect}
      depth={folder.depth + 1}
      chevron={folder.hasChildren ? { open, onToggle } : undefined}
    />
  );
}

function Row({
  icon,
  label,
  badge,
  badgeMuted = false,
  active,
  onClick,
  depth,
  chevron,
  menu = null,
}: {
  menu?: React.ReactNode;
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  badge: number;
  badgeMuted?: boolean;
  active: boolean;
  onClick: () => void;
  depth: number;
  chevron?: { open: boolean; onToggle: () => void };
}) {
  return (
    <div
      className={`group relative flex items-center rounded-lg transition-[background-color,box-shadow] duration-150 ${
        active
          ? 'bg-white shadow-[0_1px_2px_rgba(8,32,47,.08),0_0_0_1px_rgba(8,32,47,.04)]'
          : 'hover:bg-white/70'
      }`}
      style={{ paddingLeft: 6 + Math.min(depth, 8) * 12 }}
    >
      <span className="grid w-4 shrink-0 place-items-center">
        {chevron ? (
          <button
            type="button"
            onClick={chevron.onToggle}
            aria-label={chevron.open ? `Collapse ${label}` : `Expand ${label}`}
            aria-expanded={chevron.open}
            className="grid size-4 place-items-center rounded text-ink-400 hover:text-ink-900"
          >
            <Icon name="chevron-right" size={11} className={`transition-transform duration-150 ${chevron.open ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        aria-label={badge > 0 ? `${label}, ${badge} ${badgeMuted ? (badge === 1 ? 'item' : 'items') : 'unread'}` : label}
        className="flex min-w-0 flex-1 items-center gap-2 py-[6px] pl-1 pr-2.5 text-left"
      >
        <Icon
          name={icon}
          size={15}
          strokeWidth={active ? 2 : 1.75}
          className={`shrink-0 ${active ? 'text-brand-700' : 'text-ink-400 group-hover:text-ink-600'}`}
        />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            active ? 'font-semibold text-ink-900' : badge > 0 && !badgeMuted ? 'font-semibold text-ink-800' : 'text-ink-700'
          }`}
        >
          {label}
        </span>
        {badge > 0 ? (
          // Gives way to the folder's "…" menu, which appears in the same spot on hover.
          <span
            className={`shrink-0 text-[11.5px] tabular ${badgeMuted ? 'text-ink-400' : 'font-semibold text-brand-700'} ${
              menu ? 'transition-opacity group-focus-within:opacity-0 group-hover:opacity-0' : ''
            }`}
          >
            {badge > 999 ? '999+' : badge}
          </span>
        ) : null}
      </button>
      {menu ? (
        <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-white opacity-0 shadow-[0_0_0_4px_white] transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {menu}
        </span>
      ) : null}
    </div>
  );
}
