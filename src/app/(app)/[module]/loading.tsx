/**
 * Shown while the module list itself is being fetched — switching modules in
 * the sidebar, landing on `/leads` cold, changing a filter, paging.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * There was no `loading.tsx` anywhere in this app. Without one, a navigation in
 * the App Router simply does not commit until the whole server render has
 * finished, so clicking a module in the sidebar left the PREVIOUS module on
 * screen, with no spinner, no dimming, and no indication anything had happened
 * — for as long as the queries took. On the live remote database that was
 * seconds. It reads as a click that did not register.
 *
 * This is the LIST's boundary only. Opening a record does not fall through to
 * it: the drawer has its own `Suspense` boundary in `page.tsx`, which keeps the
 * list on screen behind the sheet — losing the list you were looking at, in
 * order to show a skeleton of it, would be a worse experience than the wait.
 *
 * Matching the real layout (title, toolbar, sticky header, rows) rather than
 * showing a centred spinner keeps the page from jumping when the data lands.
 */
export default function ModuleLoading() {
  return (
    <div className="flex h-full flex-col p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading records…</span>

      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div className="space-y-2">
          <div className="h-6 w-40 skeleton" />
          <div className="h-3.5 w-56 skeleton" />
        </div>
        <div className="h-8 w-32 skeleton rounded-lg" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3 py-2.5">
          <div className="h-7 w-56 skeleton rounded-lg" />
          <div className="ml-auto h-7 w-24 skeleton rounded-lg" />
          <div className="h-7 w-24 skeleton rounded-lg" />
        </div>

        {/* Sticky header row */}
        <div className="flex shrink-0 gap-4 border-b border-line bg-canvas/60 px-3 py-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-3 flex-1 skeleton" />
          ))}
        </div>

        {/* Rows. Ten is roughly a screenful — enough to fill the area without
            implying a specific result count. */}
        {Array.from({ length: 10 }).map((_, r) => (
          <div key={r} className="flex gap-4 border-b border-line-soft px-3 py-3">
            {Array.from({ length: 6 }).map((_, c) => (
              <div key={c} className="h-3.5 flex-1 skeleton" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
