'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import type { ConnectionScreen } from '@/lib/processors/service';
import { findRecordsForMatchAction, matchMerchantAction, syncNowAction } from './actions';

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—';

const OUTCOME: Record<string, { label: string; cls: string }> = {
  ok: { label: 'All updated', cls: 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' },
  partial: { label: 'Some failed', cls: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' },
  failed: { label: 'Failed', cls: 'border-bad/20 bg-bad-bg text-bad' },
};
const outcomeOf = (o: string | null) => (o ? OUTCOME[o] ?? { label: o, cls: 'border-line bg-canvas text-ink-600' } : { label: 'Running', cls: 'border-line bg-canvas text-ink-500' });

/**
 * Integrations › Maverick Payments. `main` is the Main connector subtab (health,
 * each kind of data, recent runs); `individual` is Individual connectors (each
 * Maverick merchant matched to its record). Both by default.
 */
export function MaverickConnection({ screen, adapterReady, part = 'all' }: { screen: ConnectionScreen; adapterReady: boolean; part?: 'all' | 'main' | 'individual' }) {
  const router = useRouter();
  const [syncing, startSync] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const syncNow = () =>
    startSync(async () => {
      setNotice(null);
      const r = await syncNowAction();
      if (!r.ok) return setNotice({ ok: false, text: r.message });
      setNotice(r.data.ran ? { ok: true, text: 'The sync ran. The results are below.' } : { ok: false, text: `Nothing ran: ${r.data.reason ?? 'unknown reason'}.` });
      router.refresh();
    });

  if (part === 'individual') return screen.canResolve ? <Unmatched items={screen.unmatched} /> : null;

  return (
    <div className="space-y-6">
      {/* Status strip */}
      <section className="rounded-panel border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name="briefcase" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold text-ink-900">{screen.label} Payments</p>
            <p className="text-[12.5px] text-ink-500">
              {!screen.connected
                ? 'Not connected. Enter the API key and switch Maverick on.'
                : !adapterReady
                  ? 'Key saved, but nothing is fetched yet. Maverick’s firewall is stopping API requests, and only Maverick can change that. Press Test connection to check again.'
                  : 'Connected. Updates daily at 7 AM New York time.'}
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold ${
              screen.connected && adapterReady ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
            }`}
          >
            {screen.connected ? (adapterReady ? 'Connected' : 'Waiting for API') : 'Not connected'}
          </span>
          {screen.canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon="refresh-cw" loading={syncing} loadingLabel="Syncing…" disabled={syncing || !screen.connected || !adapterReady} onClick={syncNow}>
                Sync now
              </Button>
            </div>
          ) : null}
        </div>
        {notice ? (
          <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-[12.5px] ${notice.ok ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'}`}>
            {notice.text}
          </p>
        ) : null}
      </section>

      {/* Per data type */}
      {screen.canManage ? (
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-ink-900">Each kind of data</h2>
          <div className="overflow-x-auto rounded-panel border border-line bg-white">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line-soft bg-canvas text-[11.5px] font-semibold uppercase tracking-[.05em] text-ink-400">
                <tr>
                  <th className="px-4 py-2.5">Data</th>
                  <th className="px-4 py-2.5">Last good update</th>
                  <th className="px-4 py-2.5">Last attempt</th>
                  <th className="px-4 py-2.5">Problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {screen.states.map((s) => (
                  <tr key={s.type}>
                    <td className="px-4 py-2.5 font-semibold text-ink-900">{s.label}</td>
                    <td className="px-4 py-2.5 text-ink-700">{when(s.lastSuccess)}</td>
                    <td className="px-4 py-2.5 text-ink-500">{when(s.lastAttempt)}</td>
                    <td className="px-4 py-2.5">
                      {s.error ? <span className="text-bad">{s.error}</span> : s.lastAttempt ? <span className="text-[#0b6b5d]">None</span> : <span className="text-ink-300">Never run</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Recent runs */}
      {screen.canManage ? (
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-ink-900">Recent daily runs</h2>
          {screen.runs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line bg-white px-4 py-6 text-center text-[13px] text-ink-500">No run yet.</p>
          ) : (
            <ul className="space-y-2">
              {screen.runs.map((r) => {
                const o = outcomeOf(r.outcome);
                const failed = Object.entries(r.summary).filter(([, v]) => !v.ok);
                return (
                  <li key={r.id} className="rounded-xl border border-line bg-white px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink-900">{when(r.startedAt)}</span>
                      <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${o.cls}`}>{o.label}</span>
                      {r.finishedAt ? <span className="text-[12px] text-ink-400">finished {when(r.finishedAt)}</span> : null}
                    </div>
                    {failed.length ? (
                      <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-bad">
                        {failed.map(([k, v]) => (
                          <li key={k}>
                            {k}: {v.error ?? 'failed'}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {/* Unmatched */}
      {part === 'all' && screen.canResolve ? <Unmatched items={screen.unmatched} /> : null}
    </div>
  );
}

function Unmatched({ items }: { items: ConnectionScreen['unmatched'] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">Merchants not matched to a record</h2>
        <p className="text-[12.5px] text-ink-500">
          Maverick knows these merchants, but no record has their MID. Match each to its record; its data then shows on that record’s Reporting tab.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-4 py-6 text-center text-[13px] text-ink-500">Every merchant is matched.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.id} className="rounded-xl border border-line bg-white">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink-900">{m.name ?? 'Unnamed merchant'}</p>
                  <p className="text-[12px] text-ink-400">
                    MID {m.mid ?? '—'} · Maverick ID {m.externalId} · first seen {when(m.firstSeen)}
                  </p>
                </div>
                <Button size="sm" variant={open === m.id ? 'ghost' : 'primary'} icon="link" onClick={() => setOpen(open === m.id ? null : m.id)}>
                  {open === m.id ? 'Cancel' : 'Match to a record'}
                </Button>
              </div>
              {open === m.id ? <MatchSearch merchantId={m.id} initial={m.mid ?? m.name ?? ''} onDone={() => setOpen(null)} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MatchSearch({ merchantId, initial, onDone }: { merchantId: string; initial: string; onDone: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<{ id: string; name: string; mid: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    const n = ++seq.current;
    const t = setTimeout(async () => {
      if (term.length < 2) {
        if (n === seq.current) setResults(null);
        return;
      }
      const r = await findRecordsForMatchAction(term);
      if (n !== seq.current) return;
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setError(null);
      setResults(r.data);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (recordId: string) =>
    start(async () => {
      const r = await matchMerchantAction({ merchantId, recordId });
      if (!r.ok) return setError(r.message);
      onDone();
      router.refresh();
    });

  return (
    <div className="space-y-2 border-t border-line-soft px-4 py-3">
      <label className="block text-[12px] font-semibold uppercase tracking-[.05em] text-ink-400">
        Find the record by name or MID
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] normal-case tracking-normal text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>
      {error ? <p role="alert" className="text-[12.5px] text-bad">{error}</p> : null}
      {results && results.length === 0 ? <p className="text-[12.5px] text-ink-500">No record you can open matches that.</p> : null}
      {results?.length ? (
        <ul className="divide-y divide-line-soft rounded-lg border border-line">
          {results.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink-900">{r.name || 'Unnamed record'}</p>
                {r.mid ? <p className="text-[12px] text-ink-400">MID {r.mid}</p> : null}
              </div>
              <Button size="sm" variant="primary" loading={pending} disabled={pending} onClick={() => pick(r.id)}>
                Match
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
