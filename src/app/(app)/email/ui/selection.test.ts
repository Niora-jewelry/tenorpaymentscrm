import { describe, it, expect } from 'vitest';
import type { FolderView, MailboxView } from '@/lib/mail/viewTypes';
import { inboxOf, mailboxFor, resolveSelection } from './selection';

const folder = (id: string, mailboxId: string, wellKnown: string | null = null): FolderView => ({
  id,
  mailboxId,
  parentId: null,
  name: id,
  wellKnown,
  depth: 0,
  unread: 0,
  total: 0,
  hasChildren: false,
  seeded: true,
  oldestLoadedAt: null,
});
const box = (id: string, own: boolean, folders: FolderView[]): MailboxView => ({
  id,
  address: `${id}@zz.test`,
  displayName: id,
  kind: 'personal',
  own,
  health: 'ok',
  folders,
});

const A = box('a', true, [folder('a-in', 'a', 'inbox'), folder('a-sent', 'a', 'sentitems')]);
const B = box('b', true, [folder('b-in', 'b', 'inbox')]);
const T = box('t', false, [folder('t-in', 't', 'inbox')]);
const N = box('n', true, [folder('n-1', 'n'), folder('n-2', 'n')]);

describe('mailboxFor — the mailbox a selection lives in', () => {
  it('a folder names its mailbox', () => {
    expect(mailboxFor({ kind: 'folder', folderId: 'a-sent' }, [A, B, T])?.id).toBe('a');
    expect(mailboxFor({ kind: 'folder', folderId: 't-in' }, [A, B, T])?.id).toBe('t');
  });
  it('All inboxes and Scheduled belong to none', () => {
    expect(mailboxFor({ kind: 'all' }, [A, B])).toBeNull();
    expect(mailboxFor({ kind: 'scheduled' }, [A, B])).toBeNull();
  });
  it('an unknown folder gives none', () => {
    expect(mailboxFor({ kind: 'folder', folderId: 'zzz' }, [A])).toBeNull();
  });
});

describe('inboxOf — what a chip opens', () => {
  it('the Inbox when Outlook named one', () => {
    expect(inboxOf(A)?.id).toBe('a-in');
  });
  it('the first folder otherwise', () => {
    expect(inboxOf(N)?.id).toBe('n-1');
  });
  it('nothing for a mailbox with no folders yet', () => {
    expect(inboxOf(box('e', true, []))).toBeUndefined();
  });
});

describe('resolveSelection — regressions', () => {
  it('a team folder is a valid selection for an admin', () => {
    expect(resolveSelection('t-in', [A, T])).toEqual({ kind: 'folder', folderId: 't-in' });
  });
  it('an admin with only team mailboxes opens the first team Inbox', () => {
    expect(resolveSelection(null, [T])).toEqual({ kind: 'folder', folderId: 't-in' });
  });
  it('"all" with no own mailbox falls back to a folder', () => {
    expect(resolveSelection('all', [T])).toEqual({ kind: 'folder', folderId: 't-in' });
  });
  it('several own mailboxes default to All inboxes', () => {
    expect(resolveSelection(null, [A, B])).toEqual({ kind: 'all' });
  });
});
