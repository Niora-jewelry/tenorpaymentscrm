/**
 * Who may see and do what with processor data (Maverick Integration spec,
 * Permissions). Two sets: Reporting (Hidden / View, the tab and its Acquiring
 * and ACH sub-items) and the Maverick group (Yes / No each).
 *
 * Read from the same resolver the database uses (`permissionsFor`), so a button
 * and the server behind it can't disagree. Hidden data is never fetched.
 */
import 'server-only';
import { permissionsFor, type AuthContext } from '@/lib/records/permissions';

export type ProcessorPerms = {
  reportingTab: boolean;
  acquiring: boolean;
  ach: boolean;
  status: boolean;
  send: boolean;
  update: boolean;
  check: boolean;
  otherCases: boolean;
  syncCase: boolean;
  unmatchedFlag: boolean;
  resolveUnmatched: boolean;
  alerts: boolean;
  connection: boolean;
};

export async function processorPerms(ctx: AuthContext): Promise<ProcessorPerms> {
  const p = await permissionsFor(ctx);
  // A super admin's settings already resolve to the most each one allows.
  const s = p.settings;
  const yes = (k: string) => s[k] === 'yes';
  const view = (k: string) => s[k] === 'view';
  const tab = view('reporting.tab');
  return {
    reportingTab: tab,
    acquiring: tab && view('reporting.acquiring'),
    ach: tab && view('reporting.ach'),
    status: yes('maverick.status'),
    send: yes('maverick.send'),
    update: yes('maverick.update'),
    check: yes('maverick.check'),
    otherCases: yes('maverick.other_cases'),
    syncCase: yes('maverick.other_cases') && yes('maverick.sync_case'),
    unmatchedFlag: yes('maverick.unmatched_flag'),
    resolveUnmatched: yes('maverick.resolve_unmatched'),
    alerts: yes('maverick.alerts'),
    connection: yes('maverick.connection'),
  };
}

export class ProcessorAccessError extends Error {}

export function need(ok: boolean, what: string): void {
  if (!ok) throw new ProcessorAccessError(`You don’t have permission to ${what}.`);
}
