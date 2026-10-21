/**
 * What the Email page is looking at, shared by the server page (first paint)
 * and the client shell. Plain functions — no React, no server imports.
 */
import type { MailboxView } from '@/lib/mail/viewTypes';

export type Selection = { kind: 'all' } | { kind: 'folder'; folderId: string } | { kind: 'scheduled' };
export type Open = { mailboxId: string; key: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folders a selection lists: one folder, or every own mailbox's Inbox. */
export function folderIdsFor(sel: Selection, boxes: MailboxView[]): string[] {
  if (sel.kind === 'folder') return [sel.folderId];
  if (sel.kind === 'scheduled') return [];
  return boxes.filter((b) => b.own).flatMap((b) => b.folders.filter((f) => f.wellKnown === 'inbox').map((f) => f.id));
}

/** `?c=<mailbox uuid>~<conversation key>` → the open conversation, or null. */
export function parseOpen(raw: string | null | undefined): Open | null {
  if (!raw || raw.length > 700) return null;
  const mailboxId = raw.slice(0, 36);
  if (raw[36] !== '~' || !UUID.test(mailboxId) || raw.length < 38) return null;
  return { mailboxId, key: raw.slice(37) };
}

/**
 * From `?f=`: a folder that exists in what this person can see, or All inboxes.
 * Default: All inboxes with several own mailboxes, else the one Inbox (or, for
 * an admin with no mailbox of their own, the first team mailbox's Inbox).
 */
export function resolveSelection(f: string | null | undefined, boxes: MailboxView[]): Selection {
  const own = boxes.filter((b) => b.own);
  if (f === 'scheduled') return { kind: 'scheduled' };
  if (f && f !== 'all' && boxes.some((b) => b.folders.some((x) => x.id === f))) return { kind: 'folder', folderId: f };
  if (f === 'all' && own.length > 0) return { kind: 'all' };
  if (own.length > 1) return { kind: 'all' };
  const box = own[0] ?? boxes[0];
  const inbox = box?.folders.find((x) => x.wellKnown === 'inbox') ?? box?.folders[0];
  return inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'all' };
}
