/**
 * Pictures pasted or dropped into a chat message. They go inside the message, as
 * Teams itself sends a pasted screenshot, not as a file to download.
 *
 * Microsoft takes at most 4 MB in one request, so a big picture is made smaller
 * here first: no wider or taller than 2400 px, and re-saved as JPEG if it is still
 * heavy. A screenshot usually goes as it is.
 */
import { CHAT_IMAGES_MAX_BYTES, type ChatImageType } from '@/lib/msteams/format';
import type { OutgoingImage } from '@/lib/msteams/types';

export type PendingImage = OutgoingImage & {
  id: string;
  name: string;
  /** Bytes after any shrinking. */
  size: number;
  /** For the preview in the box and in the message while it sends. */
  previewUrl: string;
};

const MAX_SIDE = 2400;
/** One picture above this is re-saved smaller. Several still have to share the message's allowance. */
const KEEP_AS_IS = 1_200_000;

const KEPT_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif']);

export const isPicture = (file: File) => file.type.startsWith('image/') && file.type !== 'image/svg+xml';

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared.'))), type, quality));
}

async function draw(bitmap: ImageBitmap, maxSide: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The picture could not be prepared.');
  // JPEG has no see-through parts: white, as the picture shows in Teams.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Ready to send, or a reason in plain words. */
export async function preparePicture(file: File): Promise<PendingImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || 'That picture'} could not be opened. Try a PNG or JPEG.`);
  }
  try {
    const big = Math.max(bitmap.width, bitmap.height) > MAX_SIDE;
    let blob: Blob = file;
    let type = file.type as ChatImageType;
    let width = bitmap.width;
    let height = bitmap.height;
    if (!KEPT_TYPES.has(file.type) || big || file.size > KEEP_AS_IS) {
      let side = MAX_SIDE;
      let canvas = await draw(bitmap, side);
      // A screenshot stays sharp as PNG when that is small enough.
      blob = file.type === 'image/png' ? await encode(canvas, 'image/png') : new Blob();
      type = 'image/png';
      for (const quality of [0.88, 0.8, 0.7, 0.6]) {
        if (blob.size && blob.size <= KEEP_AS_IS) break;
        if (quality === 0.7) {
          side = 1600;
          canvas = await draw(bitmap, side);
        }
        blob = await encode(canvas, 'image/jpeg', quality);
        type = 'image/jpeg';
      }
      width = canvas.width;
      height = canvas.height;
    }
    if (blob.size > CHAT_IMAGES_MAX_BYTES) throw new Error(`${file.name || 'That picture'} is too big to send in a message. Attach it as a file instead.`);
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name || 'Pasted picture',
      contentType: type,
      data: await toBase64(blob),
      width,
      height,
      size: blob.size,
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    bitmap.close();
  }
}

/** The pictures as the message carries them while it sends, before Teams answers. */
export const previewHtml = (images: PendingImage[]): string =>
  images.length ? `<p>${images.map((i) => `<img class="chat-img" src="${i.previewUrl}" alt="">`).join(' ')}</p>` : '';
