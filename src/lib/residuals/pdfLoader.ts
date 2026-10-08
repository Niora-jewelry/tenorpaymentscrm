import 'server-only';

/**
 * Opening a PDF and handing back positioned text runs.
 *
 * The only part of statement reading that needs a PDF library, kept apart from
 * `statementParser` so the parsing rules stay testable with plain fixtures and
 * the library never reaches a client bundle.
 *
 * ── WHY pdfjs AND NOT A COMMAND-LINE TOOL ────────────────────────────────
 * `pdftotext` is the obvious reach, and it is wrong twice. Its text-flow
 * output misreads this statement's table (measured — see `statementParser`),
 * and the build here is Glyph & Cog 4.00, which has no `-bbox`, so there is no
 * coordinate mode to fall back to. It is also a binary that does not exist on
 * Vercel, where this has to run.
 *
 * pdfjs is pure JavaScript, so it behaves the same locally and deployed, and
 * `getTextContent` gives each run its transform — which is the coordinate the
 * whole approach depends on.
 *
 * ── `transform[4]` AND `transform[5]` ────────────────────────────────────
 * A text item's transform is the 6-element matrix [a, b, c, d, e, f]; e and f
 * are the translation, i.e. the x and y of the run's origin in PDF user space.
 * Y grows UPWARD, so a larger y is higher on the page — which is why the row
 * clustering sorts descending.
 */
import type { LoadedPdf, Positioned } from './statementParser';

/**
 * `useSystemFonts: false` and no `standardFontDataUrl`.
 *
 * Text extraction needs the encoding, not the glyphs, so the font files are
 * never required. Left at their defaults pdfjs tries to fetch Liberation Sans
 * and logs a warning per face on every single statement; `verbosity: 0` keeps
 * that out of the operator's log, where it would read like a real problem.
 */
export async function loadPdfText(bytes: Uint8Array): Promise<LoadedPdf> {
  /* Imported here, not at module scope, so the cost falls only on an import. */
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  try {
    const pages: Positioned[][] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const runs: Positioned[] = [];
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const text = item.str.trim();
          if (text === '') continue;
          runs.push({ text, x: item.transform[4], y: item.transform[5] });
        }
        pages.push(runs);
      } finally {
        page.cleanup();
      }
    }
    return { pages };
  } finally {
    await doc.destroy();
  }
}
