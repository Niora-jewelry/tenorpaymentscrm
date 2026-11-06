'use client';

/**
 * Completed applications on the Files tab (client test of 6 Nov 2026: "The
 * Files tab has no completed application"). The copy of what the merchant
 * submitted online, or the PDF they returned. These stay in the encrypted
 * application store, not the ordinary file rows, because they hold owners'
 * details, so opening one needs "Returned application PDFs".
 */
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import type { ApplicationsPanelData } from '@/lib/applications/service';

const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function SubmittedApplications({ data }: { data: ApplicationsPanelData }) {
  const rows = data.items.flatMap((a) => a.files.map((f) => ({ ...f, applicationId: a.id, label: a.label, online: a.returnedVia === 'online' })));
  if (!rows.length) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <header className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-ink-600 ring-1 ring-inset ring-line-soft">
          <Icon name="file-text" size={15} />
        </span>
        <h3 className="text-[14px] font-semibold text-ink-900">Completed applications</h3>
      </header>
      <ul className="divide-y divide-line-faint border-t border-line-soft">
        {rows.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink-900">{f.name}</p>
              <p className="truncate text-[12px] text-ink-500">
                <span className="font-mono text-[11.5px] font-semibold text-ink-700">{f.label}</span> · {f.online ? 'Submitted online' : 'PDF returned'} {date(f.uploadedAt)} · {size(f.sizeBytes)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Link
                href={`/applications/${f.applicationId}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
              >
                <Icon name="eye" size={13} />
                Details
              </Link>
              {data.canOpenPdfs ? (
                <a
                  href={`/api/applications/files/${f.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
                >
                  <Icon name="download" size={13} />
                  Download
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 text-[12px] text-ink-400" title="Your permissions do not include opening completed applications.">
                  <Icon name="lock" size={12} /> Restricted
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
