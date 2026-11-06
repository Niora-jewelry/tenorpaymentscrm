'use client';

/** The small pieces every list on the Phone page uses, so they look like one page. */
import { Icon, type IconName } from '@/proto/ui/icons';

export function SearchBox({
  value,
  onChange,
  label,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon
        name="search"
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search name or number"
        className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-[13.5px] text-ink-900 outline-none transition-[border,box-shadow] placeholder:text-ink-300 focus-field"
      />
    </label>
  );
}

/** A small rounded action on a list row: plainly a button, quieter than the row's name. */
export function RowButton({
  icon,
  label,
  onClick,
  tone = 'plain',
  disabled,
  hideLabelOnSmall,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: 'plain' | 'brand';
  disabled?: boolean;
  hideLabelOnSmall?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={hideLabelOnSmall ? label : undefined}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'brand'
          ? 'border-brand-600/15 bg-brand-50 text-brand-700 hover:border-brand-600/30 hover:bg-brand-100'
          : 'border-line bg-white text-ink-700 hover:border-ink-300 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      <Icon name={icon} size={12} strokeWidth={2.1} />
      <span className={hideLabelOnSmall ? 'hidden sm:inline' : undefined}>{label}</span>
    </button>
  );
}

/** An empty or no-match state sized for a panel, not a page. */
export function PanelEmpty({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-canvas text-ink-400">
        <Icon name={icon} size={17} />
      </span>
      <p className="mt-3 text-[13.5px] font-semibold text-ink-700">{title}</p>
      <p className="mt-1 max-w-[340px] text-[12.5px] leading-relaxed text-ink-400">{body}</p>
    </div>
  );
}
