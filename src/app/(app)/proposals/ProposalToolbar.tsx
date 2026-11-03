/**
 * The CRM's bar above a proposal page: what this is, what to fix, the way back.
 * The proposal itself is the merchant's page, unchanged.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import type { ProposalNote } from '@/lib/proposals/service';

export function ProposalToolbar({
  title,
  detail,
  backHref,
  notes = [],
  right,
}: {
  title: string;
  detail: ReactNode;
  backHref: string | null;
  notes?: ProposalNote[];
  right?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        {backHref ? (
          <Link href={backHref} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-500 hover:text-ink-900">
            <Icon name="chevron-left" size={14} /> Back to the record
          </Link>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink-900">{title}</p>
          <p className="text-[12px] text-ink-500">{detail}</p>
        </div>
        {right}
      </div>
      {notes.length ? (
        <ul className="mx-auto max-w-[880px] space-y-1.5 px-4 pb-3 sm:px-6">
          {notes.map((n, i) => (
            <li
              key={i}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${
                n.tone === 'block' ? 'border border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' : 'border border-line bg-canvas text-ink-600'
              }`}
            >
              <Icon name={n.tone === 'block' ? 'alert-triangle' : 'info'} size={13} className="mt-[3px] shrink-0" />
              <span className="min-w-0 flex-1">
                {n.text}{' '}
                {n.href ? (
                  <Link href={n.href} className="font-semibold underline underline-offset-2">
                    Go there
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
