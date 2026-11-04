/**
 * Sending a file: the browser puts it straight into Microsoft's upload session, in
 * pieces, so Teams' own size limits apply and the file never passes through this server.
 * If Microsoft refuses it, its own reason is what the person sees.
 */
import { finishUploadAction, startUploadAction } from '../actions';

/** Microsoft wants pieces in multiples of 320 KiB. */
const CHUNK = 320 * 1024 * 10;

export type Uploaded = { id: string; name: string; url: string; size: number };

type DriveItem = { id?: string; name?: string; eTag?: string; webUrl?: string; parentReference?: { driveId?: string } };

export async function uploadFile(file: File, key: string, memberEmails: string[], onProgress: (fraction: number) => void): Promise<Uploaded> {
  if (file.size === 0) throw new Error('Teams cannot send an empty file.');
  const session = await startUploadAction({ key, name: file.name });
  if (!session.ok) throw new Error(session.message);

  let last: Response | null = null;
  for (let at = 0; at < file.size; at += CHUNK) {
    const end = Math.min(file.size, at + CHUNK);
    let res: Response;
    try {
      res = await fetch(session.data, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${end - 1}/${file.size}` }, body: file.slice(at, end) });
    } catch {
      throw new Error('The connection dropped while sending the file. Nothing was posted.');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || `Teams refused the file (${res.status}).`);
    }
    last = res;
    onProgress(end / file.size);
  }
  const item = (await last?.json().catch(() => null)) as DriveItem | null;
  if (!item?.id || !item.eTag || !item.webUrl) throw new Error('Microsoft did not return the file properly.');
  const done = await finishUploadAction({ key, itemId: item.id, driveId: item.parentReference?.driveId ?? null, etag: item.eTag, webUrl: item.webUrl, name: item.name ?? file.name, memberEmails });
  if (!done.ok) throw new Error(done.message);
  return { ...done.data, size: file.size };
}
