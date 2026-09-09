/**
 * PROTOTYPE — route group.
 *
 * A clickable walkthrough of the CRM built entirely on invented data, so the
 * product can be seen and discussed before the real modules are built.
 *
 * Locked twice on purpose. `proxy.ts` gates the request; this layout checks
 * again before rendering. Two independent locks, because the whole risk with a
 * demo surface is that it quietly outlives the reason it was built, and one
 * check is one refactor away from being removed by accident.
 *
 * See `lib/security/prototype-gate.ts` for the access rules.
 */
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ProtoProvider } from '@/proto/store';
import { AppShell } from '@/proto/ui/AppShell';
import {
  isPrototypeUnlocked,
  prototypeAccessCode,
  PROTOTYPE_COOKIE,
} from '@/lib/security/prototype-gate';

export const metadata = {
  title: 'TapDash CRM — prototype',
  // Never let this reach a search index, code or no code.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Rendered per request, never prerendered.
 *
 * Without this the build evaluates the gate once — with no access code present,
 * because build-time and run-time environments differ — and bakes the resulting
 * 404 into a static page. Setting the code afterwards would then appear to do
 * nothing. The gate has to be a decision made per request, not per build.
 */
export const dynamic = 'force-dynamic';

export default async function PrototypeLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') {
    // No code configured: the prototype is off, and says nothing about itself.
    if (!prototypeAccessCode()) notFound();

    const jar = await cookies();
    if (!isPrototypeUnlocked(jar.get(PROTOTYPE_COOKIE)?.value)) notFound();
  }

  return (
    <ProtoProvider>
      <AppShell>{children}</AppShell>
    </ProtoProvider>
  );
}
