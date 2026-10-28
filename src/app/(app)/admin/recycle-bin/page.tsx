/**
 * Recycle Bin — admin-only, and now holding what the client said it holds.
 *
 * Admin Plan §6: "The Recycle Bin contains everything truly soft-deleted across
 * the entire CRM: records (deleted from within the Records List module), files,
 * updates and replies, login rows, and users." Access is "admin-only, not
 * grantable", which is why this page asks `ctx.isAdmin` directly and consults no
 * grant — the Recycle Bin is the one surface the permission system deliberately
 * cannot widen.
 *
 * Until now it listed records and nothing else. Everything else set `deleted_at`
 * and became unreachable: a file, an update, a reply or a login row could be
 * deleted and was then gone for good, by a button that called itself a soft
 * delete. `recycleBin.ts` is the list; migrations 53-55 are the restores.
 *
 * ── PURGE IS STILL RECORDS AND USERS ONLY ────────────────────────────────
 * Deliberately. §6 gives permanent removal for records, and §2.1 for users as
 * the third of three levels. Nothing in the client's documents asks to purge a
 * file or an update, and a button that permanently destroys one would be a
 * requirement this build invented for itself.
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { listDeletedRecords } from '@/lib/records/records';
import { listBin, type BinItem } from '@/lib/records/recycleBin';
import { listDeletedUsers } from '@/lib/records/adminUsers';
import { BinRow } from './BinRow';
import { BinItemRow } from './BinItemRow';
import { BinUserRow } from './BinUserRow';
import { BinSections, type BinSection } from './BinSections';

export default async function RecycleBinPage() {
  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'recycle_bin'))) redirect('/dashboard');

  // Three reads in one wave. They are independent, and awaiting them in
  // sequence would simply add their latencies together against a remote
  // database.
  const [records, items, users] = await Promise.all([
    listDeletedRecords(ctx),
    listBin(ctx),
    listDeletedUsers(ctx),
  ]);

  const of = (...kinds: BinItem[]['0']['kind'][]) => items.filter((i) => kinds.includes(i.kind));
  const files = of('file');
  const posts = of('update', 'reply');
  const logins = of('login');
  const cases = of('case', 'case_reply');

  const list = (rows: BinItem[]) => (
    <div className="space-y-2">
      {rows.map((i) => (
        <BinItemRow key={`${i.kind}:${i.id}`} item={i} />
      ))}
    </div>
  );

  const sections: BinSection[] = [
    {
      key: 'records',
      label: 'Records',
      icon: 'database',
      count: records.length,
      description:
        'Deleted from the Records List, which is the only module a record can be deleted from. Restoring is refused if another record has taken the Deal Name in the meantime. Purging is permanent.',
      content: (
        <div className="space-y-2">
          {records.map((r) => (
            <BinRow key={r.id} id={r.id} dealName={r.dealName} deletedAt={r.deletedAt} />
          ))}
        </div>
      ),
    },
    {
      key: 'files',
      label: 'Files',
      icon: 'paperclip',
      count: files.length,
      description:
        'Restoring puts the file back in the row it came from. Refused if that row already holds five — the cap counts live files only, so one has to go first.',
      content: list(files),
    },
    {
      key: 'updates',
      label: 'Updates',
      icon: 'message-square',
      count: posts.length,
      description:
        'Updates and their replies. A reply cannot be restored under a deleted update — restore the update it belongs to first.',
      content: list(posts),
    },
    {
      key: 'cases',
      label: 'Cases',
      icon: 'lifebuoy',
      count: cases.length,
      description:
        'Case threads and individual replies. Restoring a thread brings back the replies that went down with it. Case numbers are never reused, so a restored case keeps the number it had.',
      content: list(cases),
    },
    {
      key: 'logins',
      label: 'Logins',
      icon: 'key',
      count: logins.length,
      description:
        'Login rows from the Logins tab. Passwords are never read by this screen — they are reachable only through the reveal control on the record itself, which logs every use.',
      content: list(logins),
    },
    {
      key: 'users',
      label: 'Users',
      icon: 'user',
      count: users.length,
      description:
        'Accounts that have been soft-deleted. Restoring brings someone back paused rather than active. Permanent deletion keeps whatever they wrote and removes the person.',
      content: (
        <div className="space-y-2">
          {users.map((u) => (
            <BinUserRow key={u.id} user={u} />
          ))}
        </div>
      ),
    },
  ];

  const total = records.length + items.length + users.length;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold text-ink-900">Recycle Bin</h1>
      <p className="mb-4 text-[13px] text-ink-500">
        {total} deleted item{total === 1 ? '' : 's'} across the whole CRM
      </p>

      <BinSections sections={sections} />
    </div>
  );
}
