/**
 * The Maverick connection page moved into Integrations › Maverick Payments
 * (client, 6 Nov 2026): health and daily runs under Main connector, matching
 * merchants to records under Individual connectors. The old address forwards
 * there; that page checks the same two Maverick permissions this one did.
 */
import { redirect } from 'next/navigation';

export default function AdminMaverickPage() {
  redirect('/admin/integrations?tab=maverick');
}
