/**
 * Marks a document as a preview on every page, so a copy saved from the preview
 * can't pass for the one that is sent (client, 4 Nov 2026: "All three buttons
 * should have optional preview"). A thin band across the top margin; nothing
 * on the page itself moves.
 */
import 'server-only';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function stampPreview(bytes: Uint8Array, words = 'PREVIEW — not sent. Generated from the CRM as it is now.'): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(7, Math.min(11, width / 80));
    const w = font.widthOfTextAtSize(words, size);
    const band = size * 2;
    page.drawRectangle({ x: 0, y: height - band, width, height: band, color: rgb(0.99, 0.93, 0.85), opacity: 0.92 });
    page.drawText(words, { x: (width - w) / 2, y: height - band + size * 0.65, size, font, color: rgb(0.62, 0.28, 0.05) });
  }
  return doc.save();
}
