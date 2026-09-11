/**
 * The record drawer's header strip must honour the permission chain.
 *
 * ── THE LEAK THIS PINS ───────────────────────────────────────────────────
 * The strip read straight from `headerFieldsForModule` and `record.values` and
 * rendered whatever it found. It appeared safe because `getRecord` calls
 * `stripHidden`, so a field the viewer may not see arrives as undefined.
 *
 * But `hiddenKeysFor` consults `fieldGrants` and nothing else. A Hidden TAB or
 * SUBTAB never reaches it, so hiding the Overview tab still printed Legal
 * business name, MID, Team member(s) assigned, MCC code and Current status at
 * the top of the drawer — on screen and in the page payload — in all six
 * modules with the shipped configuration.
 *
 * `grantByKey` is the chain that closes it: module ceiling, then tab, then
 * subtab, then the field. These assertions are structural, on the source, for
 * the same reason the read-only guard's are: the rendering path needs a
 * database, an authorised context and a signed-in viewer, while what must stay
 * true is simply that the filter is there and consults the capped grant.
 *
 * ⚠️ It matters more since the strip became a grid. The grid shows a LABEL for
 * a field that is present but empty, and a permission-hidden field also arrives
 * empty — so without this filter the redesign would announce the NAME of every
 * field the viewer is not allowed to see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(__dirname, '(app)/[module]/page.tsx'),
  'utf8',
);

/** The block that builds what the header strip renders. */
function headerFactsBlock(): string {
  const start = source.indexOf('const headerFacts = headerFields');
  expect(start, 'headerFacts not found — did the strip get rewritten?').toBeGreaterThan(-1);
  const end = source.indexOf('\n  /*', start);
  return source.slice(start, end === -1 ? start + 3000 : end);
}

describe('drawer header strip', () => {
  it('filters its fields through the capped grant chain', () => {
    const block = headerFactsBlock();
    expect(block).toContain('grantByKey[f.key]');
    expect(block).toContain("'hidden'");
  });

  it('drops a hidden field rather than rendering it blank', () => {
    // "Absent, never blank" — the filter must REMOVE the field, not render an
    // empty cell for it, because the cell would still carry its label.
    const block = headerFactsBlock();
    const guard = block.slice(block.indexOf('grantByKey[f.key]'));
    expect(guard.slice(0, 120)).toContain('return false');
  });

  it('hides a pipeline-synced Status field the record is not on', () => {
    // Admin §3.6: "visible only on records assigned to that pipeline". The
    // field grid already does this; the strip used to not.
    const block = headerFactsBlock();
    expect(block).toContain('statusFieldOwners.get(f.id)');
    expect(block).toContain('pipelineAssign?.pipelineId');
  });

  it('suppresses a scalar field that merely restates the record title', () => {
    const block = headerFactsBlock();
    expect(block).toContain('titleForCompare');
    // By VALUE, not by field key — naming a field here would breach the
    // "no code names a module or field" rule and would not generalise.
    expect(block).not.toMatch(/'legal_business_name'/);
  });

  it('treats an emptied object as empty', () => {
    // `{}` reaches the strip from a percent_split or address that was filled in
    // and then cleared. The old three-case check missed it and printed a label
    // with nothing after it.
    expect(headerFactsBlock()).toContain('Object.keys(value).length === 0');
  });

  it('masks a sensitive value instead of printing it', () => {
    // `CellValue` has no sensitive branch at all, so the strip printed EIN,
    // account and routing numbers in clear while the same field in the grid
    // below sat behind a Reveal button.
    const value = readFileSync(
      path.join(__dirname, '../proto/ui/value.tsx'),
      'utf8',
    );
    const header = value.slice(value.indexOf('export function HeaderValue('));
    expect(header.slice(0, 900)).toContain('field.sensitive');
  });
});
