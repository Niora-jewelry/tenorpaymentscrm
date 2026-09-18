/**
 * Skeleton for /phone.
 *
 * Every other route here has one, and this page waits on three queries (call
 * history, the user's number, SMS threads). Without it the sidebar sat beside
 * an empty pane on every visit, which reads as a broken link rather than as a
 * page that is loading.
 *
 * Shapes match the real layout — dial panel on the left, history on the right —
 * so nothing jumps when the content arrives.
 */
export default function PhoneLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <div className="h-5 w-24 skeleton" />
        <div className="h-3 w-80 skeleton" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3 rounded-2xl border border-line bg-white p-4">
          <div className="h-4 w-16 skeleton" />
          <div className="h-10 w-full skeleton" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 12 }, (_, i) => i).map((i) => (
              <div key={i} className="h-10 skeleton" />
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-line bg-white p-4">
          <div className="h-4 w-20 skeleton" />
          {Array.from({ length: 5 }, (_, i) => i).map((i) => (
            <div key={i} className="h-10 w-full skeleton" />
          ))}
        </div>
      </div>
    </div>
  );
}
