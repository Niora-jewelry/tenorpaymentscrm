/**
 * Shown while any admin screen is being fetched.
 *
 * Every one of them is a server render over the whole config tree — the grant
 * matrix alone resolves 148 scopes, Presets loads eleven tables — so on the
 * live remote database these take a visible moment. Without a boundary the App
 * Router does not commit the navigation at all, so clicking "Presets" left the
 * previous admin screen on display with nothing indicating anything had
 * happened. The record modules already had this; the admin section did not.
 *
 * One skeleton covers the whole section deliberately. These screens differ too
 * much to share a shape, so this deliberately suggests only the two things
 * every one of them has — a page heading and a panel below it — rather than
 * miming a specific layout and being wrong on five routes out of nine.
 */
export default function AdminLoading() {
  return (
    <div className="p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div>
        <div className="mb-6 space-y-2">
          <div className="h-6 w-48 skeleton" />
          <div className="h-3.5 w-80 skeleton" />
        </div>

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
            <div className="h-4 w-32 skeleton" />
            <div className="h-7 w-24 skeleton rounded-lg" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line-faint px-4 py-3 last:border-0">
              <div className="h-3.5 flex-1 skeleton" />
              <div className="h-3.5 w-24 skeleton" />
              <div className="h-3.5 w-16 skeleton" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
