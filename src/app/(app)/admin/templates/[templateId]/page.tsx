/**
 * `Admin → Templates → one template` — what it grants, across every scope, and
 * (Phase 6c) where it is changed.
 *
 * The columns are described in `GrantMatrix.tsx`; the one thing to know before
 * reading the screen is that a scope with no row resolves to **Edit**, so a
 * template full of blanks restricts nothing at all.
 *
 * The matrix is framed as "a non-admin holding only this template", which is
 * why `templateGrantMatrix` passes `isAdmin: false`. A template describes a
 * role, not a person — rendering it against the admin shortcut would show Edit
 * on every row and say nothing about the template.
 *
 * Gated the way every admin route is: `authorize()`, redirect if not admin. The
 * actions passed down re-authorize on their own, because a Server Action is
 * reachable without ever loading this page.
 */
import { notFound, redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { templateGrantMatrix } from '@/lib/records/adminGrants';
import { OutlineChip } from '@/proto/ui/kit';
import { GrantMatrix, MatrixBackLink, type GrantWriter } from '../../GrantMatrix';
import { setTemplateGrantAction, clearTemplateGrantAction } from '../actions';

export default async function TemplateGrantsPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;

  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const matrix = await templateGrantMatrix(ctx, templateId);
  if (!matrix || matrix.subject.kind !== 'template') notFound();
  const { subject } = matrix;

  // Bound to this template here rather than passed as an id the client sends
  // back with every write — the matrix never needs to know which template it is
  // editing, and an id it cannot supply is an id it cannot get wrong.
  const writer: GrantWriter = {
    column: 'template',
    set: async (scopeKind, scopeId, level) => {
      'use server';
      return setTemplateGrantAction(templateId, scopeKind, scopeId, level);
    },
    clear: async (scopeKind, scopeId) => {
      'use server';
      return clearTemplateGrantAction(templateId, scopeKind, scopeId);
    },
  };

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/templates" label="All templates" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{subject.label}</h1>
          <OutlineChip tone={matrix.counts.templateSet ? 'brand' : 'warn'}>
            {matrix.counts.templateSet === 0
              ? 'Grants nothing yet'
              : `${matrix.counts.templateSet} grant${matrix.counts.templateSet === 1 ? '' : 's'}`}
          </OutlineChip>
          <OutlineChip>
            {subject.attachedUsers} user{subject.attachedUsers === 1 ? '' : 's'}
          </OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          What a non-admin holding only this template resolves to. Editing a template changes every
          attached user on their next request — there is no push step, and there must never be a cache
          in front of it.
        </p>
      </div>

      <GrantMatrix matrix={matrix} writer={writer} />
    </div>
  );
}
