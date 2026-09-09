/**
 * Admin → Automations — a PLACEHOLDER SCREEN, and deliberately nothing more.
 *
 * Nothing in this build runs a rule. There is no rules table, no evaluator and
 * no trigger — the prototype's own copy says "shell only in this build"
 * (`src/app/prototype/admin/page.tsx:706`), automations are listed under "Out"
 * for v1 (`docs/MODULE-2-PLAN.md:53-56`), and `remaining-plan.md` § Phase 5 is
 * explicit that no engineering time goes here until the client specifies
 * something.
 *
 * The two examples below are the only two ever named, and they are named as
 * *candidates on the deferred register*, not as requirements. They are shown
 * because "we know roughly what this would hold" is more useful to an admin
 * than a blank screen — and shown as prose, without checkboxes or toggles,
 * because a disabled control still reads as a feature that exists and is
 * merely switched off.
 *
 * WHEN A SPEC ARRIVES, the first question to settle is what an automation is
 * allowed to touch. Both candidates below change a record's module membership,
 * which is the one operation with a real consequence attached: removing the
 * last membership archives the record (`CLIENT-SPEC-BY-MODULE.md` §9). An
 * automation that can add memberships but never remove them is a much smaller
 * and safer thing to build than one that can do both, and the difference is
 * not visible from the UI sketch.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { Icon } from '@/proto/ui/icons';
import { PlaceholderNotice } from '../PlaceholderNotice';

const CANDIDATES: { rule: string; note: string }[] = [
  {
    rule: 'Add a record to Deals when its status changes',
    note: 'Which status, on which module, and whether it also leaves the module it came from — none of it specified.',
  },
  {
    rule: 'Add a record to Tickets when a case is opened',
    note: 'The Cases tab already enforces its own rules at the database level; whether opening a case should move the record anywhere is a separate, unanswered question.',
  },
];

export default async function AdminAutomationsPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Automations</h1>
        <p className="text-[13px] text-ink-500">
          Rules that would act on a record on their own. None exist yet.
        </p>
      </div>

      <PlaceholderNotice title="No automation runs in this build, and none can be created here.">
        <p>
          There is no rules engine behind this screen — nothing evaluates a condition and nothing
          acts on a record without a person doing it. Automations were placed out of scope for v1,
          and the client has not since specified what any rule should do.
        </p>
        <p>
          The two below are the only candidates ever named, and they are candidates — nothing has
          been agreed, and neither is scheduled.
        </p>
      </PlaceholderNotice>

      <section className="space-y-2">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[.08em] text-ink-400">
          On the deferred register
        </h2>
        {CANDIDATES.map((c) => (
          <div key={c.rule} className="rounded-panel border border-dashed border-line bg-white/60 p-4">
            <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-700">
              <Icon name="route" size={14} className="shrink-0 text-ink-400" />
              {c.rule}
            </p>
            <p className="mt-1.5 pl-[22px] text-[12.5px] leading-relaxed text-ink-400">{c.note}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
