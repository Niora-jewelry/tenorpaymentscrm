'use client';

/**
 * A field's history on this record: who changed it, when, from what to what —
 * and where the value came from when it was not typed in the CRM
 * (Prepopulated Application spec: "Every value written from an application is
 * logged in the field history with its source … the user who accepted it and
 * the time"). Loaded when opened; nothing is fetched for a closed control.
 */
import { useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { usePeopleById } from '@/proto/ui/people';
import type { FieldHistoryEntry } from '@/lib/records/activity';
import { fieldHistoryAction } from './historyActions';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function FieldHistoryButton({ recordId, fieldKey, fieldLabel }: { recordId: string; fieldKey: string; fieldLabel: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; entries: FieldHistoryEntry[] | null; error: string | null }>({ loading: false, entries: null, error: null });
  const byId = usePeopleById();

  const load = () => {
    setState({ loading: true, entries: null, error: null });
    void fieldHistoryAction({ recordId, fieldKey }).then((r) =>
      setState(r.ok ? { loading: false, entries: r.entries, error: null } : { loading: false, entries: null, error: r.message }),
    );
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) load();
        }}
        aria-expanded={open}
        aria-label={`History of ${fieldLabel}`}
        title={`History of ${fieldLabel}`}
        className={`grid size-5 place-items-center rounded text-ink-400 transition-[opacity,color,background-color] hover:bg-brand-50 hover:text-brand-700 focus-visible:opacity-100 ${
          open ? 'bg-brand-50 text-brand-700 opacity-100' : 'opacity-0 group-hover/cell:opacity-100 [@media(hover:none)]:opacity-100'
        }`}
      >
        <Icon name="clock" size={11} strokeWidth={2} />
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={340} role="dialog" label={`History of ${fieldLabel}`}>
        <div className="px-2 pb-1 pt-1">
          <p className="text-[12px] font-semibold text-ink-800">History · {fieldLabel}</p>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {state.loading ? (
            <p className="flex items-center gap-2 px-2 py-3 text-[12px] text-ink-400">
              <Spinner /> Loading…
            </p>
          ) : state.error ? (
            <p className="px-2 py-3 text-[12px] text-bad">{state.error}</p>
          ) : state.entries && state.entries.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-ink-400">No changes recorded yet.</p>
          ) : (
            <ol className="divide-y divide-line-faint">
              {(state.entries ?? []).map((e) => {
                // No person behind it: the merchant (an answer that filled an
                // empty field) or a system change such as a data conversion.
                const who = e.actorId ? byId.get(e.actorId)?.name ?? 'Someone' : e.source?.startsWith('Application ') ? 'The merchant' : e.source?.startsWith('Automation: ') ? 'Automation' : 'System';
                return (
                  <li key={e.id} className="px-2 py-2">
                    <p className="flex items-baseline justify-between gap-2 text-[11.5px] text-ink-400">
                      <span className="truncate font-medium text-ink-700">{who}</span>
                      <time dateTime={e.at} className="shrink-0 tabular-nums">
                        {when(e.at)}
                      </time>
                    </p>
                    <p className="mt-0.5 break-words text-[12.5px] text-ink-800">
                      {e.from ? <span className="text-ink-400 line-through decoration-ink-300">{e.from}</span> : <span className="italic text-ink-300">empty</span>}
                      <span aria-hidden className="mx-1.5 text-ink-300">→</span>
                      {e.to ? <span className="font-medium">{e.to}</span> : <span className="italic text-ink-300">cleared</span>}
                    </p>
                    {e.source ? (
                      <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-px text-[11px] font-semibold text-brand-700">
                        <Icon name="file-pen" size={10} /> {e.source}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </MenuSurface>
    </>
  );
}
