'use client';
/**
 * Shared bits for the Residuals workspace: money formatting, panels, pills and flag colours.
 */
import type { ReactNode } from 'react';
import type { FlagColor, RiskLevel } from '@/lib/residuals/calc/types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: number | null | undefined) => (n == null ? '—' : usd.format(n));
export const plain = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
export const percent = (fraction: number | null | undefined) =>
  fraction == null ? '—' : `${(fraction * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const RISK_LABEL: Record<RiskLevel, string> = {
  no_risk: 'No Risk',
  low_risk: 'Low Risk',
  moderate_risk: 'Moderate Risk',
  high_risk: 'High Risk',
};

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-xl border border-line bg-white ${className}`}>{children}</section>;
}

export function PanelHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line-soft px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="truncate text-[14.5px] font-semibold text-ink-900">{title}</h3>
        {sub && <p className="mt-0.5 text-[12.5px] text-ink-500">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'brand';
const TONE: Record<Tone, string> = {
  neutral: 'border-line bg-canvas text-ink-700',
  ok: 'border-transparent bg-ok-bg text-ok',
  warn: 'border-transparent bg-warn-bg text-warn',
  bad: 'border-transparent bg-bad-bg text-bad',
  brand: 'border-transparent bg-brand-100 text-brand-800',
};
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-semibold ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function RiskPill({ risk }: { risk: RiskLevel | null }) {
  return risk ? <Pill>{RISK_LABEL[risk]}</Pill> : <Pill tone="bad">Blank</Pill>;
}

export const FLAG_DOT: Record<FlagColor, string> = {
  red: 'bg-bad',
  orange: 'bg-warn',
  light_red: 'bg-bad/45',
  light_green: 'bg-ok/60',
  green: 'bg-ok',
};
export const FLAG_ROW: Record<FlagColor, string> = {
  red: 'bg-bad-bg/70',
  orange: 'bg-warn-bg/70',
  light_red: 'bg-bad-bg/35',
  light_green: 'bg-ok-bg/50',
  green: 'bg-ok-bg/70',
};
export const FLAG_TONE: Record<FlagColor, Tone> = { red: 'bad', orange: 'warn', light_red: 'bad', light_green: 'ok', green: 'ok' };

export function FlagDot({ color }: { color: FlagColor | null }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color ? FLAG_DOT[color] : 'border border-line bg-white'}`} />;
}

export function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl border px-4 py-3.5 ${accent ? 'border-transparent bg-brand-900 text-white' : 'border-line bg-white'}`}>
      <div className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${accent ? 'text-brand-200' : 'text-ink-400'}`}>{label}</div>
      <div className="tabular mt-1.5 truncate text-[22px] font-bold leading-tight">{value}</div>
      {sub && <div className={`mt-1 truncate text-[12px] ${accent ? 'text-brand-200' : 'text-ink-500'}`}>{sub}</div>}
    </div>
  );
}

export function Th({ children, right, className = '' }: { children?: ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-400 ${right ? 'text-right' : 'text-left'} ${className}`}>
      {children}
    </th>
  );
}
