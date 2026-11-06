/**
 * Phone numbers moved into Integrations › Twilio › Individual connectors
 * (client, 6 Nov 2026). The old address forwards there; that page checks the
 * same `numbers` permission this one did.
 */
import { redirect } from 'next/navigation';

export default function AdminNumbersPage() {
  redirect('/admin/integrations?tab=twilio&sub=individual');
}
