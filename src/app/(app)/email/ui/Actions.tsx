'use client';

/**
 * What a person can do to conversations: the reading-pane toolbar, the
 * bulk bar for a multi-selection, and the "Move to" folder picker both use.
 *
 * The verbs adapt to where the mail is, the way Outlook's do: in Junk the
 * junk action becomes "Not junk"; in Deleted Items, Delete becomes the
 * permanent delete (behind a confirmation). Archive is offered only when the
 * mailbox has an Archive folder.
 */
import { useMemo, useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Popover } from '@/proto/ui/kit';
import type { FolderView } from '@/lib/mail/viewTypes';
import { FOLDER_ICON } from './people';

export type Op = 'read' | 'unread' | 'archive' | 'delete' | 'purge' | 'junk' | 'not_junk' | 'move';

export type ActionContext = {
  /** Well-known name of the folder being viewed (null for a custom folder or All inboxes). */
  wellKnown: string | null;
  hasArchive: boolean;
  anyUnread: boolean;
  pinned: boolean | null;
  canPin: boolean;
};

export function deleteOp(wellKnown: string | null): Op {
  return wellKnown === 'deleteditems' || wellKnown === 'junkemail' ? 'purge' : 'delete';
}

function ToolButton({
  icon,
  label,
  onClick,
  danger = false,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-semibold transition-colors ${
        danger ? 'text-ink-600 hover:bg-[#fce9ea] hover:text-[#b02a30]' : 'text-ink-600 hover:bg-white hover:text-ink-900 hover:shadow-[0_1px_2px_rgba(8,32,47,.06)]'
      }`}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

/** Reading-pane toolbar for the open conversation. */
export function ConversationToolbar({
  ctx,
  folders,
  onOp,
  onPin,
}: {
  ctx: ActionContext;
  folders: FolderView[];
  onOp: (op: Op, destFolderId?: string) => void;
  onPin: (pinned: boolean) => void;
}) {
  const del = deleteOp(ctx.wellKnown);
  return (
    <div role="toolbar" aria-label="Conversation actions" className="-ml-2 mt-2 flex flex-wrap items-center gap-0.5">
      {ctx.hasArchive && ctx.wellKnown !== 'archive' ? <ToolButton icon="archive" label="Archive" onClick={() => onOp('archive')} /> : null}
      <ToolButton icon="trash" label={del === 'purge' ? 'Delete forever' : 'Delete'} onClick={() => onOp(del)} danger />
      <MoveTo folders={folders} exclude={null} onPick={(id) => onOp('move', id)}>
        <span className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-semibold text-ink-600 transition-colors hover:bg-white hover:text-ink-900">
          <Icon name="folder" size={14} />
          Move to
          <Icon name="chevron-down" size={11} className="opacity-60" />
        </span>
      </MoveTo>
      {ctx.wellKnown === 'junkemail' ? (
        <ToolButton icon="inbox" label="Not junk" onClick={() => onOp('not_junk')} />
      ) : (
        <ToolButton icon="ban" label="Junk" onClick={() => onOp('junk')} />
      )}
      <span aria-hidden className="mx-1 h-4 w-px bg-line" />
      <ToolButton icon="mail" label={ctx.anyUnread ? 'Mark read' : 'Mark unread'} onClick={() => onOp(ctx.anyUnread ? 'read' : 'unread')} />
      {ctx.canPin && ctx.pinned !== null ? (
        <ToolButton icon="pin" label={ctx.pinned ? 'Unpin' : 'Pin'} pressed={ctx.pinned} onClick={() => onPin(!ctx.pinned)} />
      ) : null}
    </div>
  );
}

/** A folder picker in a popover, with a filter once a tree gets long. */
export function MoveTo({
  folders,
  exclude,
  onPick,
  children,
  side = 'bottom',
}: {
  folders: FolderView[];
  exclude: string | null;
  onPick: (folderId: string) => void;
  children: React.ReactNode;
  side?: 'bottom' | 'right';
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return folders.filter((f) => f.id !== exclude && (!needle || f.name.toLowerCase().includes(needle)));
  }, [folders, exclude, q]);
  return (
    <Popover width={260} side={side} trigger={() => children}>
      {(close) => (
        <div>
          {folders.length > 8 ? (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a folder"
              aria-label="Find a folder"
              className="mb-1.5 w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-brand-600 focus:bg-white"
            />
          ) : null}
          <ul className="max-h-72 overflow-y-auto" role="menu" aria-label="Move to folder">
            {shown.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setQ('');
                    onPick(f.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] text-ink-700 hover:bg-canvas hover:text-ink-900"
                  style={{ paddingLeft: 8 + Math.min(f.depth, 6) * 12 }}
                >
                  <Icon name={f.wellKnown ? (FOLDER_ICON[f.wellKnown] ?? 'folder') : 'folder'} size={14} className="shrink-0 text-ink-400" />
                  <span className="truncate">{f.name}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 ? <li className="px-2 py-2 text-[12.5px] text-ink-400">No folder matches.</li> : null}
          </ul>
        </div>
      )}
    </Popover>
  );
}
