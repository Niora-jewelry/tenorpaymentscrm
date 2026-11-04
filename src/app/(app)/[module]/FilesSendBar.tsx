'use client';

/**
 * The Files tab's send bar (client, 4 Nov 2026): Send application, Send
 * proposal and Send agreement side by side under the tabs, each with an
 * optional preview.
 *
 *  - A required field that is empty → a list of the fields, each a link that
 *    lands on it. Nothing is sent. (The agreement dialog runs its own check,
 *    which already lists every problem the same way.)
 *  - A proposal with an optional page blank or not ticked → the user confirms
 *    before it goes out without it.
 *
 * Which buttons show is permission: the same flags the panels below use.
 * The server runs every check again on Send.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import type { ApplicationsPanelData } from '@/lib/applications/service';
import type { AgreementsPanelData } from '@/lib/agreements/service';
import type { ProposalsPanelData } from '@/lib/proposals/service';
import type { ProblemGroup } from '@/lib/records/fieldProblems';
import { applicationPreCheckAction } from './applicationActions';
import { proposalPreCheckAction } from './proposalActions';
import { SendApplicationDialog } from './SendApplicationDialog';
import { SendProposalDialog } from './SendProposalDialog';
import { SendAgreementDialog } from './SendAgreementDialog';

type OptionalPage = { page: string; reason: string; href?: string };
type Doc = 'application' | 'proposal' | 'agreement';
type Step =
  | null
  | { doc: Doc; phase: 'checking' }
  | { doc: Doc; phase: 'problems'; groups: ProblemGroup[] }
  | { doc: 'proposal'; phase: 'optional'; optional: OptionalPage[] }
  | { doc: 'application' | 'proposal'; phase: 'send' }
  | { doc: 'agreement'; phase: 'send'; kind: string };

const OPEN_AGREEMENT = new Set(['sending', 'sent', 'viewed', 'partially_signed']);

export function FilesSendBar({
  moduleSlug,
  recordId,
  applications,
  proposals,
  agreements,
}: {
  moduleSlug: string;
  recordId: string;
  applications: ApplicationsPanelData | null;
  proposals: ProposalsPanelData | null;
  agreements: AgreementsPanelData | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [, start] = useTransition();
  const kindAnchor = useRef<HTMLSpanElement>(null);
  const [kindMenu, setKindMenu] = useState<null | 'send' | 'preview'>(null);

  const canApp = Boolean(applications?.canEdit);
  const canProp = Boolean(proposals?.canEdit);
  const canAgr = Boolean(agreements?.canSend);
  if (!canApp && !canProp && !canAgr) return null;

  const kinds = agreements?.kinds ?? [];
  const openByKind = new Map((agreements?.items ?? []).filter((a) => OPEN_AGREEMENT.has(a.status)).map((a) => [a.kind, a] as const));
  const allOut = kinds.length > 0 && kinds.every((k) => openByKind.has(k.key));
  const agrBlocked = !agreements?.configured
    ? 'The signing service is not set up yet. Connect SignWell in CRM Settings › Integrations.'
    : !kinds.length
      ? 'No agreement is set up yet.'
      : allOut
        ? kinds.length === 1
          ? `${openByKind.get(kinds[0]!.key)?.label ?? 'An agreement'} is already out. Void it first.`
          : 'Every agreement is already out. Void one first.'
        : null;

  const appPreview = `/api/applications/preview/${recordId}`;
  const propPreview = `/proposals/preview/${recordId}?module=${encodeURIComponent(moduleSlug)}`;
  const agrPreview = (kind: string) => `/api/agreements/preview/${recordId}?kind=${encodeURIComponent(kind)}`;

  const sendApplication = () =>
    start(async () => {
      setNotice(null);
      setStep({ doc: 'application', phase: 'checking' });
      const r = await applicationPreCheckAction(recordId);
      if (!r.ok) {
        setStep(null);
        return setNotice({ tone: 'bad', text: r.message });
      }
      setStep(r.data.groups.length ? { doc: 'application', phase: 'problems', groups: r.data.groups } : { doc: 'application', phase: 'send' });
    });

  const sendProposal = () =>
    start(async () => {
      setNotice(null);
      setStep({ doc: 'proposal', phase: 'checking' });
      const r = await proposalPreCheckAction(recordId, moduleSlug);
      if (!r.ok) {
        setStep(null);
        return setNotice({ tone: 'bad', text: r.message });
      }
      if (r.data.groups.length) return setStep({ doc: 'proposal', phase: 'problems', groups: r.data.groups });
      setStep(r.data.optional.length ? { doc: 'proposal', phase: 'optional', optional: r.data.optional } : { doc: 'proposal', phase: 'send' });
    });

  const sendAgreement = (kind: string) => {
    setKindMenu(null);
    setNotice(null);
    setStep({ doc: 'agreement', phase: 'send', kind });
  };

  const sent = (text: string) => {
    setStep(null);
    setNotice({ tone: 'ok', text });
    router.refresh();
  };

  const checking = (doc: Doc) => step?.doc === doc && step.phase === 'checking';

  return (
    <section aria-label="Send documents" className="rounded-xl border border-line bg-white p-3 shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {canApp ? (
          <SendTile
            icon="briefcase"
            label="Send application"
            busy={checking('application')}
            disabledReason={applications?.templateReady ? null : 'The application PDF template is not installed yet.'}
            onSend={sendApplication}
            preview={<PreviewLink href={appPreview} />}
          />
        ) : null}
        {canProp ? (
          <SendTile icon="file-text" label="Send proposal" busy={checking('proposal')} disabledReason={null} onSend={sendProposal} preview={<PreviewLink href={propPreview} />} />
        ) : null}
        {canAgr ? (
          <span ref={kindAnchor} className="contents">
            <SendTile
              icon="file-pen"
              label="Send agreement"
              busy={false}
              disabledReason={agrBlocked}
              onSend={() => (kinds.length === 1 ? sendAgreement(kinds[0]!.key) : setKindMenu((m) => (m === 'send' ? null : 'send')))}
              preview={
                kinds.length === 1 ? (
                  <PreviewLink href={agrPreview(kinds[0]!.key)} />
                ) : kinds.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setKindMenu((m) => (m === 'preview' ? null : 'preview'))}
                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-ink-500 hover:text-brand-700"
                  >
                    <Icon name="eye" size={12} /> Preview
                  </button>
                ) : null
              }
            />
          </span>
        ) : null}
      </div>

      <MenuSurface open={kindMenu !== null} onClose={() => setKindMenu(null)} anchorRef={kindAnchor} align="right" width={270} label="Which agreement">
        {kinds.map((k) => {
          const out = openByKind.get(k.key);
          const blocked = kindMenu === 'send' && Boolean(out);
          const cls =
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 hover:bg-canvas aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
          const inner = (
            <>
              <Icon name={kindMenu === 'preview' ? 'eye' : 'file-pen'} size={13} className="text-ink-400" />
              <span className="min-w-0 flex-1">{k.label}</span>
              {out && kindMenu === 'send' ? <span className="text-[11px] text-ink-400">{out.label} out</span> : null}
            </>
          );
          return kindMenu === 'preview' ? (
            <a key={k.key} href={agrPreview(k.key)} target="_blank" rel="noopener" onClick={() => setKindMenu(null)} className={cls}>
              {inner}
            </a>
          ) : (
            <button key={k.key} type="button" aria-disabled={blocked} title={out ? `${out.label} is already out. Void it first.` : undefined} onClick={() => !blocked && sendAgreement(k.key)} className={cls}>
              {inner}
            </button>
          );
        })}
      </MenuSurface>

      {notice ? (
        <p
          role="status"
          className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${
            notice.tone === 'ok' ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-bad/20 bg-bad-bg text-bad'
          }`}
        >
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert-triangle'} size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </p>
      ) : null}

      {step?.phase === 'problems' ? (
        <ProblemsDialog
          doc={step.doc}
          groups={step.groups}
          href={(g, fieldKey) =>
            `/${moduleSlug}?record=${recordId}${g.tabKey ? `&tab=${encodeURIComponent(g.tabKey)}` : ''}${g.subtabKey ? `&subtab=${encodeURIComponent(g.subtabKey)}` : ''}&field=${encodeURIComponent(fieldKey)}`
          }
          onClose={() => setStep(null)}
        />
      ) : null}

      {step?.phase === 'optional' ? (
        <OptionalPagesDialog optional={step.optional} previewHref={propPreview} onClose={() => setStep(null)} onConfirm={() => setStep({ doc: 'proposal', phase: 'send' })} />
      ) : null}

      {step?.phase === 'send' && step.doc === 'application' ? <SendApplicationDialog recordId={recordId} onClose={() => setStep(null)} onSent={sent} /> : null}
      {step?.phase === 'send' && step.doc === 'proposal' ? <SendProposalDialog recordId={recordId} moduleSlug={moduleSlug} onClose={() => setStep(null)} onSent={sent} /> : null}
      {step?.phase === 'send' && step.doc === 'agreement' ? (
        <SendAgreementDialog moduleSlug={moduleSlug} recordId={recordId} kind={step.kind} resendOf={null} onClose={() => setStep(null)} onSent={sent} />
      ) : null}
    </section>
  );
}

function SendTile({
  icon,
  label,
  busy,
  disabledReason,
  onSend,
  preview,
}: {
  icon: IconName;
  label: string;
  busy: boolean;
  disabledReason: string | null;
  onSend: () => void;
  preview: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-1">
      <div className="flex [&>button]:w-full">
        <Button variant="primary" icon={icon} loading={busy} loadingLabel="Checking…" disabled={Boolean(disabledReason)} title={disabledReason ?? undefined} onClick={onSend}>
          {label}
        </Button>
      </div>
      <div className="flex h-5 items-center justify-center">{preview}</div>
    </div>
  );
}

function PreviewLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      title="Opens the document as it would be sent now. Nothing is sent."
      className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-ink-500 hover:text-brand-700"
    >
      <Icon name="eye" size={12} /> Preview
    </a>
  );
}

/** Portalled: the drawer animates with a transform, which would trap a fixed overlay. */
function Overlay({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Opened only by a click, so it only ever renders in the browser.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="relative my-8 w-full max-w-[560px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]">
        {children}
      </div>
    </div>,
    document.body,
  );
}

const DOC_NAME: Record<Doc, string> = { application: 'application', proposal: 'proposal', agreement: 'agreement' };

function ProblemsDialog({
  doc,
  groups,
  href,
  onClose,
}: {
  doc: Doc;
  groups: ProblemGroup[];
  href: (g: ProblemGroup, fieldKey: string) => string;
  onClose: () => void;
}) {
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <Overlay labelledBy="files-send-problems" onClose={onClose}>
      <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-bad-bg text-bad">
          <Icon name="alert-triangle" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="files-send-problems" className="text-[16px] font-semibold text-ink-900">
            Can&rsquo;t send the {DOC_NAME[doc]} yet: {count} field{count === 1 ? '' : 's'} to fill in
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">Click a field to go straight to it. Nothing has been sent.</p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
        {groups.map((g) => (
          <section key={`${g.tabKey}/${g.subtabKey}`}>
            <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
              {g.tabLabel}
              {g.subtabLabel ? ` › ${g.subtabLabel}` : ''}
            </h3>
            <ul className="space-y-1">
              {g.items.map((it, i) => (
                <li key={`${it.fieldKey}-${it.member ?? ''}-${i}`}>
                  <Link
                    href={href(g, it.fieldKey)}
                    onClick={onClose}
                    className="group flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors hover:border-brand-300 hover:bg-brand-50"
                  >
                    <Icon name="arrow-right" size={13} className="mt-[3px] shrink-0 text-ink-400 group-hover:text-brand-700" />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink-900">{it.label}</span>
                      <span className="text-ink-500">: {it.message}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <footer className="flex justify-end border-t border-line-soft px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </footer>
    </Overlay>
  );
}

function OptionalPagesDialog({
  optional,
  previewHref,
  onClose,
  onConfirm,
}: {
  optional: OptionalPage[];
  previewHref: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay labelledBy="files-send-optional" onClose={onClose}>
      <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#fdf1d8] text-[#8a5a09]">
          <Icon name="alert-triangle" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="files-send-optional" className="text-[16px] font-semibold text-ink-900">
            Send the proposal without {optional.length === 1 ? 'this page' : 'these pages'}?
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">
            {optional.length === 1 ? 'An optional page is' : 'Some optional pages are'} blank or not ticked, so the merchant won&rsquo;t see {optional.length === 1 ? 'it' : 'them'}.
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
          <Icon name="x" size={15} />
        </button>
      </header>
      <ul className="space-y-1.5 px-5 py-4">
        {optional.map((o) => (
          <li key={o.page} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
            <Icon name="file-text" size={13} className="mt-[3px] shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-ink-900">{o.page}</span>
              <span className="text-ink-500">: {o.reason}.</span>
            </span>
            {o.href ? (
              <Link href={o.href} onClick={onClose} className="shrink-0 text-[12px] font-semibold text-brand-700 hover:underline">
                Go to it
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-5 py-3">
        <a href={previewHref} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-500 hover:text-brand-700">
          <Icon name="eye" size={13} /> Preview first
        </a>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="send" onClick={onConfirm}>
            Send anyway
          </Button>
        </div>
      </footer>
    </Overlay>
  );
}

