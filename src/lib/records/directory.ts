/**
 * Who can be put on a record's team.
 *
 * Goes through `team_directory()` (migration 40) rather than selecting
 * `profiles` directly, for the same reason `users.ts` goes through
 * `profile_names()`: a non-admin cannot read a colleague's profile row at all
 * under `profiles`' own RLS, and a "choose from team members" picker is exactly
 * the operation that needs to list them. `profile_names()` cannot serve this —
 * it takes an id list, and producing that list is the picker's whole job.
 *
 * The function returns id / name / email / status and nothing else; migration 40
 * carries the reasoning for why `email` is in that set and role, last login and
 * the session columns are not.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

/** The shape the client's `PeopleProvider` takes — deliberately identical to
 * `@/proto/ui/people`'s `Person`, so the layout hands this straight through
 * with no adapter and no second name for the same thing. */
export type DirectoryPerson = {
  id: string;
  name: string;
  email: string;
  suspended: boolean;
};

type DirectoryRow = {
  id: string;
  full_name: string | null;
  email: string;
  status: 'active' | 'suspended';
};

/**
 * Every assignable person, in display order.
 *
 * `_ctx` is unused, and required anyway: `CLAUDE.md` §2 makes the authorised
 * context the argument that proves the caller went through the gate. The RPC
 * itself is granted to `authenticated` only, so an unauthenticated request
 * cannot reach it whatever this file does — the parameter is what stops a future
 * caller from reaching it without having authorised first.
 *
 * The disable is needed because this function takes only the one argument, so
 * `no-unused-vars`' default `after-used` mode reports it — unlike
 * `profileNamesFor(_ctx, ids)` in `users.ts`, which has the same unused context
 * parameter for the same reason and is silently allowed because a used argument
 * follows it. Deleting the parameter to quiet the rule would delete the gate.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function teamDirectory(_ctx: AuthContext): Promise<DirectoryPerson[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('team_directory');
  if (error) throw error;

  return ((data ?? []) as DirectoryRow[]).map((r) => ({
    id: r.id,
    // The email is the fallback, not "Unknown user": this list is picked FROM,
    // and an unnamed row that reads "Unknown user" is unpickable. `users.ts`
    // resolves ids it was handed and has no such option.
    name: r.full_name?.trim() || r.email,
    email: r.email,
    suspended: r.status === 'suspended',
  }));
}
