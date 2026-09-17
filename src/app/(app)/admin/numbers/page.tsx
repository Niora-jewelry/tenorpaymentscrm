/**
 * Admin → Phone numbers.
 *
 * One Twilio number per person. Holding an active number is half the permission
 * to use telephony — the other half is the `communication/phone` subtab grant
 * on the Permissions screen — and because every call and text is billed to the
 * client's own Twilio account, this screen is the control over that spend.
 *
 * Gated the way every admin route is: `authorize()`, redirect if not admin, and
 * checked again independently inside every action and every data function.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { listNumbers } from '@/lib/records/adminNumbers';
import { listUsers } from '@/lib/records/adminUsers';
import { NumbersSection } from './NumbersSection';

export default async function AdminNumbersPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const [numbers, users] = await Promise.all([listNumbers(ctx), listUsers(ctx)]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Phone numbers</h1>
        <p className="text-[13px] text-ink-500">
          Assign a Twilio number to a person. Someone with no active number cannot place calls or
          send texts, whatever their permissions say.
        </p>
      </div>

      <NumbersSection
        numbers={numbers}
        users={users
          // Suspended accounts cannot hold a session, so assigning one a number
          // would reserve telephony spend for somebody who cannot use it.
          .filter((u) => u.status === 'active')
          .map((u) => ({ id: u.id, label: u.fullName ? `${u.fullName} — ${u.email}` : u.email }))}
      />
    </div>
  );
}
