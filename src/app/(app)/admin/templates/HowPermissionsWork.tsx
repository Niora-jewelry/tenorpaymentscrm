/**
 * "How it works" — the permission model, on the screen where it is configured.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * The resolution rule is three lines long and completely counter-intuitive in
 * one specific way: an EMPTY template restricts nothing. A scope with no entry
 * resolves to Edit, not Hidden, so an admin who creates "Sales Rep", attaches
 * six people to it and stops there has granted all six of them everything.
 *
 * That is the client's own specified behaviour and it is not going to change,
 * so the only defence is saying it plainly at the point of use. The worked
 * example is deliberately a table of real outcomes rather than prose: "override
 * wins" is abstract, and one row showing Hidden beaten by View is not.
 *
 * ── IT REPLACED A BANNER THAT WAS WRONG ──────────────────────────────────
 * The previous notice read "A template's grants can be read, not yet changed …
 * choosing those values is the next piece of work". That was true when it was
 * written and false by the time anyone read it — `setTemplateGrant` and
 * `clearTemplateGrant` shipped, and the matrix writes them. It told an admin a
 * working feature did not exist.
 */
import { Icon } from '@/proto/ui/icons';

/** One row of the worked example. `override` of `null` means none was set. */
const EXAMPLE: {
  scope: string;
  template: string | null;
  override: string | null;
  result: string;
  because: string;
}[] = [
  { scope: 'Leads (module)', template: 'Edit', override: null, result: 'Edit', because: 'from the template' },
  { scope: 'Logins (tab)', template: 'Hidden', override: null, result: 'Hidden', because: 'from the template' },
  { scope: 'Statements (tab)', template: 'Hidden', override: 'View', result: 'View', because: 'her override wins' },
  { scope: 'Pricing (tab)', template: null, override: null, result: 'Edit', because: 'nothing set — the default' },
];

function Level({ value }: { value: string | null }) {
  if (value === null) return <span className="text-ink-300">not set</span>;
  const tone =
    value === 'Hidden' ? 'bg-canvas text-ink-500 ring-line'
    : value === 'View' ? 'bg-brand-50 text-brand-700 ring-brand-100'
    : 'bg-[#e6f6f2] text-[#0b6b5d] ring-[#bfe6dd]';
  return (
    <span className={`inline-flex rounded-full px-2 py-[1.5px] text-[11.5px] font-semibold ring-1 ring-inset ${tone}`}>
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
            Every module, tab, subtab and field resolves to <strong>Hidden</strong>,{' '}
            <strong>View</strong> or <strong>Edit</strong> for each person, and it is worked out one
            scope at a time, most specific first:
          </p>
          <ol className="mt-2.5 space-y-1.5">
            {[
              ['1', "That person's own override", 'set on their Permissions screen — always wins'],
              ['2', 'Their template', 'live-linked, so editing it reaches everyone attached at once'],
              ['3', 'Otherwise Edit', 'the default when neither of the above says anything'],
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

        {/* The worked example. Concrete outcomes, because "the override wins" is
            abstract and one row showing Hidden beaten by View is not. */}
        <div className="overflow-hidden rounded-lg border border-line-soft">
          <p className="border-b border-line-soft bg-canvas/50 px-3 py-2 text-[12.5px] text-ink-600">
            <strong className="font-semibold text-ink-900">Example.</strong> Maya is attached to
            &ldquo;Sales Rep&rdquo;. An admin has given her one personal override, on Statements.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[12.5px]">
              <thead>
                <tr>
                  {['Scope', 'Sales Rep says', "Maya's override", 'Maya gets', 'Why'].map((h) => (
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
                    <td className="whitespace-nowrap border-b border-line-faint px-3 py-2 font-medium text-ink-900">
                      {row.scope}
                    </td>
                    <td className="border-b border-line-faint px-3 py-2"><Level value={row.template} /></td>
                    <td className="border-b border-line-faint px-3 py-2"><Level value={row.override} /></td>
                    <td className="border-b border-line-faint px-3 py-2"><Level value={row.result} /></td>
                    <td className="whitespace-nowrap border-b border-line-faint px-3 py-2 text-ink-500">
                      {row.because}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-600">
          {[
            <>
              <strong className="font-semibold text-ink-900">An empty template restricts nothing.</strong>{' '}
              A scope with no entry resolves to Edit, not Hidden — so a template with no grants
              attached to six people gives all six of them everything. Set what you want to
              restrict; leave the rest alone.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Editing a template is immediate.</strong>{' '}
              Everyone attached picks it up on their next request, with no re-assign step — except
              where they hold an override, which never gets replaced by a template change.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Clearing an override</strong> snaps that
              one scope back to following the template again, live.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Narrower never widens.</strong> A tab can
              only restrict further than its module, a subtab further than its tab, and a field
              further than its subtab. Granting Edit on a field inside a Hidden tab still leaves it
              hidden.
            </>,
            <>
              <strong className="font-semibold text-ink-900">A grant can apply everywhere, or to
              one module.</strong>{' '}
              “All modules” is the default and is what nearly every grant should be. Set one against
              a single module and it applies there only — so hiding a tab in Leads leaves it visible
              in Deals, and someone who reaches a record through both still sees it. Each module is
              worked out on its own and the most generous answer wins, so to hide something outright
              set it on All modules.
            </>,
            <>
              <strong className="font-semibold text-ink-900">Which records</strong> someone sees is a
              separate question, answered by the Team member field on each record — not by anything
              on this screen.
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
