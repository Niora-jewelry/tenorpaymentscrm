/**
 * Skeleton for /phone.
 *
 * Every other route here has one, and this page waits on several queries. Without
 * it the sidebar sat beside an empty pane on every visit, which reads as a broken
 * link rather than as a page that is loading.
 *
 * Shapes match the real layout (title and the Phone/SMS switch; the list with its
 * sub-tabs on the left, the keypad on the right) so nothing jumps.
 */
export default function PhoneLoading() {
  return (
    <div className="space-y-5 p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-5 w-24 skeleton" />
          <div className="h-3 w-80 skeleton" />
        </div>
        <div className="h-10 w-48 rounded-xl skeleton" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-2xl border border-line bg-white">
          <div className="flex gap-6 border-b border-line-soft px-5 py-4">
            <div className="h-4 w-28 skeleton" />
            <div className="h-4 w-20 skeleton" />
          </div>
          <div className="p-4">
            <div className="h-10 w-full rounded-xl skeleton" />
          </div>
          <div className="space-y-4 px-4 pb-5">
            {Array.from({ length: 6 }, (_, i) => i).map((i) => (
              <div key={i} className="flex items-center gap-3.5">
                <div className="size-10 shrink-0 rounded-full skeleton" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-40 skeleton" />
                  <div className="h-3 w-64 skeleton" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-line bg-white p-5">
          <div className="h-4 w-16 skeleton" />
          <div className="h-[60px] w-full rounded-xl skeleton" />
          <div className="grid grid-cols-3 gap-2.5">
            {Array.from({ length: 12 }, (_, i) => i).map((i) => (
              <div key={i} className="h-[58px] rounded-2xl skeleton" />
            ))}
          </div>
          <div className="h-[52px] w-full rounded-2xl skeleton" />
        </div>
      </div>
    </div>
  );
}
