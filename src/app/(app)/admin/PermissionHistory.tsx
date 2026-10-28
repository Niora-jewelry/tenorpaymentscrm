/**
 * The change history for one user type or one user (Permissions spec, Audit
 * log: "who changed what, when, and the before and after value"). Read from
 * `permission_audit_log`, which nothing can edit or delete.
 */
import type { AuditEntry } from '@/lib/records/permissionSettings';

const LABEL: Record<string, string> = {
  no: 'No', yes: 'Yes', hidden: 'Hidden', mine: 'Only mine', all: 'All', full: 'Full access',
  own: 'Own only', org: 'Whole org', view: 'View', edit: 'Edit',
};
const show = (v: string | null) => (v === null ? 'Default' : LABEL[v] ?? v);

const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function PermissionHistory({ entries }: { entries: AuditEntry[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <header className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">History</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-500">Every change, newest first. This log cannot be edited.</p>
      </header>
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-ink-400">No changes yet.</p>
      ) : (
        <ol className="divide-y divide-line-soft">
          {entries.map((e) => (
            <li key={e.id} className="grid gap-x-4 gap-y-0.5 px-4 py-2 text-[12.5px] sm:grid-cols-[10.5rem_1fr_auto] sm:items-center">
              <time dateTime={e.at} className="tabular-nums text-ink-400">{when.format(new Date(e.at))}</time>
              <span className="min-w-0 text-ink-800">
                <span className="font-medium">{e.what}</span>
                <span className="text-ink-400"> · {e.actorName ?? 'System'}</span>
              </span>
              <span className="flex items-center gap-1.5 text-[12px]">
                <span className="text-ink-400 line-through decoration-ink-300">{show(e.before)}</span>
                <span aria-hidden className="text-ink-300">→</span>
                <span className="font-semibold text-ink-800">{show(e.after)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
