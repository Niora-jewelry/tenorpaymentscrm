'use client';

/**
 * To / Cc / Bcc: addresses as chips. Typing suggests people this person has
 * actually corresponded with; Enter, Tab, comma or semicolon commits;
 * pasting a list ("Ann <a@x.com>, b@y.io") splits it. Something that is not
 * an address stays visible as a red chip — never silently dropped — and
 * blocks Send until it is fixed or removed.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { Addr } from '@/lib/mail/viewTypes';
import { parseRecipients } from '@/lib/mail/compose/recipients';
import { suggestRecipientsAction } from '../composeActions';
import { swatchFor } from './people';

export type Chip = Addr & { invalid?: boolean };

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus = false,
  trailing,
}: {
  label: string;
  value: Chip[];
  onChange: (next: Chip[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Addr[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const req = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 1 || /[,;]/.test(q)) return;
    const n = ++req.current;
    const t = setTimeout(async () => {
      const res = await suggestRecipientsAction({ q });
      if (n !== req.current) return;
      const taken = new Set(value.map((v) => v.address.toLowerCase()));
      setSuggestions(res.filter((r) => !taken.has(r.address.toLowerCase())));
      setActive(0);
    }, 180);
    return () => clearTimeout(t);
  }, [text, value]);

  const commit = (raw: string) => {
    if (!raw.trim()) return;
    const { valid, invalid } = parseRecipients(raw);
    const taken = new Set(value.map((v) => v.address.toLowerCase()));
    const add: Chip[] = [...valid.filter((v) => !taken.has(v.address)), ...invalid.map((s) => ({ name: '', address: s, invalid: true }))];
    if (add.length) onChange([...value, ...add]);
    setText('');
    setSuggestions([]);
  };

  const pick = (a: Addr) => {
    onChange([...value, a]);
    setText('');
    setSuggestions([]);
    input.current?.focus();
  };

  const open = suggestions.length > 0 && text.trim().length > 0;

  return (
    <div className="relative flex items-start gap-2 border-b border-line-faint px-5 py-1.5">
      <label htmlFor={`rcpt-${label}`} className="w-9 shrink-0 pt-[7px] text-[12.5px] font-medium text-ink-400">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-[3px]" onClick={() => input.current?.focus()}>
        {value.map((c, i) => (
          <span
            key={`${c.address}-${i}`}
            title={c.invalid ? 'Not an email address' : c.address}
            className={`inline-flex max-w-full items-center gap-1 rounded-full border py-[1px] pl-1 pr-1.5 text-[12.5px] ${
              c.invalid ? 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]' : 'border-line bg-canvas text-ink-800'
            }`}
          >
            {c.invalid ? (
              <Icon name="alert-triangle" size={11} className="ml-0.5" />
            ) : (
              <span
                aria-hidden
                className="grid size-[18px] place-items-center rounded-full text-[9px] font-bold"
                style={{ background: swatchFor(c.address).bg, color: swatchFor(c.address).text }}
              >
                {(c.name || c.address)[0]?.toUpperCase()}
              </span>
            )}
            <span className="truncate">{c.name || c.address}</span>
            <button
              type="button"
              aria-label={`Remove ${c.name || c.address}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
              }}
              className="grid size-4 place-items-center rounded-full opacity-60 hover:bg-white hover:opacity-100"
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <input
          id={`rcpt-${label}`}
          ref={input}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          onKeyDown={(e) => {
            if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, suggestions.length - 1) : Math.max(a - 1, 0)));
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && open) {
              e.preventDefault();
              pick(suggestions[active]);
              return;
            }
            if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) {
              if (text.trim()) {
                e.preventDefault();
                commit(text);
              }
              return;
            }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
            if (e.key === 'Escape') setSuggestions([]);
          }}
          // Synchronous, so typing an address and clicking Send straight away still sends to it
          // (suggestions keep focus with preventDefault, so picking one never blurs).
          onBlur={(e) => commit(e.currentTarget.value)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`rcpt-${label}-list`}
          className="min-w-[140px] flex-1 bg-transparent py-1 text-[13px] text-ink-900 outline-none"
        />
      </div>
      {trailing ? <div className="shrink-0 pt-[5px]">{trailing}</div> : null}

      {open ? (
        <ul id={`rcpt-${label}-list`} role="listbox" aria-label="Suggestions" className="absolute left-14 top-full z-30 mt-1 w-[min(380px,calc(100%-4rem))] rounded-xl border border-line bg-white p-1 shadow-[0_12px_32px_-8px_rgba(8,32,47,.22)]">
          {suggestions.map((s, i) => (
            <li key={s.address} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${i === active ? 'bg-brand-50' : 'hover:bg-canvas'}`}
              >
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold"
                  style={{ background: swatchFor(s.address).bg, color: swatchFor(s.address).text }}
                >
                  {(s.name || s.address)[0]?.toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-ink-900">{s.name || s.address}</span>
                  {s.name ? <span className="block truncate text-[11.5px] text-ink-400">{s.address}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
