'use client';

/**
 * The sheet chrome around the drawer — MODULE-2-PLAN §11: "Sheet, ~62% width,
 * max 980px. The list stays visible behind it so the user keeps their
 * place. Full-screen below 900px." Widened to ~76%/1280px after live
 * click-through showed the real tab strip (7 custom tabs + system tabs)
 * overflowing and scroll-clipping at 980px — the list stays visible behind
 * it either way, so the "keep their place" intent is unaffected. The drawer's actual CONTENT
 * (`RecordDrawer` in page.tsx) is an async Server Component fetching real
 * data — this wraps it as `children`, providing only the overlay, slide-in
 * animation, and the extra close affordances (backdrop click, Escape) a
 * server-rendered panel can't own itself. `animate-sheet-in`/`sheet-out`
 * already existed in globals.css, defined for exactly this, unused until now.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function DrawerShell({ moduleSlug, children }: { moduleSlug: string; children: React.ReactNode }) {
  const router = useRouter();

  const close = () => router.push(`/${moduleSlug}`, { scroll: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleSlug]);

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-y-0 right-0 flex w-full animate-sheet-in flex-col overflow-y-auto border-l border-line bg-canvas shadow-[-24px_0_64px_-12px_rgba(8,32,47,.35)] sm:w-[92%] lg:w-[76%] lg:max-w-[1280px]"
      >
        {children}
      </div>
    </div>
  );
}
