/**
 * How a correspondent looks in the mail UI: initials on a colour that is
 * always the same for the same address, so a regular sender is recognisable
 * at a glance down a long list. Colours come from the CRM's own swatch set,
 * never a random hue.
 */
import { SWATCHES } from '@/proto/ui/tokens';
import type { IconName } from '@/proto/ui/icons';

const PALETTE = (['blue', 'teal', 'indigo', 'green', 'orange', 'purple', 'pink', 'brown', 'amber', 'slate'] as const).map((k) => SWATCHES[k]);

export function swatchFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function initials(name: string, address: string): string {
  const source = name.trim() || address.split('@')[0] || '?';
  const words = source.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function displayName(name: string, address: string): string {
  return name.trim() || address || 'Unknown sender';
}

export const FOLDER_ICON: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'file-pen',
  sentitems: 'send',
  deleteditems: 'trash',
  junkemail: 'ban',
  archive: 'archive',
};

/** Outlook shows Drafts by how many there are, every other folder by how many are unread. */
export function folderBadge(f: { wellKnown: string | null; unread: number; total: number }): number {
  return f.wellKnown === 'drafts' ? f.total : f.unread;
}
