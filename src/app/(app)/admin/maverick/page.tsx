/**
 * Admin → Maverick: the connection's health (Maverick Integration spec,
 * Connection page). The last good update of each data type, recent daily runs
 * and what failed, and merchants Maverick knows that no record matches yet.
 *
 * Who sees what: "Maverick connection" opens the whole page; "Resolve unmatched
 * merchants" alone opens only the matching list. Neither → no page.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { connectionScreen } from '@/lib/processors/service';
import { ProcessorAccessError } from '@/lib/processors/access';
import { ADAPTER_READY } from '@/lib/processors/vendor';
import { MaverickConnection } from './MaverickConnection';

export const dynamic = 'force-dynamic';

export default async function AdminMaverickPage() {
  const ctx = await authorize();
  const screen = await connectionScreen(ctx).catch((e) => {
    if (e instanceof ProcessorAccessError) return null;
    throw e;
  });
  if (!screen) redirect('/dashboard');

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Maverick</h1>
        <p className="text-[13px] text-ink-500">
          The daily update from Maverick Payments at 7 AM New York time: what arrived, what failed, and merchants still to match to a record.
        </p>
      </div>
      <MaverickConnection screen={screen} adapterReady={ADAPTER_READY} />
    </div>
  );
}
