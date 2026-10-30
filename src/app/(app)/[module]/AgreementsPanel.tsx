'use client';

/**
 * Agreements on a merchant record (spec §8): Send agreement, every
 * agreement with its status and each signer's, the change banner while one
 * is out, and Void / Void & resend / Send reminder / Resend to a bounced
 * signer / Download signed PDF / Retry download.
 *
 * Statuses: Sent → Viewed → Partially signed → Completed; also Declined,
 * Expired and Voided. A bounced signer shows on their chip — the other
 * signers continue (the client, 30 Oct 2026).
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, StatusPill } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import type { Swatch } from '@/proto/schema';
import type { AgreementView, AgreementsPanelData, SignerView } from '@/lib/agreements/service';
import { resendToSignerAction, retryDownloadAction, sendReminderAction, voidAgreementAction } from './agreementActions';
import { SendAgreementDialog } from './SendAgreementDialog';

const STATUS: Record<AgreementView['status'], { label: string; swatch: Swatch }> = {
  sending: { label: 'Sending', swatch: 'blue' },
  sent: { label: 'Sent', swatch: 'blue' },
  viewed: { label: 'Viewed', swatch: 'indigo' },
  partially_signed: { label: 'Partially signed', swatch: 'teal' },
  completed: { label: 'Completed', swatch: 'green' },
  declined: { label: 'Declined', swatch: 'red' },
  expired: { label: 'Expired', swatch: 'slate' },
  voided: { label: 'Voided', swatch: 'red' },
};
const SIGNER: Record<SignerView['status'], { label: string; cls: string }> = {
  sent: { label: 'Sent', cls: 'border-line bg-white text-ink-600' },
  viewed: { label: 'Viewed', cls: 'border-brand-200 bg-brand-50 text-brand-700' },
  signed: { label: 'Signed', cls: 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' },
  declined: { label: 'Declined', cls: 'border-bad/30 bg-bad-bg text-bad' },
  bounced: { label: 'Email bounced', cls: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' },
};
const OPEN = new Set<AgreementView['status']>(['sending', 'sent', 'viewed', 'partially_signed']);

const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function AgreementsPanel({ moduleSlug, recordId, data }: { moduleSlug: string; recordId: string; data: AgreementsPanelData }) {
  const router = useRouter();
  const [sending, setSending] = useState<null | { resendOf: string | null; kind: string }>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [voiding, setVoiding] = useState<AgreementView | null>(null);
  const [busy, start] = useTransition();
  const kindMenu = useRef<HTMLSpanElement>(null);
  const [kindOpen, setKindOpen] = useState(false);

  const open = data.items.find((a) => OPEN.has(a.status)) ?? null;
  const startSend = (kind: string, resendOf: string | null = null) => {
    setKindOpen(false);
    setSending({ kind, resendOf });
  };
  const act = (fn: () => Promise<{ ok: boolean; message?: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      setNotice(r.ok ? { tone: 'ok', text: okText } : { tone: 'bad', text: r.message ?? 'Something went wrong.' });
      router.refresh();
    });

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="file-pen" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-ink-900">Agreements</h3>
          <p className="text-[12px] text-ink-500">
            {data.items.length
              ? 'Filled from this record, signed online by each principal. The signed PDF lands here.'
              : 'Send the merchant agreement, filled from this record, to every principal for e-signature.'}
          </p>
        </div>
        {data.canSend ? (
          <div className="flex shrink-0 items-center gap-2">
            {data.kinds.length > 1 ? (
              <>
                <span ref={kindMenu} className="inline-flex">
                  <Button size="sm" variant="primary" icon="send" disabled={Boolean(open)} title={open ? `${open.label} is already out. Void it first.` : undefined} onClick={() => setKindOpen((o) => !o)}>
                    Send agreement
                  </Button>
                </span>
                <MenuSurface open={kindOpen} onClose={() => setKindOpen(false)} anchorRef={kindMenu} align="right" width={260} label="Which agreement">
                  {data.kinds.map((k) => (
                    <button key={k.key} type="button" onClick={() => startSend(k.key)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 hover:bg-canvas">
                      <Icon name="file-pen" size={13} className="text-ink-400" /> {k.label}
                    </button>
                  ))}
                </MenuSurface>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon="send"
                disabled={Boolean(open) || !data.kinds.length}
                title={open ? `${open.label} is already out. Void it first.` : !data.configured ? 'The signing service is not set up yet' : undefined}
                onClick={() => data.kinds[0] && startSend(data.kinds[0].key)}
              >
                Send agreement
              </Button>
            )}
          </div>
        ) : null}
      </header>

      {!data.configured && data.canSend ? (
        <p className="flex items-start gap-2 border-t border-[#f7e0af] bg-[#fdf1d8] px-4 py-2.5 text-[12.5px] text-[#8a5a09]">
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          The signing service (SignWell) is not connected yet. Nothing can be sent until its API key and webhook are set.
        </p>
      ) : null}

      {notice ? (
        <div
          role="status"
          className={`flex items-start gap-2 border-t px-4 py-2.5 text-[12.5px] ${
            notice.tone === 'ok' ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : notice.tone === 'warn' ? 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' : 'border-bad/20 bg-bad-bg text-bad'
          }`}
        >
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert-triangle'} size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      {open && data.changes && data.changes.length ? (
        <div className="border-t border-[#f7e0af] bg-[#fdf1d8] px-4 py-3 text-[12.5px] text-[#8a5a09]">
          <p className="flex items-start gap-2 font-semibold">
            <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
            <span>
              {data.changes.length} value{data.changes.length === 1 ? '' : 's'} on this record changed after {open.label} went out. The signers are looking at the old
              {data.changes.length === 1 ? ' one' : ' ones'}.
            </span>
          </p>
          <ul className="mt-2 space-y-1 pl-5">
            {data.changes.slice(0, 8).map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{c.label}:</span>
                <span className="line-through decoration-[#8a5a09]/50">{c.before || 'empty'}</span>
                <span aria-hidden>→</span>
                <span className="font-semibold">{c.after || 'empty'}</span>
              </li>
            ))}
            {data.changes.length > 8 ? <li className="text-[12px]">…and {data.changes.length - 8} more</li> : null}
          </ul>
          {data.canSend ? (
            <div className="mt-2.5 pl-5">
              <Button size="sm" icon="refresh-cw" onClick={() => startSend(data.kinds[0]?.key ?? 'maverick_merchant', open.id)} disabled={busy}>
                Void &amp; resend with the new values
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {data.items.length ? (
        <ul className="divide-y divide-line-faint border-t border-line-soft">
          {data.items.map((a) => (
            <AgreementRowView
              key={a.id}
              a={a}
              canSend={data.canSend}
              busy={busy}
              onVoid={() => setVoiding(a)}
              onResend={() => startSend(data.kinds[0]?.key ?? 'maverick_merchant', a.id)}
              onRemind={() => act(() => sendReminderAction(a.id), `Reminder sent for ${a.label} to everyone who has not signed.`)}
              onResendSigner={(s) => act(() => resendToSignerAction(a.id, s.id), `${a.label} resent to ${s.name} at the corrected address.`)}
              onRetryDownload={() => act(() => retryDownloadAction(a.id), 'Fetching the signed PDF again…')}
            />
          ))}
        </ul>
      ) : null}

      {sending ? (
        <SendAgreementDialog
          moduleSlug={moduleSlug}
          recordId={recordId}
          kind={sending.kind}
          resendOf={sending.resendOf}
          onClose={() => setSending(null)}
          onSent={(text) => {
            setSending(null);
            setNotice({ tone: 'ok', text });
            router.refresh();
          }}
        />
      ) : null}

      {voiding ? (
        <Dialog
          title={`Void ${voiding.label}?`}
          tone="danger"
          confirmLabel="Void agreement"
          confirmIcon="ban"
          onClose={() => setVoiding(null)}
          onConfirm={() =>
            start(async () => {
              const r = await voidAgreementAction(voiding.id);
              setVoiding(null);
              setNotice(r.ok ? { tone: 'ok', text: `${voiding.label} voided. The signing service has told the signers.` } : { tone: 'bad', text: r.message });
              router.refresh();
            })
          }
        >
          <p>The signers&apos; links stop working and they are told the agreement was cancelled. Anything already signed on it is void. Send a new agreement when the record is ready.</p>
        </Dialog>
      ) : null}
    </section>
  );
}

function AgreementRowView({
  a,
  canSend,
  busy,
  onVoid,
  onResend,
  onRemind,
  onResendSigner,
  onRetryDownload,
}: {
  a: AgreementView;
  canSend: boolean;
  busy: boolean;
  onVoid: () => void;
  onResend: () => void;
  onRemind: () => void;
  onResendSigner: (s: SignerView) => void;
  onRetryDownload: () => void;
}) {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const s = STATUS[a.status];
  const live = OPEN.has(a.status);
  const signed = a.files.find((f) => f.kind === 'completed');
  const sentCopy = a.files.find((f) => f.kind === 'sent_copy');

  const facts: string[] = [`Sent ${date(a.sentAt)}`];
  if (live) facts.push(`Expires ${date(a.expiresAt)}`);
  if (a.status === 'completed' && a.completedAt) facts.push(`Completed ${date(a.completedAt)}`);
  if (a.status === 'declined' && a.declinedAt) facts.push(`Declined ${date(a.declinedAt)}${a.declineReason ? ` — “${a.declineReason}”` : ''}`);
  if (a.status === 'expired') facts.push(`Expired ${date(a.expiredAt ?? a.expiresAt)}`);
  if (a.status === 'voided' && a.voidedAt) facts.push(`Voided ${date(a.voidedAt)}`);
  if (a.status === 'completed' && a.downloadStatus === 'pending') facts.push('Fetching the signed PDF…');
  if (a.status === 'completed' && a.downloadStatus === 'failed') facts.push('The signed PDF could not be fetched');

  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 transition-colors hover:bg-canvas disabled:opacity-50';
  const actions = canSend && (live || a.status === 'declined' || a.status === 'expired' || a.downloadStatus === 'failed');

  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12.5px] font-semibold tracking-[.02em] text-ink-900">{a.label}</span>
            <StatusPill label={s.label} swatch={s.swatch} />
            {a.testMode ? <span className="rounded-full bg-[#fdf1d8] px-2 py-px text-[10.5px] font-bold uppercase tracking-[.05em] text-[#8a5a09] ring-1 ring-[#f7e0af]">Test</span> : null}
            <span className="text-[12px] text-ink-400">{a.kindLabel}</span>
          </p>
          <p className="mt-0.5 text-[12px] text-ink-500">{facts.join(' · ')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {signed?.canOpen ? (
            <a href={`/api/agreements/files/${signed.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400">
              <Icon name="download" size={12} /> Signed PDF
            </a>
          ) : signed && !signed.canOpen ? (
            <span className="text-[11.5px] text-ink-400" title="The PDF holds values from a section you cannot see">Signed PDF on file</span>
          ) : null}
          {actions ? (
            <>
              <button ref={menuAnchor} type="button" aria-label={`Actions for ${a.label}`} onClick={() => setMenu((m) => !m)} className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
                <Icon name="more-horizontal" size={15} />
              </button>
              <MenuSurface open={menu} onClose={() => setMenu(false)} anchorRef={menuAnchor} align="right" width={250} label={`Actions for ${a.label}`}>
                {live ? (
                  <>
                    <button type="button" className={item} disabled={busy} onClick={() => { setMenu(false); onRemind(); }}>
                      <Icon name="bell" size={13} className="text-ink-400" /> Send reminder now
                    </button>
                    <button type="button" className={item} disabled={busy} onClick={() => { setMenu(false); onResend(); }}>
                      <Icon name="refresh-cw" size={13} className="text-ink-400" /> Void &amp; resend
                    </button>
                    <button type="button" className={`${item} text-bad hover:bg-bad-bg`} disabled={busy} onClick={() => { setMenu(false); onVoid(); }}>
                      <Icon name="ban" size={13} /> Void
                    </button>
                  </>
                ) : null}
                {a.status === 'declined' || a.status === 'expired' ? (
                  <button type="button" className={item} disabled={busy} onClick={() => { setMenu(false); onResend(); }}>
                    <Icon name="send" size={13} className="text-ink-400" /> Send a new agreement
                  </button>
                ) : null}
                {a.downloadStatus === 'failed' ? (
                  <button type="button" className={item} disabled={busy} onClick={() => { setMenu(false); onRetryDownload(); }}>
                    <Icon name="rotate-ccw" size={13} className="text-ink-400" /> Retry download
                  </button>
                ) : null}
                {sentCopy?.canOpen ? (
                  <a href={`/api/agreements/files/${sentCopy.id}`} className={item} onClick={() => setMenu(false)}>
                    <Icon name="download" size={13} className="text-ink-400" /> The copy that went out
                  </a>
                ) : null}
              </MenuSurface>
            </>
          ) : null}
        </div>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {a.signers.map((sg) => {
          const st = SIGNER[sg.status];
          return (
            <li key={sg.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px] ${st.cls}`} title={`${sg.email}${sg.at ? ` · ${date(sg.at)}` : ''}${sg.declineReason ? ` · ${sg.declineReason}` : ''}`}>
              <span className="font-semibold">{sg.name}</span>
              {sg.percentage != null ? <span className="opacity-70">{sg.percentage}%</span> : null}
              <span aria-hidden>·</span>
              <span>{st.label}</span>
              {sg.status === 'bounced' && live && canSend ? (
                <button type="button" disabled={busy} onClick={() => onResendSigner(sg)} className="ml-0.5 rounded px-1 font-semibold underline decoration-[#8a5a09]/40 underline-offset-2 hover:decoration-[#8a5a09]">
                  Resend to this signer
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
