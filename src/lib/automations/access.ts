/**
 * Who may do what on the Automations page. Spec: access follows the Admin module
 * permission. Full edit changes things, View only reads, Hidden sees nothing.
 */
import 'server-only';
import { automationsAccess, type AuthContext } from '@/lib/records/permissions';

export class AutomationError extends Error {}

export async function assertAutomationsView(ctx: AuthContext): Promise<void> {
  if ((await automationsAccess(ctx)) === 'hidden') throw new AutomationError('You do not have access to Automations.');
}

export async function assertAutomationsEdit(ctx: AuthContext): Promise<void> {
  if ((await automationsAccess(ctx)) !== 'full') throw new AutomationError('You can see automations but not change them.');
}
