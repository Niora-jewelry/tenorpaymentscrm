/**
 * PROTOTYPE — the icon set.
 *
 * Inline SVG, no dependency, no network request. That is not a stylistic
 * choice: the app ships a Content-Security-Policy with `default-src 'self'`,
 * so an icon font or a CDN sprite sheet would simply be blocked.
 *
 * Every icon is a 24×24 stroke drawing on `currentColor`, so an icon inherits
 * the colour and weight of the text it sits beside and never needs a variant.
 * Emoji are deliberately absent everywhere in the product — they render
 * differently on every platform, cannot be recoloured, and read as informal in
 * a system that holds bank details.
 */
import type { SVGProps } from 'react';

export type IconName =
  // structure
  | 'database'
  | 'target'
  | 'briefcase'
  | 'users'
  | 'lifebuoy'
  | 'percent'
  | 'cog'
  | 'layout-list'
  | 'panel-left'
  | 'panel-left-open'
  // actions
  | 'plus'
  | 'x'
  | 'check'
  | 'trash'
  | 'archive'
  | 'pencil'
  | 'copy'
  | 'search'
  | 'filter'
  | 'upload'
  | 'download'
  | 'send'
  | 'reply'
  | 'rotate-ccw'
  | 'sliders'
  // chevrons
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-left'
  | 'chevron-right'
  | 'arrow-right'
  // state
  | 'eye'
  | 'eye-off'
  | 'lock'
  | 'bell'
  | 'alert-triangle'
  | 'info'
  | 'circle-dot'
  | 'shuffle'
  | 'route'
  | 'clock'
  // content
  | 'file-text'
  | 'paperclip'
  | 'message-square'
  | 'sticky-note'
  | 'flag'
  | 'key'
  | 'mail'
  | 'phone'
  | 'video'
  | 'mic'
  | 'link'
  | 'external-link'
  | 'calendar'
  | 'user'
  // mail
  | 'inbox'
  | 'folder'
  | 'file-pen'
  | 'ban'
  | 'pin'
  | 'image-off'
  | 'refresh-cw'
  | 'reply-all'
  | 'forward'
  | 'more-horizontal'
  | 'users-round'
  // formatting — the Updates rich-text bar (Modules §3.2)
  | 'type-bold'
  | 'type-italic'
  | 'code'
  | 'list'
  | 'list-ordered'
  | 'quote';

type Props = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName;
  size?: number;
  /** Filled icons (a status dot, a solid bell) set this to `currentColor`. */
  strokeWidth?: number;
};

/**
 * Paths only — the wrapper supplies viewBox, stroke and line joins, so each
 * entry stays a single readable expression.
 */
const PATHS: Record<IconName, React.ReactNode> = {
  /* --- structure ------------------------------------------------------- */
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  briefcase: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <path d="M2 13h20" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  lifebuoy: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="m5.6 5.6 3.9 3.9m5 5 3.9 3.9M18.4 5.6l-3.9 3.9m-5 5-3.9 3.9" />
    </>
  ),
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  cog: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.9 2h-1.8a1.4 1.4 0 0 0-1.4 1.4v.5a1.4 1.4 0 0 1-2.1 1.2l-.4-.2a1.4 1.4 0 0 0-1.9.5l-.9 1.6a1.4 1.4 0 0 0 .5 1.9l.4.2a1.4 1.4 0 0 1 0 2.4l-.4.2a1.4 1.4 0 0 0-.5 1.9l.9 1.6a1.4 1.4 0 0 0 1.9.5l.4-.2a1.4 1.4 0 0 1 2.1 1.2v.5A1.4 1.4 0 0 0 11.1 22h1.8a1.4 1.4 0 0 0 1.4-1.4v-.5a1.4 1.4 0 0 1 2.1-1.2l.4.2a1.4 1.4 0 0 0 1.9-.5l.9-1.6a1.4 1.4 0 0 0-.5-1.9l-.4-.2a1.4 1.4 0 0 1 0-2.4l.4-.2a1.4 1.4 0 0 0 .5-1.9l-.9-1.6a1.4 1.4 0 0 0-1.9-.5l-.4.2a1.4 1.4 0 0 1-2.1-1.2v-.5A1.4 1.4 0 0 0 12.9 2Z" />
    </>
  ),
  'layout-list': (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1" />
      <rect x="3" y="13" width="7" height="7" rx="1" />
      <path d="M14 6h7M14 10h7M14 15h7M14 19h7" />
    </>
  ),
  'panel-left': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 9-3 3 3 3" />
    </>
  ),
  'panel-left-open': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m13 9 3 3-3 3" />
    </>
  ),

  /* --- actions --------------------------------------------------------- */
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <path d="M18.5 6v13.5A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5V6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  archive: (
    <>
      <rect x="2.5" y="3.5" width="19" height="5" rx="1.5" />
      <path d="M4.5 8.5v11A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-11" />
      <path d="M10 12.5h4" />
    </>
  ),
  pencil: (
    <>
      <path d="M16.9 3.1a2.9 2.9 0 0 1 4 4L7.6 20.5 2 22l1.5-5.6Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m21 21-4.5-4.5" />
    </>
  ),
  filter: <path d="M21.5 3.5h-19l7.6 9v6.5l3.8 1.9V12.5Z" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </>
  ),
  /* The same tray, arrow reversed — a file coming down out of the app. */
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </>
  ),
  send: <path d="M22 2 15 22l-4-9-9-4Z" />,
  reply: (
    <>
      <path d="m9 14-5-5 5-5" />
      <path d="M4 9h10a6 6 0 0 1 6 6v5" />
    </>
  ),
  'rotate-ccw': (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1.5 14h5M9.5 8h5M17.5 16h5" />
    </>
  ),

  /* --- chevrons -------------------------------------------------------- */
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-up': <path d="m18 15-6-6-6 6" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'arrow-right': <path d="M4 12h15m0 0-6-6m6 6-6 6" />,

  /* --- state ----------------------------------------------------------- */
  eye: (
    <>
      <path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.9 4.2A9.6 9.6 0 0 1 12 4c6.2 0 10 8 10 8a18 18 0 0 1-2.6 3.6" />
      <path d="M6.4 6.4A17.7 17.7 0 0 0 2 12s3.8 8 10 8a9.7 9.7 0 0 0 5.3-1.5" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m2 2 20 20" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 8.5a5.5 5.5 0 0 1 11 0c0 6 2.5 7.5 2.5 7.5H4s2.5-1.5 2.5-7.5Z" />
      <path d="M10.3 19.5a2 2 0 0 0 3.4 0" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 16.5V11M12 7.5h.01" />
    </>
  ),
  'circle-dot': (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  shuffle: (
    <>
      <path d="m17 2.5 4 4-4 4" />
      <path d="M2.5 6.5h4a5 5 0 0 1 4 2l3 4a5 5 0 0 0 4 2h4" />
      <path d="m17 13.5 4 4-4 4" />
      <path d="M2.5 17.5h4a5 5 0 0 0 4-2l.6-.8" />
      <path d="m13.9 9.3.6-.8a5 5 0 0 1 4-2" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 6.5V12l3.5 2" />
    </>
  ),

  /* --- content --------------------------------------------------------- */
  'file-text': (
    <>
      <path d="M14.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7.5Z" />
      <path d="M14.5 2.5v5h5" />
      <path d="M8.5 13h7M8.5 17h7M8.5 9h2" />
    </>
  ),
  paperclip: (
    <path d="m20.5 11-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.8 1.8 0 0 1-2.6-2.6l8.1-8.1" />
  ),
  'message-square': (
    <path d="M21 14.5a2 2 0 0 1-2 2H7.5L3 21V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  ),
  /* --- formatting bar (Updates, Modules §3.2) ---------------------------- */
  'type-bold': (
    <>
      <path d="M6 4h7a4 4 0 0 1 0 8H6z" />
      <path d="M6 12h8a4 4 0 0 1 0 8H6z" />
    </>
  ),
  'type-italic': (
    <>
      <path d="M19 4h-9" />
      <path d="M14 20H5" />
      <path d="m15 4-4 16" />
    </>
  ),
  code: (
    <>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  'list-ordered': (
    <>
      <path d="M10 6h11" />
      <path d="M10 12h11" />
      <path d="M10 18h11" />
      <path d="M4 6h1v4" />
      <path d="M4 10h2" />
      <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
    </>
  ),
  quote: (
    <>
      <path d="M6 17h3l2-4V7H5v6h3z" />
      <path d="M15 17h3l2-4V7h-6v6h3z" />
    </>
  ),
  'sticky-note': (
    <>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </>
  ),
  flag: (
    <>
      <path d="M4 15.5s1-1 4-1 5 2 8 2 4-1 4-1v-12s-1 1-4 1-5-2-8-2-4 1-4 1Z" />
      <path d="M4 22v-6.5" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="16" r="4.5" />
      <path d="m10.7 12.8 9.3-9.3" />
      <path d="m16 6 3 3 2.5-2.5-3-3" />
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="m3 6 9 6.5L21 6" />
    </>
  ),
  phone: (
    <path d="M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.6 19.6 0 0 1-8.5-3 19.3 19.3 0 0 1-6-6 19.6 19.6 0 0 1-3-8.6 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.4a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
  ),
  video: (
    <>
      <rect x="2" y="6" width="13.5" height="12" rx="2" />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5Z" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M18.5 11v1a6.5 6.5 0 0 1-13 0v-1M12 18.5V22" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a4.5 4.5 0 0 0 6.8.5l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.6" />
      <path d="M14 10.5a4.5 4.5 0 0 0-6.8-.5l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.5-1.6" />
    </>
  ),
  'external-link': (
    <>
      <path d="M14.5 3.5H20.5v6" />
      <path d="M10 14 20.5 3.5" />
      <path d="M18 13.5v5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="17" rx="2" />
      <path d="M16 2.5v4M8 2.5v4M3 10h18" />
    </>
  ),
  inbox: (
    <>
      <path d="M21.5 13h-5.2l-1.6 2.5H9.3L7.7 13H2.5" />
      <path d="M5.8 5.6 2.5 13v5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5l-3.3-7.4a2 2 0 0 0-1.8-1.1H7.6a2 2 0 0 0-1.8 1.1Z" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  ),
  'file-pen': (
    <>
      <path d="M12.5 21.5H6.5a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2h8l5 5v4" />
      <path d="M14.5 2.5v5h5" />
      <path d="m19.6 14.4 1.9 1.9-5 5h-1.9v-1.9Z" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m5.3 5.3 13.4 13.4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 16.5v5" />
      <path d="M8.5 3h7l-1 6.2 3 3.3v2H6.5v-2l3-3.3Z" />
    </>
  ),
  'image-off': (
    <>
      <path d="m3 3 18 18" />
      <path d="M20.5 15.5V5.5a2 2 0 0 0-2-2H8.5" />
      <path d="M3.5 6.5v12a2 2 0 0 0 2 2h12" />
      <path d="m3.5 16 4.5-4.5 3 3" />
      <circle cx="15.5" cy="8.5" r="1.5" />
    </>
  ),
  'refresh-cw': (
    <>
      <path d="M20.5 11A8.5 8.5 0 0 0 6 5.5L3.5 8" />
      <path d="M3.5 3.5V8H8" />
      <path d="M3.5 13A8.5 8.5 0 0 0 18 18.5l2.5-2.5" />
      <path d="M20.5 20.5V16H16" />
    </>
  ),
  'reply-all': (
    <>
      <path d="m7.5 16-5-5 5-5" />
      <path d="m12.5 16-5-5 5-5" />
      <path d="M21.5 19v-2a6 6 0 0 0-6-6h-8" />
    </>
  ),
  forward: (
    <>
      <path d="m15.5 16 5-5-5-5" />
      <path d="M3.5 19v-2a6 6 0 0 1 6-6h11" />
    </>
  ),
  'more-horizontal': (
    <>
      <circle cx="5.5" cy="12" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="18.5" cy="12" r="1.1" />
    </>
  ),
  'users-round': (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
};

export function Icon({ name, size = 16, strokeWidth = 1.75, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Stops an icon from stretching inside a flex row.
      style={{ flexShrink: 0, ...rest.style }}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The nav icon for each module, so the sidebar and the home page agree. */
export const MODULE_ICON: Record<string, IconName> = {
  records: 'database',
  leads: 'target',
  deals: 'briefcase',
  contacts: 'users',
  tickets: 'lifebuoy',
  residuals: 'percent',
};

/** The glyph for each kind of activity-log entry. */
export const ACTIVITY_ICON: Record<string, IconName> = {
  field: 'pencil',
  membership: 'shuffle',
  pipeline: 'route',
  file: 'paperclip',
  update: 'message-square',
  case: 'flag',
  credential: 'key',
  record: 'circle-dot',
};

/** The glyph for each Communication subtab. */
export const CHANNEL_ICON: Record<string, IconName> = {
  email: 'mail',
  instantly: 'send',
  text: 'message-square',
  teams: 'video',
  phone: 'phone',
  recordings: 'mic',
};
