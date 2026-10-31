import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Forgetting the gate fails silently: the service role would do the write for
 * anyone. So the source is read: every exported function that changes something
 * has to ask for Full edit first, and every other one at least for View only.
 */
const source = readFileSync(resolve(process.cwd(), 'src/lib/automations/service.ts'), 'utf8');

const exported = [...source.matchAll(/export async function (\w+)\([^]*?\{\n([^]*?)\n\}\n/g)].map((m) => ({ name: m[1]!, firstLine: m[2]!.trim().split('\n')[0]! }));
const byName = new Map(exported.map((f) => [f.name, f.firstLine]));

const WRITES = ['saveAutomation', 'setAutomationStatus', 'deleteAutomation', 'searchRecords', 'addAutomationFile', 'removeAutomationFile', 'dismissAlert'];
const READS = ['listAutomations', 'getAutomation', 'listRuns', 'listAlerts'];
// Asked as the viewer: the SQL function checks the record and who may switch it off.
const AS_THE_VIEWER = ['waitingOn', 'switchOffForRecord'];

describe('the gate', () => {
  it('knows every exported function', () => {
    expect([...byName.keys()].sort()).toEqual([...WRITES, ...READS, ...AS_THE_VIEWER].sort());
  });

  it.each(WRITES)('%s asks for Full edit first', (name) => {
    expect(byName.get(name)).toBe('await assertAutomationsEdit(ctx);');
  });

  it.each(READS)('%s asks for View only first', (name) => {
    expect(byName.get(name)).toBe('await assertAutomationsView(ctx);');
  });

  it.each(AS_THE_VIEWER)('%s runs on the viewer\'s own session', (name) => {
    expect(byName.get(name)).toContain('createSupabaseServerClient');
  });
});
