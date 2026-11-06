'use client';

/**
 * Proposals on a merchant record (client, "Proposal template Instructions",
 * 3 Nov 2026): preview, send, every proposal sent with its status, open the
 * merchant's page, void.
 *
 * Statuses: Sent → Viewed → Approved; also Expired and Voided.
 */
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Dialog, StatusPill } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import type { ProposalsPanelData, ProposalView } from '@/lib/proposals/service';
import { money } from '@/lib/proposals/content';
import { PROPOSAL_STATUS } from '../proposals/status';
import { voidProposalAction } from './proposalActions';

const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Sending lives in the Files tab's send bar (client, 4 Nov 2026); this lists what went out. */
export function ProposalsPanel({ data }: { moduleSlug: string; recordId: string; data: ProposalsPanelData }) {
  const router = useRouter();
  const [voiding, setVoiding] = useState<ProposalView | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, start] = useTransition();
  const approved = data.items.find((p) => p.status === 'approved');

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#102347] text-[#c8f169]">
          <Icon name="file-text" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-900">
            Proposals
            {approved ? (
              <span className="rounded-full bg-[#e6f6f2] px-2 py-px text-[11px] font-bold text-[#0b6b5d] ring-1 ring-[#bfe6dd]">
                {approved.label} approved
              </span>
            ) : null}
          </h3>
        </div>
      </header>

      {notice ? (
        <div
          role="status"
          className={`flex items-start gap-2 border-t px-4 py-2.5 text-[12.5px] ${
            notice.tone === 'ok' ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-bad/20 bg-bad-bg text-bad'
          }`}
        >
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert-triangle'} size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      {data.items.length ? (
        <ul className="divide-y divide-line-faint border-t border-line-soft">
          {data.items.map((p) => (
            <ProposalRow key={p.id} p={p} canEdit={data.canEdit} busy={busy} onVoid={() => setVoiding(p)} />
          ))}
        </ul>
      ) : null}

      {voiding ? (
        <Dialog
          title={`Void ${voiding.label}?`}
          tone="danger"
          confirmLabel="Void proposal"
          confirmIcon="ban"
          onClose={() => setVoiding(null)}
          onConfirm={() =>
            start(async () => {
              const r = await voidProposalAction(voiding.id);
              setVoiding(null);
              setNotice(r.ok ? { tone: 'ok', text: `${voiding.label} voided. Its link no longer works.` } : { tone: 'bad', text: r.message });
              router.refresh();
            })
          }
        >
          <p>The merchant’s link stops working at once and the proposal can no longer be approved. This cannot be undone — send a new proposal if the merchant still needs one.</p>
        </Dialog>
      ) : null}
    </section>
  );
}

function ProposalRow({ p, canEdit, busy, onVoid }: { p: ProposalView; canEdit: boolean; busy: boolean; onVoid: () => void }) {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const s = PROPOSAL_STATUS[p.status];
  const live = p.status === 'sent' || p.status === 'viewed';

  const facts: string[] = [`Sent to ${p.recipient}${p.cc.length ? ` +${p.cc.length}` : ''} · ${date(p.sentAt)}${p.sentByName ? ` by ${p.sentByName}` : ''}`];
  facts.push(`Saves ${money(p.monthlySavings)}/mo`);
  if (p.viewedAt && p.status !== 'approved') facts.push(`Viewed ${date(p.viewedAt)}`);
  if (p.status === 'approved' && p.approvedAt) facts.push(`Approved ${date(p.approvedAt)}`);
  if (live) facts.push(`Link valid until ${date(p.expiresAt)}`);
  if (p.status === 'expired') facts.push(`Expired ${date(p.expiresAt)}`);
  if (p.status === 'voided' && p.voidedAt) facts.push(`Voided ${date(p.voidedAt)}`);

  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 transition-colors hover:bg-canvas';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] font-semibold tracking-[.02em] text-ink-900">{p.label}</span>
          <StatusPill label={s.label} swatch={s.swatch} />
        </p>
        <p className="mt-0.5 truncate text-[12px] text-ink-500">{facts.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          href={`/proposals/${p.id}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
        >
          <Icon name="eye" size={13} /> Open
        </Link>
        {canEdit && live ? (
          <>
            <button
              ref={menuAnchor}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label={`Actions for ${p.label}`}
              disabled={busy}
              onClick={() => setMenu((m) => !m)}
              className="grid size-8 place-items-center rounded-lg border border-transparent text-ink-400 transition-colors hover:border-line hover:bg-canvas hover:text-ink-900 disabled:opacity-50"
            >
              <Icon name="more-horizontal" size={15} />
            </button>
            <MenuSurface open={menu} onClose={() => setMenu(false)} anchorRef={menuAnchor} align="right" width={220} label={`Actions for ${p.label}`}>
              <button type="button" role="menuitem" className={`${item} text-danger hover:bg-danger-bg`} onClick={() => (setMenu(false), onVoid())}>
                <Icon name="ban" size={14} /> Void
              </button>
            </MenuSurface>
          </>
        ) : null}
      </div>
    </li>
  );
}
