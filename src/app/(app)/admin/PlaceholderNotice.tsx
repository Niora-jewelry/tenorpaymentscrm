/**
 * The banner that says what an admin screen CANNOT do yet.
 *
 * Two uses, and they are not quite the same thing:
 *   - Integrations and Automations are placeholders — built so the navigation
 *     is complete, connected to nothing.
 *   - On the permission screens it carries a WARNING rather than an apology:
 *     that assigning a template deletes every override below it, and that some
 *     grants point at a scope which no longer exists.
 *
 * The second use used to be about templates holding no grants yet. That is no
 * longer true — template grants are editable and resolve on every request, so
 * describing them as restricting nothing would now be wrong in the one
 * direction that matters: an admin who believed it would hand out access they
 * thought was inert.
 *
 * What both uses need is the same sentence in the same shape: here is the
 * thing you would reasonably assume, and here is what is actually the case.
 * One component rather than copy repeated on three pages, so they cannot drift
 * into saying different things about the same kind of situation.
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
