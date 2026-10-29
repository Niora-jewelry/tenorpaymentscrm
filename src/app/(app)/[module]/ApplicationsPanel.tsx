'use client';

/**
 * Applications on a merchant record (Prepopulated Application spec):
 * Send Application, every application with its status, resend / void, the
 * "Needs review" badge into the review screen, and "Upload completed
 * application" for a PDF the merchant emailed back.
 *
 * Statuses: Sent → Opened → Submitted online / PDF uploaded → Reviewed;
 * also Expired and Voided.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, StatusPill } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { Swatch } from '@/proto/schema';
import type { ApplicationsPanelData, ApplicationView, UploadOutcome } from '@/lib/applications/service';
import {
  discardApplicationUploadAction,
  finishApplicationUploadAction,
  prepareApplicationUploadAction,
  voidApplicationAction,
} from './applicationActions';
import { SendApplicationDialog } from './SendApplicationDialog';

const STATUS: Record<ApplicationView['status'], { label: string; swatch: Swatch }> = {
  sent: { label: 'Sent', swatch: 'blue' },
  opened: { label: 'Opened', swatch: 'indigo' },
  submitted: { label: 'Submitted online', swatch: 'teal' },
  pdf_uploaded: { label: 'PDF uploaded', swatch: 'teal' },
  reviewed: { label: 'Reviewed', swatch: 'green' },
  expired: { label: 'Expired', swatch: 'slate' },
  voided: { label: 'Voided', swatch: 'red' },
};

const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const MAX_PDF = 25 * 1024 * 1024;

type Choose = Extract<UploadOutcome, { kind: 'choose' }> & { path: string; name: string };

export function ApplicationsPanel({ recordId, data }: { recordId: string; data: ApplicationsPanelData }) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [sending, setSending] = useState<null | { resend: { id: string; label: string; to: string; cc: string[] } | null }>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string; href?: string; hrefLabel?: string } | null>(null);
  const [voiding, setVoiding] = useState<ApplicationView | null>(null);
  const [choose, setChoose] = useState<Choose | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);

  const open = data.items.filter((a) => a.status !== 'voided');
  const needsReview = data.items.reduce((n, a) => n + a.pending, 0);

  const afterUpload = (r: UploadOutcome, path: string, name: string) => {
    if (r.kind === 'imported') {
      setNotice({
        tone: 'ok',
        text: `${r.label}: ${r.applied} answer${r.applied === 1 ? '' : 's'} filled in automatically${r.pending ? `, ${r.pending} waiting for review` : ''}.`,
        ...(r.pending ? { href: `/applications/${r.applicationId}`, hrefLabel: 'Review now' } : {}),
      });
    } else if (r.kind === 'unreadable') {
      setNotice({
        tone: 'warn',
        text: `${r.label}: this PDF has no readable fields — it was printed, scanned or “printed to PDF”. It is saved; enter the answers by hand next to it.`,
        href: `/applications/${r.applicationId}`,
        hrefLabel: 'Enter the answers',
      });
    } else {
      setChosen(r.options[0]?.id ?? '');
      setChoose({ ...r, path, name });
    }
    router.refresh();
  };

  const upload = async (file: File) => {
    setNotice(null);
    if (file.type && file.type !== 'application/pdf') return setNotice({ tone: 'bad', text: 'Choose a PDF file.' });
    if (file.size > MAX_PDF) return setNotice({ tone: 'bad', text: 'The PDF must be under 25 MB.' });
    setUploading(true);
    try {
      const slot = await prepareApplicationUploadAction(recordId);
      if (!slot.ok) return setNotice({ tone: 'bad', text: slot.message });
      const put = await supabase.storage.from('application-pdfs').uploadToSignedUrl(slot.data.path, slot.data.token, file, { contentType: 'application/pdf' });
      if (put.error) return setNotice({ tone: 'bad', text: 'The upload failed. Try again.' });
      const r = await finishApplicationUploadAction({ recordId, applicationId: uploadFor.current, path: slot.data.path, name: file.name });
      if (!r.ok) return setNotice({ tone: 'bad', text: r.message });
      afterUpload(r.data, slot.data.path, file.name);
    } finally {
      setUploading(false);
      uploadFor.current = null;
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const pick = (applicationId: string | null) => {
    uploadFor.current = applicationId;
    fileInput.current?.click();
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="file-pen" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-900">
            Applications
            {needsReview ? (
              <span className="rounded-full bg-[#fdf1d8] px-2 py-px text-[11px] font-bold text-[#8a5a09] ring-1 ring-[#f7e0af]">
                {needsReview} to review
              </span>
            ) : null}
          </h3>
          <p className="text-[12px] text-ink-500">
            {data.items.length
              ? 'Answers that come back fill empty fields; anything different waits for review.'
              : 'Send the merchant an application filled with what the CRM knows. They finish it online or return the PDF.'}
          </p>
        </div>
        {data.canEdit ? (
          <div className="flex shrink-0 items-center gap-2">
            {open.length ? (
              <Button size="sm" icon="upload" onClick={() => pick(null)} loading={uploading} loadingLabel="Reading PDF…">
                Upload completed
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              icon="send"
              title={data.templateReady ? undefined : 'The application PDF template is not installed yet'}
              onClick={() => setSending({ resend: null })}
            >
              Send application
            </Button>
          </div>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </header>

      {notice ? (
        <div
          role="status"
          className={`flex items-start gap-2 border-t px-4 py-2.5 text-[12.5px] ${
            notice.tone === 'ok'
              ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]'
              : notice.tone === 'warn'
                ? 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
                : 'border-bad/20 bg-bad-bg text-bad'
          }`}
        >
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert-triangle'} size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1">
            {notice.text}{' '}
            {notice.href ? (
              <Link href={notice.href} className="font-semibold underline underline-offset-2">
                {notice.hrefLabel}
              </Link>
            ) : null}
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      {data.items.length ? (
        <ul className="divide-y divide-line-faint border-t border-line-soft">
          {data.items.map((a) => (
            <ApplicationRowView
              key={a.id}
              a={a}
              canEdit={data.canEdit}
              canOpenPdfs={data.canOpenPdfs}
              busy={busy || uploading}
              onResend={() => setSending({ resend: { id: a.id, label: a.label, to: a.recipient, cc: a.cc } })}
              onVoid={() => setVoiding(a)}
              onUpload={() => pick(a.id)}
            />
          ))}
        </ul>
      ) : null}

      {sending ? (
        <SendApplicationDialog
          recordId={recordId}
          resend={sending.resend}
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
          confirmLabel="Void application"
          confirmIcon="ban"
          onClose={() => setVoiding(null)}
          onConfirm={() =>
            start(async () => {
              const r = await voidApplicationAction(voiding.id);
              setVoiding(null);
              setNotice(r.ok ? { tone: 'ok', text: `${voiding.label} voided. Its link no longer works.` } : { tone: 'bad', text: r.message });
              router.refresh();
            })
          }
        >
          <p>
            The link stops working at once{voiding.pending ? ', and the answers still waiting for review are dropped' : ''}. Values already written to
            the record stay. This cannot be undone — send a new application if the merchant still needs one.
          </p>
        </Dialog>
      ) : null}

      {choose ? (
        <Dialog
          title="Which application is this?"
          confirmLabel={choose.options.length ? 'Import into this application' : undefined}
          confirmIcon="upload"
          width={480}
          onClose={() => {
            void discardApplicationUploadAction(choose.path);
            setChoose(null);
          }}
          onConfirm={() =>
            start(async () => {
              const c = choose;
              setChoose(null);
              const r = await finishApplicationUploadAction({ recordId, applicationId: chosen, path: c.path, name: c.name });
              if (!r.ok) setNotice({ tone: 'bad', text: r.message });
              else afterUpload(r.data, c.path, c.name);
            })
          }
        >
          <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] leading-relaxed text-[#8a5a09]">
            <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
            <span>
              {choose.reason === 'other_merchant'
                ? `This PDF belongs to ${choose.foundLabel}, which is another merchant’s application. Check it is the right file before importing it here.`
                : choose.reason === 'not_open'
                  ? `${choose.foundLabel} is already reviewed. Choose an open application for this PDF.`
                  : 'This PDF does not carry an application ID — it may have been re-saved or re-created.'}
            </span>
          </p>
          {choose.options.length ? (
            <fieldset className="mt-3 space-y-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">Import it into</legend>
              {choose.options.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-canvas has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
                  <input type="radio" name="app-choice" value={o.id} checked={chosen === o.id} onChange={() => setChosen(o.id)} className="accent-[#1d4ed8]" />
                  <span className="font-semibold text-ink-900">{o.label}</span>
                  <StatusPill label={STATUS[o.status].label} swatch={STATUS[o.status].swatch} />
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="mt-3 text-[12.5px] text-ink-500">This record has no open application to import it into. Send one first.</p>
          )}
        </Dialog>
      ) : null}
    </section>
  );
}

function ApplicationRowView({
  a,
  canEdit,
  canOpenPdfs,
  busy,
  onResend,
  onVoid,
  onUpload,
}: {
  a: ApplicationView;
  canEdit: boolean;
  canOpenPdfs: boolean;
  busy: boolean;
  onResend: () => void;
  onVoid: () => void;
  onUpload: () => void;
}) {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const s = STATUS[a.status];
  const live = a.status === 'sent' || a.status === 'opened';
  const returned = a.status === 'submitted' || a.status === 'pdf_uploaded' || a.status === 'reviewed';
  const unreadable = a.status === 'pdf_uploaded' && a.pending === 0 && a.applied === 0 && a.files.some((f) => !f.readable);
  const file = a.files[0];

  const facts: string[] = [`Sent to ${a.recipient}${a.cc.length ? ` +${a.cc.length}` : ''} · ${date(a.lastSentAt)}${a.sendCount > 1 ? ` (${a.sendCount}×)` : ''}`];
  if (a.status === 'opened' && a.openedAt) facts.push(`Opened ${date(a.openedAt)}`);
  if (live) facts.push(`Link valid until ${date(a.expiresAt)}`);
  if (a.status === 'expired') facts.push(`Link expired ${date(a.expiresAt)}`);
  if (returned && a.submittedAt) facts.push(`${a.returnedVia === 'pdf' ? 'PDF returned' : 'Submitted'} ${date(a.submittedAt)}`);
  if (a.status === 'reviewed' && a.reviewedAt) facts.push(`Reviewed ${date(a.reviewedAt)}`);
  if (a.status === 'voided' && a.voidedAt) facts.push(`Voided ${date(a.voidedAt)}`);

  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 transition-colors hover:bg-canvas';

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] font-semibold tracking-[.02em] text-ink-900">{a.label}</span>
          <StatusPill label={s.label} swatch={s.swatch} />
          {a.pending ? (
            <Link
              href={`/applications/${a.id}`}
              className="inline-flex items-center gap-1 rounded-full bg-[#fdf1d8] px-2 py-[2px] text-[11.5px] font-semibold text-[#8a5a09] ring-1 ring-[#f7e0af] transition-colors hover:bg-[#fbe6bd]"
            >
              <Icon name="alert-triangle" size={11} />
              Needs review · {a.pending}
            </Link>
          ) : null}
          {unreadable ? (
            <Link
              href={`/applications/${a.id}`}
              className="inline-flex items-center gap-1 rounded-full bg-[#fdf1d8] px-2 py-[2px] text-[11.5px] font-semibold text-[#8a5a09] ring-1 ring-[#f7e0af] hover:bg-[#fbe6bd]"
            >
              <Icon name="file-pen" size={11} />
              Enter answers by hand
            </Link>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-ink-500">{facts.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {returned ? (
          <Link
            href={`/applications/${a.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
          >
            <Icon name="eye" size={13} />
            {a.pending ? 'Review' : 'Details'}
          </Link>
        ) : null}
        <button
          ref={menuAnchor}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`Actions for ${a.label}`}
          disabled={busy}
          onClick={() => setMenu((m) => !m)}
          className="grid size-8 place-items-center rounded-lg border border-transparent text-ink-400 transition-colors hover:border-line hover:bg-canvas hover:text-ink-900 disabled:opacity-50"
        >
          <Icon name="more-horizontal" size={15} />
        </button>
        <MenuSurface open={menu} onClose={() => setMenu(false)} anchorRef={menuAnchor} align="right" width={248} label={`Actions for ${a.label}`}>
          <>
            {canEdit && live ? (
              <button type="button" role="menuitem" className={item} onClick={() => (setMenu(false), onResend())}>
                <Icon name="refresh-cw" size={14} className="text-ink-400" /> Send again
              </button>
            ) : null}
            {canEdit && (live || a.status === 'pdf_uploaded' || a.status === 'submitted') ? (
              <button type="button" role="menuitem" className={item} onClick={() => (setMenu(false), onUpload())}>
                <Icon name="upload" size={14} className="text-ink-400" /> Upload completed PDF
              </button>
            ) : null}
            <Link role="menuitem" href={`/applications/${a.id}`} className={item} onClick={() => setMenu(false)}>
              <Icon name="eye" size={14} className="text-ink-400" /> Open application
            </Link>
            {file && canOpenPdfs ? (
              <a role="menuitem" href={`/api/applications/files/${file.id}`} className={item} onClick={() => setMenu(false)}>
                <Icon name="download" size={14} className="text-ink-400" /> Download returned PDF
              </a>
            ) : null}
            {canEdit && a.status !== 'voided' && a.status !== 'reviewed' ? (
              <>
                <div className="my-1 border-t border-line-faint" />
                <button type="button" role="menuitem" className={`${item} text-danger hover:bg-danger-bg`} onClick={() => (setMenu(false), onVoid())}>
                  <Icon name="ban" size={14} /> Void
                </button>
              </>
            ) : null}
          </>
        </MenuSurface>
      </div>
    </li>
  );
}
