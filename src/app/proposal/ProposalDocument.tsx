/**
 * The proposal as the merchant reads it — the client's "Proposal packet"
 * template, rebuilt as a mobile-friendly page in Tenor's colours (client,
 * 3 Nov 2026). Used three ways: the merchant's link, the CRM preview before
 * sending, and the CRM's copy of one already sent. Only the closing page's
 * action differs, so it is passed in.
 *
 * Pages: Cover and Savings Analysis always; POS Architecture and Detailed POS
 * when the content carries them; Closing always.
 */
import type { ReactNode } from 'react';
import { Lato } from 'next/font/google';
import {
  count,
  HEADLINE,
  MISSION,
  money,
  percent,
  TAGLINE,
  type ProposalContent,
  type SavingsRow,
} from '@/lib/proposals/content';

const lato = Lato({ subsets: ['latin'], weight: ['400', '700', '900'], display: 'swap' });

const NAVY = '#102347';

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function ProposalDocument({ content, label, closingAction }: { content: ProposalContent; label: string; closingAction: ReactNode }) {
  const pages: ReactNode[] = [
    <SavingsPage key="savings" content={content} />,
    ...(content.pos ? [<PosPage key="pos" pos={content.pos} />] : []),
    ...(content.detailedPos ? [<DetailedPosPage key="dpos" rows={content.detailedPos.rows} />] : []),
  ];
  return (
    <div className={`${lato.className} min-h-screen bg-[#e9edf3] text-[#1f2a3d] [font-variant-numeric:tabular-nums]`}>
      <div className="mx-auto flex max-w-[880px] flex-col gap-0 sm:gap-8 sm:px-6 sm:py-10">
        <Cover content={content} label={label} />
        {pages.map((p, i) => (
          <Sheet key={i} page={i + 2}>
            {p}
          </Sheet>
        ))}
        <Closing content={content} action={closingAction} />
      </div>
    </div>
  );
}

// ── frame ───────────────────────────────────────────────────────────────────

function Sheet({ children, page }: { children: ReactNode; page: number }) {
  return (
    <section className="overflow-hidden bg-white shadow-[0_1px_2px_rgba(16,35,71,.06),0_12px_32px_-12px_rgba(16,35,71,.18)] sm:rounded-2xl">
      <div className="px-5 pb-10 pt-8 sm:px-12 sm:pb-12 sm:pt-11">{children}</div>
      <footer className="flex items-center justify-between px-5 py-3.5 sm:px-12" style={{ background: NAVY }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file; next/image adds nothing at this size */}
        <img src="/brand/tenor-logo-white.png" alt="Tenor" className="h-[22px] w-auto" />
        <span className="text-[11px] font-bold text-white/70">{page}</span>
      </footer>
    </section>
  );
}

function Mark({ size = 34, className = '' }: { size?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a static brand file
  return <img src="/brand/tenor-mark-navy.png" alt="" aria-hidden style={{ width: size }} className={`h-auto shrink-0 ${className}`} />;
}

function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-3.5 text-[22px] font-black uppercase tracking-[.08em] sm:text-[26px]" style={{ color: NAVY }}>
      <Mark size={38} />
      {children}
    </h2>
  );
}

/** The thin blue rule with a notch, from the template's dividers. */
function Rule() {
  return (
    <div aria-hidden className="relative my-6 h-[3px] bg-[#1b84c6]">
      <span className="absolute left-[7%] top-[-3px] h-[9px] w-[10px] -skew-x-[35deg]" style={{ background: NAVY }} />
    </div>
  );
}

// ── cover ───────────────────────────────────────────────────────────────────

function Cover({ content, label }: { content: ProposalContent; label: string }) {
  return (
    <section className="overflow-hidden bg-white shadow-[0_1px_2px_rgba(16,35,71,.06),0_12px_32px_-12px_rgba(16,35,71,.18)] sm:rounded-2xl">
      <div className="flex items-center justify-end px-5 py-5 sm:px-12 sm:py-7">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
        <img src="/brand/tenor-logo-navy.png" alt="Tenor Payments" className="h-[34px] w-auto sm:h-[44px]" />
      </div>
      <div className="relative isolate overflow-hidden px-6 py-16 text-center sm:py-24" style={{ background: NAVY }}>
        {/* The template's faded dashboard, drawn as a quiet grid instead of a screenshot. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 opacity-[.13]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,.55) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.55) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage: 'radial-gradient(ellipse 70% 65% at 50% 50%, #000 25%, transparent 75%)',
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
        <img src="/brand/tenor-mark-white.png" alt="" aria-hidden className="absolute -right-10 -top-8 -z-10 w-[260px] opacity-[.05]" />
        <h1 className="mx-auto max-w-[640px] text-balance text-[34px] font-black leading-[1.08] text-white sm:text-[52px]">
          {content.merchantName}
          <span className="mt-1 block uppercase tracking-[.02em]">Proposal</span>
        </h1>
        <p className="mt-6 text-[11.5px] font-bold uppercase tracking-[.22em] text-[#c8f169] sm:text-[13px]">{TAGLINE}</p>
      </div>
      <div className="h-[6px] bg-[#1b84c6]" />
      <dl className="grid grid-cols-2 gap-4 px-5 py-6 text-[12.5px] sm:px-12 sm:py-8">
        <div>
          <dt className="font-bold uppercase tracking-[.12em] text-[#6b7a90]">Prepared</dt>
          <dd className="mt-1 font-bold" style={{ color: NAVY }}>
            {longDate(content.preparedOn)}
          </dd>
        </div>
        <div className="text-right">
          <dt className="font-bold uppercase tracking-[.12em] text-[#6b7a90]">Proposal</dt>
          <dd className="mt-1 font-bold" style={{ color: NAVY }}>
            {label}
          </dd>
        </div>
      </dl>
    </section>
  );
}

// ── savings analysis ────────────────────────────────────────────────────────

const volume = (r: SavingsRow) => (r.volumeKind === 'money' ? money(r.volume) : r.volumeKind === 'count' ? count(r.volume) : '—');
const rate = (r: SavingsRow, v: number | null) => (r.rateKind === 'percent' ? percent(v) : r.rateKind === 'money' ? money(v) : '—');
const savingsTone = (n: number) => (n < 0 ? 'text-[#b42318]' : 'text-[#2e8b57]');

function SavingsPage({ content }: { content: ProposalContent }) {
  const s = content.savings;
  const head = 'px-3 py-2.5 text-right text-[12px] font-bold text-white first:text-left';
  return (
    <>
      <PageTitle>Savings Analysis</PageTitle>
      <p className="mt-6 whitespace-pre-line text-[14px] leading-relaxed text-[#4a5568]">{s.description}</p>

      {/* Wide screens: the template's table, upper column groups removed (client). */}
      <div className="mt-7 hidden overflow-hidden rounded-lg ring-1 ring-[#dfe5ee] sm:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th scope="col" className={`${head} bg-[#0b1a36]`}>Item</th>
              <th scope="col" className={`${head} bg-[#0b1a36]`}>Current volume</th>
              <th scope="col" className={head} style={{ background: NAVY }}>Current rate</th>
              <th scope="col" className={head} style={{ background: NAVY }}>Current cost</th>
              <th scope="col" className={`${head} bg-[#24467d]`}>Proposed rate</th>
              <th scope="col" className={`${head} bg-[#24467d]`}>Proposed cost</th>
              <th scope="col" className={`${head} bg-[#1b84c6]`}>Savings</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.item} className="border-b border-[#e6ebf2]">
                <th scope="row" className="bg-[#f6f8fb] px-3 py-2.5 text-left font-bold" style={{ color: NAVY }}>{r.item}</th>
                <td className="bg-[#f6f8fb] px-3 py-2.5 text-right">{volume(r)}</td>
                <td className="px-3 py-2.5 text-right">{rate(r, r.currentRate)}</td>
                <td className="px-3 py-2.5 text-right">{money(r.currentCost)}</td>
                <td className="bg-[#eef4fb] px-3 py-2.5 text-right">{rate(r, r.proposedRate)}</td>
                <td className="bg-[#eef4fb] px-3 py-2.5 text-right">{money(r.proposedCost)}</td>
                <td className={`px-3 py-2.5 text-right font-bold ${savingsTone(r.savings)}`}>{money(r.savings)}</td>
              </tr>
            ))}
            <tr className="border-t-2" style={{ borderColor: NAVY }}>
              <th scope="row" className="bg-[#f6f8fb] px-3 py-3 text-left font-black" style={{ color: NAVY }}>Monthly Totals</th>
              <td className="bg-[#f6f8fb] px-3 py-3" />
              <td className="px-3 py-3" />
              <td className="px-3 py-3 text-right font-black">{money(s.totals.currentCost)}</td>
              <td className="bg-[#eef4fb] px-3 py-3" />
              <td className="bg-[#eef4fb] px-3 py-3 text-right font-black">{money(s.totals.proposedCost)}</td>
              <td className={`px-3 py-3 text-right font-black ${savingsTone(s.totals.savings)}`}>{money(s.totals.savings)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Phones: one card a row, same figures. */}
      <div className="mt-6 space-y-3 sm:hidden">
        {s.rows.map((r) => (
          <article key={r.item} className="overflow-hidden rounded-lg ring-1 ring-[#dfe5ee]">
            <header className="flex items-center justify-between bg-[#0b1a36] px-3.5 py-2.5 text-white">
              <h3 className="text-[13.5px] font-bold">{r.item}</h3>
              {r.volumeKind ? <span className="text-[12px] text-white/75">Volume {volume(r)}</span> : null}
            </header>
            <dl className="grid grid-cols-2 text-[13px]">
              <div className="border-b border-r border-[#e6ebf2] px-3.5 py-2.5">
                <dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[#6b7a90]">Current</dt>
                <dd className="mt-0.5">
                  {r.rateKind ? <span className="text-[#6b7a90]">{rate(r, r.currentRate)} · </span> : null}
                  <span className="font-bold">{money(r.currentCost)}</span>
                </dd>
              </div>
              <div className="border-b border-[#e6ebf2] bg-[#eef4fb] px-3.5 py-2.5">
                <dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[#6b7a90]">Proposed</dt>
                <dd className="mt-0.5">
                  {r.rateKind ? <span className="text-[#6b7a90]">{rate(r, r.proposedRate)} · </span> : null}
                  <span className="font-bold">{money(r.proposedCost)}</span>
                </dd>
              </div>
              <div className="col-span-2 flex items-center justify-between px-3.5 py-2.5">
                <dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[#6b7a90]">Savings</dt>
                <dd className={`font-black ${savingsTone(r.savings)}`}>{money(r.savings)}</dd>
              </div>
            </dl>
          </article>
        ))}
        <div className="flex items-center justify-between rounded-lg px-3.5 py-3 text-white" style={{ background: NAVY }}>
          <span className="text-[13px] font-black">Monthly Totals</span>
          <span className="text-right text-[12px] leading-tight text-white/80">
            {money(s.totals.currentCost)} → {money(s.totals.proposedCost)}
          </span>
        </div>
      </div>

      <div className="mt-8 grid overflow-hidden rounded-xl border-2 border-[#1b84c6] sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
        <Saving label="Monthly savings" value={s.monthly} />
        <Mark size={26} className="hidden sm:block" />
        <Saving label="Annual savings" value={s.annual} />
        <Mark size={26} className="hidden sm:block" />
        <Saving label="3-year savings" value={s.threeYear} />
      </div>
    </>
  );
}

function Saving({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-b border-[#dfe5ee] px-4 py-4 text-center last:border-b-0 sm:border-b-0 sm:py-5">
      <p className="text-[12.5px] font-black uppercase tracking-[.1em] text-[#1b84c6]">{label}</p>
      <p className={`mt-1 text-[22px] font-black ${value < 0 ? 'text-[#b42318]' : ''}`} style={value < 0 ? undefined : { color: NAVY }}>
        {money(value)}
      </p>
    </div>
  );
}

// ── POS architecture ────────────────────────────────────────────────────────

function Tick({ ok }: { ok: boolean }) {
  return ok ? (
    <svg viewBox="0 0 16 16" aria-label="Included" role="img" className="mt-[3px] size-[15px] shrink-0 text-[#2e8b57]">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-label="Not included" role="img" className="mt-[3px] size-[15px] shrink-0 text-[#c62828]">
      <circle cx="8" cy="8" r="7.5" fill="currentColor" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function Checklist({ title, items, tone }: { title: string; items: { text: string; check: boolean }[]; tone: 'green' | 'blue' }) {
  if (!items.length) return null;
  return (
    <div className={`mt-6 rounded-xl border-2 px-4 py-4 sm:px-5 ${tone === 'green' ? 'border-[#2e8b57]/70' : 'border-[#1b84c6]/70'}`}>
      <h3 className="text-[14px] font-black" style={{ color: tone === 'green' ? NAVY : '#1b84c6' }}>
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug text-[#3b4658]">
            <Tick ok={it.check} />
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PosPage({ pos }: { pos: NonNullable<ProposalContent['pos']> }) {
  return (
    <>
      <PageTitle>POS Architecture</PageTitle>
      <h3 className="mt-7 text-[14px] font-black uppercase tracking-[.06em]" style={{ color: NAVY }}>
        Tenor Recommended Solution
      </h3>
      <p className="mt-2 whitespace-pre-line text-[14px] leading-relaxed text-[#4a5568]">{pos.description}</p>
      <Checklist title="Merchant Requested Requirements" items={pos.requirements} tone="green" />
      <Checklist title="Tenor Additional Features" items={pos.features} tone="blue" />
    </>
  );
}

// ── detailed POS ────────────────────────────────────────────────────────────

function DetailedPosPage({ rows }: { rows: NonNullable<ProposalContent['detailedPos']>['rows'] }) {
  const cell = (n: number | null) => (n === null ? '' : money(n));
  return (
    <>
      <div className="-mx-5 -mt-8 px-5 pb-8 pt-8 text-white sm:-mx-12 sm:-mt-11 sm:px-12 sm:pt-11" style={{ background: NAVY }}>
        <h2 className="text-[22px] font-black uppercase leading-tight sm:text-[28px]">{HEADLINE}</h2>
        <p className="mt-2 text-[12.5px] font-bold uppercase tracking-[.14em] text-[#c8f169]">{TAGLINE}</p>
        <Rule />
        <p className="text-[13.5px] leading-relaxed text-white/85">{MISSION}</p>
      </div>

      <div className="mt-8 hidden overflow-hidden rounded-lg ring-1 ring-[#dfe5ee] sm:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-[#1b84c6] text-white">
              <th scope="col" className="px-3 py-2.5 text-left font-bold">Product Name</th>
              <th scope="col" className="px-3 py-2.5 text-right font-bold">Amount</th>
              <th scope="col" className="px-3 py-2.5 text-right font-bold">Hardware Cost</th>
              <th scope="col" className="px-3 py-2.5 text-right font-bold">Setup Fee</th>
              <th scope="col" className="px-3 py-2.5 text-right font-bold">Monthly Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[#e6ebf2] last:border-b-0">
                <th scope="row" className="px-3 py-2.5 text-left font-normal">{r.product}</th>
                <td className="px-3 py-2.5 text-right">{r.amount === null ? '' : count(r.amount)}</td>
                <td className="px-3 py-2.5 text-right">{cell(r.hardwareCost)}</td>
                <td className="px-3 py-2.5 text-right">{cell(r.setupFee)}</td>
                <td className="px-3 py-2.5 text-right font-bold">{cell(r.monthlyCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-6 space-y-3 sm:hidden">
        {rows.map((r, i) => (
          <li key={i} className="overflow-hidden rounded-lg ring-1 ring-[#dfe5ee]">
            <p className="bg-[#1b84c6] px-3.5 py-2 text-[13.5px] font-bold text-white">{r.product}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-3 text-[13px]">
              {(
                [
                  ['Amount', r.amount === null ? '' : count(r.amount)],
                  ['Hardware cost', cell(r.hardwareCost)],
                  ['Setup fee', cell(r.setupFee)],
                  ['Monthly cost', cell(r.monthlyCost)],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[#6b7a90]">{k}</dt>
                  <dd className="mt-0.5 font-bold">{v || '—'}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

// ── closing ─────────────────────────────────────────────────────────────────

function Closing({ content, action }: { content: ProposalContent; action: ReactNode }) {
  const c = content.closing;
  return (
    <section className="overflow-hidden px-6 py-12 text-white shadow-[0_12px_32px_-12px_rgba(16,35,71,.35)] sm:rounded-2xl sm:px-14 sm:py-16" style={{ background: NAVY }}>
      <h2 className="text-[26px] font-black uppercase leading-[1.12] sm:text-[34px]">
        Real support.
        <br />
        Real results. Real savings.
      </h2>
      <p className="mt-3 text-[12.5px] font-bold uppercase tracking-[.14em] text-[#c8f169] sm:text-[14px]">{TAGLINE}</p>
      <Rule />
      <p className="max-w-[620px] text-[14px] leading-relaxed text-white/85">{MISSION}</p>
      <div className="mt-8">{action}</div>
      <Rule />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-7">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
        <img src="/brand/tenor-logo-white.png" alt="Tenor Payments" className="h-[34px] w-auto self-start sm:h-[40px] sm:self-auto" />
        <div className="text-[13.5px] leading-relaxed">
          <p className="font-bold text-[#c8f169]">
            <a href={`mailto:${c.email}`} className="hover:underline">
              {c.email.toUpperCase()}
            </a>
            <span className="mx-2 text-white/40">|</span>
            <a href={`tel:${c.phone.replace(/\D/g, '')}`} className="hover:underline">
              {c.phone}
            </a>
          </p>
          <p className="text-white/85">{c.address}</p>
        </div>
      </div>
    </section>
  );
}

