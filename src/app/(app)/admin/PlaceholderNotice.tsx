/**
 * The banner that says what an admin screen CANNOT do yet.
 *
 * Two uses, and they are not quite the same thing:
 *   - Integrations and Automations are placeholders — built so the navigation
 *     is complete, connected to nothing.
 *   - Templates (Phase 6a) is real, working CRUD whose *point* is not wired
 *     yet: a template can be created and attached, but it holds no grants
 *     until 6c, so it restricts nothing.
 *
 * What both need is the same sentence in the same shape: here is the thing you
 * would reasonably assume this screen does, and here is why it does not do it
 * yet. One component rather than copy repeated on three pages, so they cannot
 * drift into saying different things about the same kind of situation.
 *
 * Amber, not brand-coloured, and not dismissible: this is a statement about
 * what the screen can do, not a tip. The tokens are the same three the kit's
 * `OutlineChip tone="warn"` uses, so a placeholder reads as the same kind of
 * thing wherever it appears.
 */
import { Icon } from '@/proto/ui/icons';

export function PlaceholderNotice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-panel border border-[#f7e0af] bg-[#fdf1d8] px-4 py-3 text-[#8a5a09]">
      <Icon name="alert-triangle" size={16} strokeWidth={2} className="mt-[3px] shrink-0" />
      <div>
        <p className="text-[13.5px] font-semibold">{title}</p>
        <div className="mt-1 space-y-1.5 text-[12.5px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
