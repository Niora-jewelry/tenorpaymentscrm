/**
 * "How it works" — the permission model, on the screen where it is configured
 * (Permissions spec: user types, overrides, guardrails, audit).
 *
 * The worked example is a table of real outcomes rather than prose: "the
 * override wins" is abstract, and one row showing it is not.
 */
import { Icon } from '@/proto/ui/icons';

/** One row of the worked example. `override` of `null` means none was set. */
const EXAMPLE: {
  scope: string;
  type: string;
  override: string | null;
  result: string;
  because: string;
}[] = [
  { scope: 'Leads (module)', type: 'Only mine', override: null, result: 'Only mine', because: 'from her type' },
  { scope: 'Create new records', type: 'Yes', override: null, result: 'Yes', because: 'from her type' },
  { scope: 'Logins (tab)', type: 'Hidden', override: 'View', result: 'View', because: 'her override wins' },
  { scope: 'Updates', type: 'Only mine', override: null, result: 'Only mine', because: 'from her type' },
];

function Value({ value }: { value: string | null }) {
  if (value === null) return <span className="text-ink-300">none</span>;
  const tone =
    value === 'Hidden' || value === 'No' ? 'bg-canvas text-ink-500 ring-line'
    : value === 'View' || value === 'Only mine' ? 'bg-brand-50 text-brand-700 ring-brand-100'
    : 'bg-[#e6f6f2] text-[#0b6b5d] ring-[#bfe6dd]';
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-[1.5px] text-[11.5px] font-semibold ring-1 ring-inset ${tone}`}>
      {value}
    </span>
  );
}

export function HowPermissionsWork() {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex items-center gap-2 border-b border-line-soft bg-canvas/60 px-4 py-2.5">
        <Icon name="info" size={14} className="text-brand-600" />
        <h2 className="text-[13.5px] font-semibold text-ink-900">How permissions work</h2>
      </header>

      <div className="space-y-4 px-4 py-3.5">
        <div>
          <p className="text-[13px] leading-relaxed text-ink-600">
            Each setting, tab, sub-tab and field is worked out for each person, most specific first:
          </p>
          <ol className="mt-2.5 space-y-1.5">
            {[
              ['1', "That person's own override", 'set on their Permissions page — always wins, and is marked as an override'],
              ['2', 'Their user type', 'change a type and everyone on it gets the change, except where they have an override'],
              ['3', 'Otherwise the most restrictive value', 'for a setting; a tab or field nobody has set is Edit, inside what the module allows'],
            ].map(([n, title, note]) => (
              <li key={n} className="flex items-start gap-2.5 text-[13px]">
                <span className="mt-[1px] grid size-[18px] shrink-0 place-items-center rounded-full bg-brand-50 text-[10.5px] font-bold text-brand-700">
                  {n}
                </span>
                <span className="text-ink-700">
                  <strong className="font-semibold text-ink-900">{title}</strong>
                  <span className="text-ink-500"> — {note}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="overflow-hidden rounded-lg border border-line-soft">
          <p className="border-b border-line-soft bg-canvas/50 px-3 py-2 text-[12.5px] text-ink-600">
            <strong className="font-semibold text-ink-900">Example.</strong> Maya is a Sales agent. An admin has
            given her one override, on Logins.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[12.5px]">
              <thead>
                <tr>
                  {['Setting', 'Sales agent says', "Maya's override", 'Maya gets', 'Why'].map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap border-b border-line-soft bg-white px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[.04em] text-ink-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EXAMPLE.map((row) => (
                  <tr key={row.scope}>
                    <td className="whitespace-nowrap border-b border-line-faint px-3 py-2 font-medium text-ink-900">{row.scope}</td>
                    <td className="border-b border-line-faint px-3 py-2"><Value value={row.type} /></td>
                    <td className="border-b border-line-faint px-3 py-2"><Value value={row.override} /></td>
                    <td className="border-b border-line-faint px-3 py-2"><Value value={row.result} /></td>
                    <td className="whitespace-nowrap border-b border-line-faint px-3 py-2 text-ink-500">{row.because}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-600">
          {[
            <>
              <strong className="font-semibold text-ink-900">A Super admin has everything.</strong> No setting
              lowers it; to limit someone, change their user type.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Nobody changes their own permissions</strong>, or
              the user type they are on, and nobody can give more than they have themselves.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Only a Super admin</strong> can change, remove or
              create a Super admin, and there is always at least one.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Narrower never widens.</strong> A sub-tab can only
              restrict further than its tab, and a field further than its sub-tab.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Only mine</strong> means records they are a team
              member or the relationship manager on.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Every change is logged</strong> — who, when, and the
              value before and after. The History on each page shows it.
            </>,
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span aria-hidden className="mt-[7px] size-[4px] shrink-0 rounded-full bg-ink-300" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
