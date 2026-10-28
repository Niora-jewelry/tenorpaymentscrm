/**
 * Admin → Presets — all five sub-steps (tabs/subtabs CRUD, field CRUD, column
 * and header-strip assignment, the choices editor, pipelines and their steps),
 * each shipped and verified separately against a real module route.
 *
 * Tabs and subtabs are additive-only (create and assign, no removal — see
 * `adminPresets.ts`'s header for why). Fields add archive/restore, which is a
 * retirement, never a delete: `adminFields.ts` explains the difference and why
 * a `fields` row can never actually be removed.
 *
 * VERIFYING A CHANGE MADE HERE: open a real module's dashboard or drawer, not
 * this screen. Presets reads `fields` directly (`listFieldsForAdmin`, so
 * archived rows stay visible), which means it shows every write land whether
 * or not the shared config cache was invalidated — the one failure mode in
 * this area is invisible from exactly this page. `adminConfigCache.ts` has
 * the full account.
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import {
  listTabsForAdmin, listSubtabsForAdmin, listModulesForAdmin,
  listModuleTabOrder, listModuleSubtabOrder,
} from '@/lib/records/adminPresets';
import { listFieldsForAdmin } from '@/lib/records/adminFields';
import { listAssignableFields, listModuleFieldSelections } from '@/lib/records/adminColumns';
import { listChoiceFields } from '@/lib/records/adminChoices';
import { listPipelinesForAdmin } from '@/lib/records/adminPipelines';
import { statementGrid } from '@/lib/records/adminStatements';
import { TabsSection } from './TabsSection';
import { TabOrderSection } from './TabOrderSection';
import { SubtabsSection } from './SubtabsSection';
import { FieldsSection } from './FieldsSection';
import { ColumnsSection } from './ColumnsSection';
import { ChoicesSection } from './ChoicesSection';
import { PipelinesSection } from './PipelinesSection';
import { StatementsSection } from './StatementsSection';
import { PresetsTabs, type PresetSection } from './PresetsTabs';
import { ReloadConfigButton } from './ReloadConfigButton';

export default async function AdminPresetsPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const [tabs, subtabs, modules, fields, assignable, selections, choiceFields, pipelines, tabOrder, subtabOrder, statements] = await Promise.all([
    listTabsForAdmin(ctx),
    listSubtabsForAdmin(ctx),
    listModulesForAdmin(ctx),
    listFieldsForAdmin(ctx),
    listAssignableFields(ctx),
    listModuleFieldSelections(ctx),
    listChoiceFields(ctx),
    listPipelinesForAdmin(ctx),
    listModuleTabOrder(ctx),
    listModuleSubtabOrder(ctx),
    statementGrid(ctx),
  ]);

  /*
   * Ordered to follow the hierarchy rather than the build order: a tab holds
   * subtabs, subtabs hold fields, and columns/choices/pipelines all refer back
   * to fields. Reading the strip left to right is reading the data model
   * outside in.
   */
  const sections: PresetSection[] = [
    {
      key: 'tabs',
      label: 'Tabs',
      icon: 'layout-list',
      count: tabs.length,
      description:
        'The drawer’s top-level tabs. One shared definition across every module; each module chooses which of them it shows, and in what order. A tab needs at least one module to exist anywhere — use Edit modules to add or remove them, and drag a tab to reorder it.',
      content: (
        <div key="tabs" className="space-y-4">
          <TabsSection tabs={tabs} modules={modules} />
          {/* ORDER is a separate concern from which tabs exist: tab order and
              subtab order are two of the six per-module settings, and were the
              two that had no screen at all. Kept next to the tab list rather
              than on their own section, because the questions ("which tabs?",
              "in what order?", "and their subtabs?") are asked in one breath. */}
          <TabOrderSection
            tabs={tabs}
            subtabs={subtabs}
            modules={modules}
            order={tabOrder}
            subtabOrder={subtabOrder}
          />
        </div>
      ),
    },
    {
      key: 'subtabs',
      label: 'Subtabs',
      icon: 'panel-left',
      count: subtabs.length,
      description:
        'Sections within a tab — Application’s seven steps, Pricing’s four. A tab with no subtabs simply shows its fields directly. Click a name to rename it or edit the description shown at the top of it; the order they appear in is set per module under Tabs.',
      content: <SubtabsSection key="subtabs" subtabs={subtabs} tabs={tabs} modules={modules} />,
    },
    {
      key: 'fields',
      label: 'Fields',
      icon: 'sliders',
      count: fields.length,
      description:
        'Every field in the CRM, and where it sits. Fields are archived, never deleted — a retirement keeps the history and the permissions attached to it intact.',
      content: <FieldsSection key="fields" fields={fields} tabs={tabs} subtabs={subtabs} modules={modules} />,
    },
    {
      key: 'columns',
      label: 'Columns',
      icon: 'database',
      count: modules.length,
      description:
        'Which fields appear as columns on each module’s dashboard, and which few make up the drawer’s header strip.',
      content: <ColumnsSection key="columns" modules={modules} fields={assignable} selections={selections} />,
    },
    {
      key: 'choices',
      label: 'Choices',
      icon: 'circle-dot',
      count: choiceFields.length,
      description:
        'The options behind every dropdown, status and multi-select. Choices can differ per module, so Leads and Deals need not share a status list.',
      content: <ChoicesSection key="choices" fields={choiceFields} modules={modules} />,
    },
    {
      key: 'pipelines',
      label: 'Pipelines',
      icon: 'route',
      count: pipelines.length,
      description:
        'The stage bars at the top of a record, and the steps within each one.',
      content: <PipelinesSection key="pipelines" pipelines={pipelines} modules={modules} />,
    },
    {
      // Last in the strip because it is the one section that configures a
      // SYSTEM tab's structure rather than the shared tab/field model — the
      // Statements tab holds no fields at all, so it appears in none of the six
      // editors above and had no home in Presets before.
      key: 'statements',
      label: 'Statements',
      icon: 'calendar',
      count: statements.years.length,
      description:
        'The month grid behind the Statements tab — one global calendar shared by every record. It can be extended forward by whole years; July 2024 is fixed and nothing is ever removed.',
      content: <StatementsSection key="statements" grid={statements} />,
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Presets</h1>
          <p className="text-[13px] text-ink-500">
            Tabs, subtabs and fields — one shared definition, ordered and selected per module.
          </p>
        </div>
        {/* For configuration that arrived in a migration rather than through
            this screen — see `ReloadConfigButton`. */}
        <ReloadConfigButton />
      </div>

      {/* `Suspense` because `PresetsTabs` reads the query string via
          `useSearchParams`, which Next requires to sit under a boundary. The
          fallback is the bare strip height, so nothing jumps. */}
      <Suspense fallback={<div className="h-[38px] border-b border-line" />}>
        <PresetsTabs sections={sections} />
      </Suspense>
    </div>
  );
}
