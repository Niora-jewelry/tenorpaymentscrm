import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * IBM Plex, not Inter.
 *
 * Chosen for two reasons specific to this product: it holds character at the
 * 13–14px the dashboard rows will run at, and its tabular figures are genuinely
 * good — this CRM is wall-to-wall currency, percentages, MIDs and case numbers,
 * and misaligned digits in a 40-column table are a real usability cost.
 */
const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
});


export const metadata: Metadata = {
  title: 'TapDash CRM',
  description: 'Merchant services CRM',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      {/*
        Browser extensions (password managers, ColorZilla, Grammarly) write
        their own attributes onto <body> before React hydrates, which React
        then reports as a hydration mismatch against server HTML that is a
        static string. `suppressHydrationWarning` applies to this element's
        own attributes ONLY — it does not cascade into {children}, so a real
        mismatch inside a page still fails loudly.
      */}
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
