/**
 * The views under Communication → Phone (UI spec §5): Calls | Texts | Call
 * recordings, in that order, Calls by default. Shared by the panel and by the
 * links that land on a view (notifications, the Text action on a phone field).
 */
export const PHONE_VIEWS = [
  { key: 'calls', label: 'Calls', icon: 'phone' },
  { key: 'texts', label: 'Texts', icon: 'message-square' },
  { key: 'recordings', label: 'Call recordings', icon: 'mic' },
] as const;

export type PhoneView = (typeof PHONE_VIEWS)[number]['key'];

/** `?view=` → a view; anything else → Calls. */
export function phoneViewFrom(raw: string | null | undefined): PhoneView {
  return PHONE_VIEWS.some((v) => v.key === raw) ? (raw as PhoneView) : 'calls';
}
